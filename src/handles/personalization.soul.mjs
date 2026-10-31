/**
 * 把手 · personalization.soul（人设设定 / SOUL.md）
 * ---------------------------------------------------------------
 * P0 竖切用的第一个把手：走完六步，把验证器接上。
 *
 * 依据 docs/handles.md：用户目录、零提权、升级存活、请求**尾段**通道。
 *
 * ⚠️ 内置硬约束（见 docs/recon-amendments.md 新增约束 1）：
 *   注入前逐文件截断到 10 000 字符，**超出部分静默丢弃**。
 *   证据：authority-snapshot.js:53 `Ls=1e4` + :184 `truncateContent(l[0],Ls)`。
 *
 * ⚠️ 模式条件（见 docs/recon-amendments.md 新增约束 2）：
 *   SOUL.md 在普通模式与专家模式下**都**注入；IDENTITY.md 在专家模式下不注入。
 */

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../core/backup.mjs';
import { estimateTokens, estimateCost } from '../core/tokens.mjs';
import { diffLines, renderDiff } from '../core/diff.mjs';
import { evaluateTokenDelta } from '../verify/token-delta.mjs';

/** 身份文件注入上限（字符）。证据：authority-snapshot.js:53 `Ls=1e4` */
export const MAX_CHARS = 10000;

/** 按注入上限截断（与 WorkBuddy 行为一致：多余部分被丢弃，只在尾部留 marker） */
export function truncateToInjectionLimit(text) {
  if (typeof text !== 'string') return { text: '', truncated: false, dropped: 0 };
  if (text.length <= MAX_CHARS) return { text, truncated: false, dropped: 0 };
  return { text: text.slice(0, MAX_CHARS), truncated: true, dropped: text.length - MAX_CHARS };
}

export const soulHandle = {
  id: 'personalization.soul',
  title: '人设设定（SOUL.md）',

  /** 锚点表中的键 —— 运行时探测，不写死路径 */
  target: 'personal.soul',
  writeClass: 'user-data',     // 用户目录：自由写（须有备份）
  privilege: 'none',
  channel: 'request-tail',     // user-context 尾段
  upgradeBehavior: 'survives', // 用户数据目录，升级不清洗
  gate: 'new-session-required',

  /** 验证声明（名词）—— 与下面的 verify() 动词方法不同名 */
  verification: {
    strategy: 'token-delta',
    channel: 'request-tail',
    baseline: '改动前当次会话的 prompt_tokens（单变量对照，基线必须新鲜）',
    assertion: `prompt_tokens 增量落在**截断后**理论增量的 ±30% 内；增量≈0 判为未生效。注：内容超过 ${MAX_CHARS} 字符时按 ${MAX_CHARS} 计算期望值`,
  },

  /** 模式可达性（供界面与文档呈现，不参与判定） */
  modeAvailability: {
    normal: true,
    expert: true,
    note: 'SOUL.md 两种模式均注入；对比：IDENTITY.md 在专家模式下不注入',
  },

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
      /** 静默截断是真实风险：文件楔了 ≠ 模型看到了 */
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
        + `（WorkBuddy 静默截断）。期望增量按 ${MAX_CHARS} 字符计算。`,
      );
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
  async apply(ctx, { next = '' } = {}) {
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
        `当前 SOUL.md 超限：${state.limits.chars} 字符，仅前 ${MAX_CHARS} 会注入。`
        + '若实测 Δ 小于预期，先排除截断，再怀疑通道。',
      );
    }

    return {
      ...result,
      handle: this.id,
      currentBytes: state.bytes,
      currentTokens: state.tokens.tokens,
      limits: state.limits,
      warnings,
      hint: 'P0b 将接入真实会话基线采集；在此之前 verdict 恒为 undetermined —— 这是如实报告，不是失败',
    };
  },

  // ── 6. 还原由 engine 按 manifest 执行（见 core/backup.mjs）──
};

export default soulHandle;
