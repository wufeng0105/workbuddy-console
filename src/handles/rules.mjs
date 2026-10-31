/**
 * 把手 · 规则矩阵（`settings.json → sandbox.orderedRules`）
 * ---------------------------------------------------------------
 * 三条规则域（file / command / network），每条 = 路径 + read/write/delete 三动作，
 * 各可 `allow` / `ask` / `deny`。**路径粒度就是白名单/黑名单能力。**
 *
 * 这是"越界审批自动同意"的**规则面**（提示词面已由 prompt.* 把手覆盖）。
 *
 * 验证策略 = `readback-after-restart`：
 *   写完读回证明不了任何事（刚写的就是那份）。必须**重启后再读**，
 *   才能排除"启动时被重置"——`extraAllowWrite` 就是这么栽的（recon-amendments 修正 3）。
 *
 * 写入方式 = **批量改动作**（不是整块 JSON 编辑）：
 *   135 条规则整块编辑，写错一个逗号就毁全部；按"把 ask 提升为 allow"才是真实意图，
 *   而且 diff 天然可读、期望效果可数。
 */

import fs from 'node:fs';
import { sha256 } from '../core/backup.mjs';
import { diffLines, renderDiff } from '../core/diff.mjs';
import { ConsoleError } from '../core/errors.mjs';
import { readRules, summarize, promoteRules, writeDomainRules } from '../core/rules.mjs';
import { recordAfterWrite, evaluateReadback } from '../verify/readback.mjs';

/**
 * @param {{domain:'file'|'command'|'network', id:string, title:string}} p
 */
export function createRuleDomainHandle({ domain, id, title }) {
  const settingsAnchor = 'config.settings';

  /** @param {any} ctx */
  function load(ctx) {
    const r = readRules(ctx, domain);
    if (!r.ok) {
      throw new ConsoleError('RULE_DOMAIN_MISSING', `规则域 ${domain} 不可读：${r.reason}`, { domain });
    }
    return r;
  }

  /** 校验"下一步规则"的输入 */
  function normalizeOp(next) {
    if (!next || typeof next !== 'object') {
      throw new ConsoleError('INVALID_VALUE', '需要 { from, to, actions?, paths? } 形式的操作描述');
    }
    const { from, to, actions, paths } = next;
    if (!['allow', 'ask', 'deny'].includes(from) || !['allow', 'ask', 'deny'].includes(to)) {
      throw new ConsoleError('INVALID_VALUE', `动作必须是 allow/ask/deny，收到 ${from} → ${to}`);
    }
    const acts = Array.isArray(actions) && actions.length ? actions : ['read', 'write', 'delete'];
    for (const a of acts) {
      if (!['read', 'write', 'delete'].includes(a)) {
        throw new ConsoleError('INVALID_VALUE', `动作维度必须是 read/write/delete，收到 ${a}`);
      }
    }
    // paths 必须一起带上 —— 否则"只改某几个路径"会退化成"全量改"
    if (paths !== undefined) {
      if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) {
        throw new ConsoleError('INVALID_VALUE', 'paths 必须是字符串数组');
      }
    }
    return { from, to, actions: acts, ...(Array.isArray(paths) && paths.length ? { paths } : {}) };
  }

  return {
    id,
    title,
    target: settingsAnchor,
    writeClass: 'user-data',
    privilege: 'none',
    channel: 'rule-matrix',
    upgradeBehavior: 'survives',
    gate: 'app-must-be-closed', // 规则由启动时装配；改完必须重启才生效

    verification: {
      strategy: 'readback-after-restart',
      channel: 'rule-matrix',
      baseline: '写入后的规则快照（指纹）',
      assertion: '重启 WorkBuddy 后再读一次：指纹一致 → 生效；被还原 → 未生效（extraAllowWrite 那类坑）',
    },

    /** 该把手接受结构化操作（不是纯文本） */
    inputKind: 'rule-op',
    domain,

    // ── 1. 探测 ────────────────────────────────────────────────
    async probe(ctx) {
      const r = load(ctx);
      const anchor = ctx.resolveOptional(settingsAnchor);
      const text = anchor?.exists ? fs.readFileSync(anchor.path, 'utf8') : '';
      return {
        path: anchor?.path ?? null,
        exists: Boolean(anchor?.exists),
        text,
        bytes: Buffer.byteLength(text, 'utf8'),
        sha256: text ? sha256(Buffer.from(text, 'utf8')) : null,
        token: { tokens: null, chars: text.length, cjk: 0, other: text.length },
        domain,
        presetVersion: r.presetVersion,
        customized: r.customized,
        ruleCount: r.rules.length,
        summary: summarize(r.rules),
        /** 供界面直接展示的"可放宽项" */
        pending: {
          writeAsk: r.rules.filter((x) => x.write === 'ask').length,
          deleteAsk: r.rules.filter((x) => x.delete === 'ask').length,
          readAsk: r.rules.filter((x) => x.read === 'ask').length,
        },
        rules: r.rules,
      };
    },

    // ── 2. 差异预览 ────────────────────────────────────────────
    async preview(ctx, { next } = {}) {
      const op = normalizeOp(next);
      const cur = load(ctx);
      const promoted = promoteRules(cur.rules, op);
      const warnings = [];

      if (promoted.changed === 0) {
        warnings.push(`没有规则命中（当前没有 ${op.actions.join('/')} = ${op.from} 且匹配的条目）。`);
      }
      if (op.to === 'allow' && op.from === 'ask') {
        warnings.push(
          '放宽后 WorkBuddy 不再为这些路径弹审批。'
          + '**删除类操作也会一起放开**——若只想放开读/写，请把 actions 限定为 ["read","write"]。',
        );
      }

      const w = writeDomainRules(cur.text, domain, promoted.rules);
      const afterText = typeof w === 'string' ? w : w.text;
      const diff = diffLines(cur.text, afterText);

      return {
        path: cur.path,
        willCreate: false,
        diff,
        diffText: summarizeDiff(promoted),
        cost: { before: 0, after: 0, delta: 0, cacheNote: '规则矩阵不进提示词，无缓存代价。' },
        expectedDeltaTokens: null,
        injectedChars: null,
        truncated: false,
        dropped: 0,
        warnings,
        changed: promoted.changed,
        changedPaths: promoted.changedPaths.slice(0, 40),
        bytesDelta: Buffer.byteLength(afterText, 'utf8') - Buffer.byteLength(cur.text, 'utf8'),
        op,
      };
    },

    // ── 4. 写入 ────────────────────────────────────────────────
    async apply(ctx, { next } = {}) {
      const op = normalizeOp(next);
      const cur = load(ctx);
      const promoted = promoteRules(cur.rules, op);
      if (promoted.changed === 0) {
        throw new ConsoleError('NO_RULES_MATCHED', `没有规则命中，未做任何修改`, { op, domain });
      }
      const w = writeDomainRules(cur.text, domain, promoted.rules);
      const afterText = typeof w === 'string' ? w : w.text;
      fs.writeFileSync(cur.path, afterText, 'utf8');

      // 登记"写入后的期望快照"，供重启后回读比对
      recordAfterWrite({
        storeRoot: ctx.storeRoot,
        key: this.id,
        snapshot: promoted.rules,
        meta: { domain, op, changed: promoted.changed, path: cur.path },
      });

      return {
        path: cur.path,
        bytes: Buffer.byteLength(afterText, 'utf8'),
        writeMode: typeof w === 'string' ? 'targeted' : w.mode,
        changed: promoted.changed,
        changedPaths: promoted.changedPaths.slice(0, 40),
        /** 提示必须重启 */
        restartRequired: true,
      };
    },

    // ── 5. 验证（重启后回读）────────────────────────────────────
    async verify(ctx, args = {}) {
      const cur = load(ctx);
      const r = evaluateReadback({
        storeRoot: ctx.storeRoot,
        key: this.id,
        current: cur.rules,
        restarted: args.restarted === true,
      });
      const warnings = [];

      if (r.verdict === 'ineffective') {
        warnings.push(
          '被还原了 —— 可能原因：① WorkBuddy 启动时用预设覆盖了本地规则（`ensureOrderedRules` / 托管策略）；'
          + '② 有 managed 策略下发（`toManagedOrderedRules`）。'
          + '这条不是"没写进去"，而是"写进去又被抹掉了"，正是 extraAllowWrite 那类坑。',
        );
      }
      if (r.verdict === 'undetermined' && r.stage === 'after-write') {
        warnings.push('下一步：退出 WorkBuddy → 重新启动 → 再运行一次 verify（带 restarted 参数）。');
      }

      return {
        ...r,
        handle: this.id,
        domain,
        ruleCount: cur.rules.length,
        summary: summarize(cur.rules),
        warnings,
      };
    },
  };
}

/** 给界面看的可读 diff（规则矩阵逐行 JSON diff 太长） */
function summarizeDiff(promoted) {
  if (promoted.changed === 0) return '（没有规则命中，无变化）';
  const head = promoted.changedPaths.slice(0, 20);
  const more = promoted.changedPaths.length > head.length ? `\n  …另有 ${promoted.changedPaths.length - head.length} 条` : '';
  return `将修改 ${promoted.changed} 条规则：\n${head.map((p) => `  ${p}`).join('\n')}${more}`;
}
