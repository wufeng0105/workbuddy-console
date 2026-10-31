/**
 * 把手工厂 · style 档位内容（`style-<id>.md`，安装目录）
 * ---------------------------------------------------------------
 * 这是本项目第一个真正的**厂商文件**把手：
 *   - 位置：`C:\Program Files\WorkBuddy\...\templates\style\`
 *   - `writeClass: 'vendor-file'` → 逐次确认（铁律 5）
 *   - `privilege: 'elevated'` → 非管理员环境下会失败（探针如实报告可写性）
 *   - `upgradeBehavior: 'invalidated'` → **升级疑失效**（待实测 #6，`phase0-recon.md` 记"未复现"）
 *
 * ⚠️ 一条容易踩的静默失败：**编辑非当前生效的档位，等于什么都没做**。
 *   `toneStyle` 只决定读哪一个 style 文件；改别的文件不影响任何请求。
 *   所以 preview 会显著告警，verify 直接判 `undetermined`（前置条件不成立），
 *   **绝不**因为"实测 Δ=0"就报"未生效"。
 */

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../core/backup.mjs';
import { estimateTokens, estimateCost } from '../core/tokens.mjs';
import { diffLines, renderDiff } from '../core/diff.mjs';
import { evaluateTokenDelta } from '../verify/token-delta.mjs';
import { AnchorMissingError, ConsoleError } from '../core/errors.mjs';
import { readActiveToneStyle } from '../core/appconfig.mjs';

const STYLE_DIR_ANCHOR = 'templates.style';

/**
 * @param {{styleId:string, title:string}} p
 */
export function createStyleContentHandle({ styleId, title }) {
  const fileName = `style-${styleId}.md`;

  /** @param {any} ctx */
  function targetOf(ctx) {
    const dir = ctx.resolveOptional?.(STYLE_DIR_ANCHOR);
    if (!dir) {
      throw new AnchorMissingError(
        `安装目录锚点未命中（${STYLE_DIR_ANCHOR}）—— 无法定位 ${fileName}`,
        { anchor: STYLE_DIR_ANCHOR, hint: '可用 WORKBUDDY_CONSOLE_INSTALL_DIR 指定安装根' },
      );
    }
    const p = path.join(dir.path, fileName);
    return { key: `${STYLE_DIR_ANCHOR}/${fileName}`, path: p, exists: fs.existsSync(p) };
  }

  return {
    id: `style.${styleId}`,
    title,
    /** 静态回退锚点（真正定位走 resolveTarget） */
    target: STYLE_DIR_ANCHOR,
    writeClass: 'vendor-file',
    privilege: 'elevated',
    channel: 'request-tail',
    upgradeBehavior: 'invalidated',
    gate: 'new-session-required',

    verification: {
      strategy: 'token-delta',
      channel: 'request-tail',
      baseline: '改动前最后一次会话的**首条**聊天请求 prompt_tokens',
      assertion: '**仅当该档位为当前生效档位时**可验证：增量 ≈ 新旧内容 token 差（±30%）。否则前置条件不成立，判「无法判定」。',
    },

    /** 契约补充：目标随 id 变，静态锚点表达不了 */
    resolveTarget: targetOf,

    // ── 1. 探测 ────────────────────────────────────────────────
    async probe(ctx) {
      const t = targetOf(ctx);
      const exists = t.exists;
      const text = exists ? fs.readFileSync(t.path, 'utf8') : '';
      let writeAccess = false;
      if (exists) {
        try { fs.accessSync(t.path, fs.constants.W_OK); writeAccess = true; } catch { writeAccess = false; }
      }
      const active = readActiveToneStyle(ctx);
      return {
        path: t.path,
        exists,
        text,
        bytes: Buffer.byteLength(text, 'utf8'),
        sha256: exists ? sha256(Buffer.from(text, 'utf8')) : null,
        tokens: estimateTokens(text),
        styleId,
        activeStyle: active,
        isActive: active === styleId,
        writeAccess,
        privilegeNote: writeAccess ? '当前进程可写' : '当前进程**不可写**（需管理员权限）',
      };
    },

    // ── 2. 差异预览 ────────────────────────────────────────────
    async preview(ctx, { next = '' } = {}) {
      const st = await this.probe(ctx);
      const diff = diffLines(st.text, next);
      const warnings = [];

      if (!st.isActive) {
        warnings.push(
          `该档位**当前未生效**（生效档位是 ${st.activeStyle ?? '未知'}）——`
          + `改这个文件不会影响任何请求。要让改动生效，先把回复风格切到「${styleId}」。`,
        );
      }
      if (!st.writeAccess) {
        warnings.push('当前进程对该文件**不可写**：写入会失败（需管理员权限）。');
      }

      const expectedDeltaTokens = st.isActive
        ? estimateTokens(next).tokens - st.tokens.tokens
        : 0;

      return {
        path: st.path,
        willCreate: !st.exists,
        diff,
        diffText: renderDiff(diff),
        cost: estimateCost({ before: st.text, after: next }),
        expectedDeltaTokens,
        injectedChars: next.length,
        truncated: false,
        dropped: 0,
        warnings,
        bytesDelta: Buffer.byteLength(next, 'utf8') - st.bytes,
        isActive: st.isActive,
        writeAccess: st.writeAccess,
      };
    },

    // ── 4. 写入 ────────────────────────────────────────────────
    async apply(ctx, { next = '' } = {}) {
      const st = await this.probe(ctx);
      if (!st.exists) {
        throw new ConsoleError('STYLE_FILE_MISSING', `style 文件不存在：${st.path}`, { path: st.path });
      }
      if (!st.writeAccess) {
        throw new ConsoleError(
          'WRITE_ACCESS_DENIED',
          `当前进程不可写：${st.path} —— 需要管理员权限（安装目录）`,
          { path: st.path, privilege: 'elevated' },
        );
      }
      fs.writeFileSync(st.path, next, 'utf8');
      return {
        path: st.path,
        bytes: Buffer.byteLength(next, 'utf8'),
        writeMode: 'replace',
        isActive: st.isActive,
        /** 升级后本文件可能被整体替换 → 需要重放（演进契约） */
        upgradeNote: '该文件在安装目录：WorkBuddy 升级可能整体替换它，届时需重放。',
      };
    },

    // ── 5. 验证 ────────────────────────────────────────────────
    async verify(ctx, args = {}) {
      const st = await this.probe(ctx);

      // 前置条件：只有生效档位的改动才可能进入请求
      if (!st.isActive) {
        return {
          verdict: 'undetermined',
          reason: `该档位**当前未生效**（生效档位：${st.activeStyle ?? '未知'}）—— 改动不会进入请求，`
            + `无法验证。先把回复风格切到「${styleId}」，再验证。`,
          handle: this.id,
          isActive: false,
          activeStyle: st.activeStyle,
          warnings: ['前置条件不成立：这不是"未生效"，是"根本没参与"。'],
        };
      }

      const result = evaluateTokenDelta({
        baselineTokens: args.baselineTokens,
        observedTokens: args.observedTokens,
        expectedDelta: Number.isFinite(args.expectedDelta) ? args.expectedDelta : undefined,
      });
      const warnings = [];
      if (!st.writeAccess) warnings.push('当前进程对该文件不可写：改动可能根本没落盘。');
      return {
        ...result,
        handle: this.id,
        isActive: true,
        activeStyle: st.activeStyle,
        writeAccess: st.writeAccess,
        warnings,
      };
    },
  };
}
