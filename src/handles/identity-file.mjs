/**
 * 把手工厂 · 身份文件（SOUL.md / USER.md / IDENTITY.md）
 * ---------------------------------------------------------------
 * 三者同构：用户目录、零提权、升级存活、请求**尾段**通道、注入上限 10 000 字符。
 * 差异只有三处：锚点键、标题、**模式可达性**。
 *
 * ⚠️ 注入上限（见 docs/recon-amendments.md 新增约束 1）：
 *   注入前逐文件截断到 10 000 字符，**超出部分静默丢弃**。
 *   证据：authority-snapshot.js:53 `Ls=1e4` + :184 `truncateContent(l, Ls)`。
 *
 * ⚠️ 模式可达性（见 docs/recon-amendments.md 新增约束 2）：
 *   `IDENTITY.md` 在**专家模式下不注入**（`authority-snapshot.js:184` `t.isExpert || …`）；
 *   `SOUL.md` / `USER.md` 两种模式均注入。
 */

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../core/backup.mjs';
import { estimateTokens, estimateCost } from '../core/tokens.mjs';
import { diffLines, renderDiff } from '../core/diff.mjs';
import { ConsoleError } from '../core/errors.mjs';
import { evaluateTokenDelta } from '../verify/token-delta.mjs';

/** 身份文件注入上限（字符）。证据：authority-snapshot.js:53 `Ls=1e4` */
export const MAX_CHARS = 10000;

/** 按注入上限截断（与 WorkBuddy 行为一致：多余部分被丢弃，只在尾部留 marker） */
export function truncateToInjectionLimit(text) {
  if (typeof text !== 'string') return { text: '', truncated: false, dropped: 0 };
  if (text.length <= MAX_CHARS) return { text, truncated: false, dropped: 0 };
  return { text: text.slice(0, MAX_CHARS), truncated: true, dropped: text.length - MAX_CHARS };
}

/**
 * @param {{id:string, title:string, anchorKey:string, modeAvailability:{normal:boolean,expert:boolean,note:string}}} p
 */
export function createIdentityFileHandle({ id, title, anchorKey, modeAvailability }) {
  return {
    id,
    title,

    /** 锚点表中的键 —— 运行时探测，不写死路径 */
    target: anchorKey,
    writeClass: 'user-data',     // 用户目录：自由写（须有备份）
    /**
     * 声明"next 就是整个文件的内容"。
     * 引擎据此判断能否用"现存文本 vs next"做 noop 预判；
     * 不声明则按结构化写入处理（写完再比）。见 engine.apply 的 D4 注释。
     */
    writesWholeFile: true,
    privilege: 'none',
    channel: 'request-tail',     // user-context 尾段
    upgradeBehavior: 'survives', // 用户数据目录，升级不清洗
    gate: 'new-session-required',

    /** 验证声明（名词）—— 与下面的 verify() 动词方法不同名 */
    verification: {
      strategy: 'token-delta',
      channel: 'request-tail',
      baseline: '改动前最后一次会话的**首条**聊天请求 prompt_tokens（单变量对照，基线必须新鲜）',
      assertion: `prompt_tokens 增量落在**截断后**理论增量的 ±30% 内；增量≈0 判为未生效。注：内容超过 ${MAX_CHARS} 字符时按 ${MAX_CHARS} 计算期望值`,
    },

    /** 模式可达性（供界面与文档呈现，不参与判定） */
    modeAvailability,

    // ── 1. 探测 ────────────────────────────────────────────────
    async probe(ctx) {
      const { path: abs } = ctx.resolve(this.target);
      const exists = fs.existsSync(abs);
      const text = exists ? fs.readFileSync(abs, 'utf8') : '';
      const clipped = truncateToInjectionLimit(text);
      return {
        path: abs,
        exists,
        text,
        bytes: Buffer.byteLength(text, 'utf8'),
        sha256: exists ? sha256(Buffer.from(text, 'utf8')) : null,
        tokens: estimateTokens(text),
        /** 静默截断是真实风险：文件写了 ≠ 模型看到了 */
        limits: {
          maxChars: MAX_CHARS,
          chars: text.length,
          exceeded: clipped.truncated,
          dropped: clipped.dropped,
          injectedTokens: estimateTokens(clipped.text).tokens,
          evidence: 'authority-snapshot.js:53 Ls=1e4 + :184 truncateContent',
        },
      };
    },

    // ── 2. 差异预览 ────────────────────────────────────────────
    async preview(ctx, { next = '' } = {}) {
      const state = await this.probe(ctx);
      const diff = diffLines(state.text, next);
      const cost = estimateCost({ before: state.text, after: next });

      const clipped = truncateToInjectionLimit(next);
      const warnings = [];
      if (clipped.truncated) {
        warnings.push(
          `内容 ${next.length} 字符，超出注入上限 ${MAX_CHARS}：**最后 ${clipped.dropped} 字符不会被模型看到**`
          + '（WorkBuddy 静默截断）。期望增量按上限计算。',
        );
      }
      if (modeAvailability.expert === false) {
        warnings.push('该把手在**专家模式下不注入** —— 若当前用专家档位，改动不会出现在请求里。');
      }

      return {
        path: state.path,
        willCreate: !state.exists,
        diff,
        diffText: renderDiff(diff),
        cost,
        // 期望增量按**截断后**文本估算 —— 否则会给出偏大的期望值，误导验证
        expectedDeltaTokens: estimateTokens(clipped.text).tokens - state.tokens.tokens,
        injectedChars: clipped.text.length,
        truncated: clipped.truncated,
        dropped: clipped.dropped,
        warnings,
        bytesDelta: Buffer.byteLength(next, 'utf8') - state.bytes,
      };
    },

    // ── 4. 写入（备份由 engine 在调用前完成，铁律 1）────────────
    async apply(ctx, { next } = {}) {
      /**
       * 与引擎那道 CRITICAL 防线对齐（F1 的把手层）。
       *
       * 引擎已经拦住 `next === undefined`，但工厂这里曾有 `{ next = '' }` 默认值：
       * 一旦有人绕过引擎直调把手（或以后新增的调用点忘了传），"漏参数"会再次
       * 变成"把整个身份文件写成空"。默认值就是缺陷本身，删掉它并显式拒绝。
       */
      if (next === undefined) {
        throw new ConsoleError('INPUT_MISSING', `未提供写入内容（next）—— 拒绝把 ${this.title} 写成空。`);
      }
      const { path: abs } = ctx.resolve(this.target);
      const clipped = truncateToInjectionLimit(next);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, next, 'utf8');
      return {
        path: abs,
        bytes: Buffer.byteLength(next, 'utf8'),
        /** 写入的是全文（与 WorkBuddy 的 UI 行为一致）；截断发生在注入时，不在这里 */
        injectedChars: clipped.text.length,
        truncationWarning: clipped.truncated
          ? `写入成功，但只有前 ${MAX_CHARS} 字符会进入模型（丢弃 ${clipped.dropped} 字符）`
          : null,
      };
    },

    // ── 5. 验证（三态，禁止假装成功）────────────────────────────
    async verify(ctx, args = {}) {
      const state = await this.probe(ctx);

      // 期望增量必须按**截断后**文本算
      const expectedDelta = Number.isFinite(args.expectedDelta)
        ? args.expectedDelta
        : (typeof args.expectedText === 'string'
          ? estimateTokens(truncateToInjectionLimit(args.expectedText).text).tokens
          : undefined);

      const result = evaluateTokenDelta({
        baselineTokens: args.baselineTokens,
        observedTokens: args.observedTokens,
        expectedDelta,
      });

      const warnings = [];
      if (state.limits.exceeded) {
        warnings.push(
          `当前内容超限：${state.limits.chars} 字符，仅前 ${MAX_CHARS} 会注入。`
          + '若实测 Δ 小于预期，先排除截断，再怀疑通道。',
        );
      }
      if (result.verdict === 'ineffective' && modeAvailability.expert === false) {
        warnings.push('该把手在专家模式下不注入 —— 若观测会话用的是专家档位，"未生效"属预期，不是故障。');
      }

      return {
        ...result,
        handle: this.id,
        currentBytes: state.bytes,
        currentTokens: state.tokens.tokens,
        limits: state.limits,
        warnings,
      };
    },

    // ── 6. 还原由 engine 按 manifest 执行（见 core/backup.mjs）──
  };
}
