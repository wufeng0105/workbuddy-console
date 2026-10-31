/**
 * 规则矩阵操作 —— `settings.json → sandbox.orderedRules`
 * ---------------------------------------------------------------
 * 一条规则 = `{ id, source, path, isDirectory, read, write, delete }`，三个动作各可
 * `allow` / `ask` / `deny`。**路径粒度就是"白名单/黑名单"能力**，不需要另造概念。
 *
 * 为什么不做成"编辑整块 JSON"的把手：
 *   135 条规则整块编辑，人写错一个逗号就毁掉全部规则，而 `restore` 只能事后补救。
 *   按**批量改动作**（如"把 49 条 write=ask 提升为 allow"）才是用户真实意图，
 *   也让 diff 天然可读。
 *
 * ⚠️ 与 `extraAllowWrite` 的教训对齐（docs/recon-amendments.md 修正 3）：
 *   那个键启动时会被**强制重置**。`orderedRules` 是否也会被覆盖**尚未实测**（待实测 #1）。
 *   因此本把手的验证策略是 **readback-after-restart**：
 *   写完只读回不够 —— 必须**重启后再读一遍**，才能证明它没被启动逻辑抹掉。
 */

import fs from 'node:fs';
import { sha256 } from '../core/backup.mjs';
import { diffLines, renderDiff } from '../core/diff.mjs';
import { ConsoleError } from '../core/errors.mjs';
import { writeField, readField } from '../handles/json-field.mjs';

export const RULE_DOMAINS = Object.freeze(['file', 'command', 'network']);
export const RULE_ACTIONS = Object.freeze(['allow', 'ask', 'deny']);

/** 一个域的规则快照 */
export function readRules(ctx, domain) {
  const anchor = ctx.resolveOptional?.('config.settings');
  if (!anchor || !anchor.exists) return { ok: false, reason: 'settings.json 不存在' };
  let text;
  try { text = fs.readFileSync(anchor.path, 'utf8'); } catch (e) {
    return { ok: false, reason: `settings.json 无法读取：${e.message}` };
  }
  let j;
  try { j = JSON.parse(text); } catch (e) {
    return { ok: false, reason: `settings.json 无法解析：${e.message}` };
  }
  const d = j?.sandbox?.orderedRules?.[domain];
  if (!d || !Array.isArray(d.rules)) return { ok: false, reason: `域 ${domain} 不存在或没有 rules 数组` };
  return {
    ok: true,
    path: anchor.path,
    /** ⚠️ 带着原始文本：写入时要"最小改动"，必须基于原文而不是重新序列化 */
    text,
    domain,
    presetVersion: d.presetVersion,
    customized: d.customized,
    rules: d.rules,
  };
}

/** 统计某域的动作分布 */
export function summarize(rules) {
  const out = { total: rules.length, read: {}, write: {}, delete: {} };
  for (const r of rules) {
    for (const k of ['read', 'write', 'delete']) {
      const v = r[k] ?? '(未设)';
      out[k][v] = (out[k][v] ?? 0) + 1;
    }
  }
  return out;
}

/**
 * 批量改动作（纯函数，便于测试）。
 * @param {Array} rules
 * @param {{from:'ask'|'allow'|'deny', to:'ask'|'allow'|'deny', actions?:('read'|'write'|'delete')[], paths?:string[]}} p
 * @returns {{rules:Array, changed:number, changedPaths:string[]}}
 */
export function promoteRules(rules, { from, to, actions = ['read', 'write', 'delete'], paths } = {}) {
  if (!RULE_ACTIONS.includes(from) || !RULE_ACTIONS.includes(to)) {
    throw new ConsoleError('INVALID_VALUE', `动作必须是 ${RULE_ACTIONS.join('/')}，收到 ${from} → ${to}`);
  }
  if (from === to) throw new ConsoleError('INVALID_VALUE', 'from 与 to 相同，无意义');
  const wantPaths = Array.isArray(paths) && paths.length ? new Set(paths) : null;

  let changed = 0;
  const changedPaths = [];
  const next = rules.map((r) => {
    if (wantPaths && !wantPaths.has(r.path)) return r;
    const nr = { ...r };
    let touched = false;
    for (const a of actions) {
      if (nr[a] === from) { nr[a] = to; touched = true; }
    }
    if (touched) { changed += 1; changedPaths.push(r.path); }
    return touched ? nr : r;
  });
  return { rules: next, changed, changedPaths };
}

/**
 * 写入某域的规则数组（最小改动：定点替换该域的 rules 块）。
 * @param {string} settingsText
 * @param {string} domain
 * @param {Array} rules
 */
export function writeDomainRules(settingsText, domain, rules) {
  if (typeof settingsText !== 'string' || !settingsText.trim()) {
    throw new ConsoleError('SETTINGS_INVALID', 'settings.json 内容为空，拒绝写入');
  }
  let parsed;
  try { parsed = JSON.parse(settingsText); } catch (e) {
    throw new ConsoleError('SETTINGS_INVALID', `settings.json 无法解析：${e.message}`);
  }
  const dom = parsed?.sandbox?.orderedRules?.[domain];
  if (!dom) throw new ConsoleError('RULE_DOMAIN_MISSING', `域 ${domain} 不存在`);

  // 标记为已定制 —— 与 WorkBuddy 自己的语义一致（customized 字段就是干这个的）
  const nextDom = { ...dom, rules, customized: true };
  const nextSandboxOrdered = { ...parsed.sandbox.orderedRules, [domain]: nextDom };
  const nextSandbox = { ...parsed.sandbox, orderedRules: nextSandboxOrdered };
  const next = { ...parsed, sandbox: nextSandbox };

  const normalized = settingsText.replace(/\r\n/g, '\n');
  if (JSON.stringify(parsed, null, 2) === normalized.trimEnd()) {
    return {
      text: `${JSON.stringify(next, null, 2)}${normalized.endsWith('\n') ? '\n' : ''}`,
      mode: 'reserialize',
    };
  }

  // 非规范格式：定点替换该域的 rules 数组，其余字节不动
  const domRe = new RegExp(`"${domain}"\\s*:\\s*\\{`);
  const dm = domRe.exec(settingsText);
  if (!dm) throw new ConsoleError('SETTINGS_UNWRITABLE', `无法在保留原格式的前提下定位 ${domain}`);
  const braceIdx = settingsText.indexOf('{', dm.index);
  const span = findObjectSpan(settingsText, braceIdx);
  if (!span) throw new ConsoleError('SETTINGS_UNWRITABLE', '无法定位域对象范围');

  const inner = settingsText.slice(span.start + 1, span.end - 1);
  const rulesRe = /("rules"\s*:\s*)\[[\s\S]*?\]/;
  const rm = rulesRe.exec(inner);
  const rulesJson = JSON.stringify(rules);
  const newInner = rm
    ? inner.slice(0, rm.index) + rm[1] + rulesJson + inner.slice(rm.index + rm[0].length)
    : `${inner.replace(/\s+$/, '')},\n  "rules": ${rulesJson}\n`;

  // 顺带把 customized 也叫醒（若存在该字段）
  const withCustomized = /"customized"\s*:\s*(true|false)/.test(newInner)
    ? newInner.replace(/("customized"\s*:\s*)(true|false)/, '$1true')
    : newInner;

  return {
    text: settingsText.slice(0, span.start + 1) + withCustomized + settingsText.slice(span.end - 1),
    mode: 'targeted',
  };
}

/** 与 json-field.mjs 同款花括号配对（跳过字符串） */
function findObjectSpan(text, openIdx) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = openIdx; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return { start: openIdx, end: i + 1 };
    }
  }
  return null;
}

export { sha256, diffLines, renderDiff, readField, writeField };
