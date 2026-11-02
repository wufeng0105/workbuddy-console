/**
 * 把手工厂 · JSON 字段（`app-config.json → personalization.toneStyle` / `.customPrompt`）
 * ---------------------------------------------------------------
 * 与身份文件的差异：目标是**一个 JSON 字段**，不是整个文件。
 * 因此写入必须**最小改动**：能无损重序列化就重序列化，否则做定向替换，绝不整篇重排。
 *
 * 一个必须拦下的静默失败：
 *   `toneStyle` 的 collector 对**非法枚举**会静默返回空串
 *   （`authority-snapshot.js` `resolveToneStyle` → `Us.has(t) ? t : ''`），
 *   于是"写成功了、风格却消失了"。本工厂对声明了 `allowedValues` 的字段**直接拒绝**非法值。
 */

import fs from 'node:fs';
import { sha256 } from '../core/backup.mjs';
import { estimateTokens, estimateCost } from '../core/tokens.mjs';
import { diffLines, renderDiff } from '../core/diff.mjs';
import { evaluateTokenDelta } from '../verify/token-delta.mjs';
import { InvalidValueError } from '../core/errors.mjs';
import { writeFileAtomic } from '../core/atomic-write.mjs';

/** @param {string} s */
function escapeRx(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 取 idx 所在行的前导缩进 */
function detectIndent(text, idx) {
  const lineStart = text.lastIndexOf('\n', idx - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(lineStart, idx));
  return m ? m[0] : '';
}

/** 从 openIdx 的 `{` 起做花括号配对（跳过字符串） */
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

/** 读取字段值（解析失败返回 undefined） */
export function readField(text, containerKey, fieldKey) {
  try {
    const obj = JSON.parse(text);
    const v = obj?.[containerKey]?.[fieldKey];
    return v === undefined ? undefined : v;
  } catch { return undefined; }
}

/**
 * 写入字段，**尽量保留原文件其余字节**。
 * @returns {{text:string, mode:'reserialize'|'targeted'|'inserted'} | null} null = 无法安全写入
 */
export function writeField(text, containerKey, fieldKey, value) {
  const literal = JSON.stringify(value);

  // 路径 1：文件本就是规范 2 空格 JSON → 重序列化后除该值外逐字不变
  try {
    const parsed = JSON.parse(text);
    const normalized = text.replace(/\r\n/g, '\n');
    if (JSON.stringify(parsed, null, 2) === normalized.trimEnd()) {
      const next = { ...parsed };
      const cur = next[containerKey];
      const container = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? { ...cur } : {};
      container[fieldKey] = value;
      next[containerKey] = container;
      return {
        text: `${JSON.stringify(next, null, 2)}${normalized.endsWith('\n') ? '\n' : ''}`,
        mode: 'reserialize',
      };
    }
  } catch { /* 非规范 JSON，走定向路径 */ }

  // 路径 2：定向替换 / 插入
  const cm = new RegExp(`"${escapeRx(containerKey)}"\\s*:\\s*\\{`).exec(text);
  if (!cm) return null;
  const braceIdx = text.indexOf('{', cm.index);
  const span = findObjectSpan(text, braceIdx);
  if (!span) return null;

  const inner = text.slice(span.start + 1, span.end - 1);
  const valueRe = '("(?:[^"\\\\]|\\\\.)*"|null|true|false|-?\\d+(?:\\.\\d+)?)';
  const fre = new RegExp(`("${escapeRx(fieldKey)}"\\s*:\\s*)${valueRe}`);
  const fm = fre.exec(inner);
  if (fm) {
    const newInner = inner.slice(0, fm.index) + fm[1] + literal + inner.slice(fm.index + fm[0].length);
    return { text: text.slice(0, span.start + 1) + newInner + text.slice(span.end - 1), mode: 'targeted' };
  }

  const baseIndent = detectIndent(text, span.start);
  const innerIndent = `${baseIndent}  `;
  const trimmed = inner.replace(/\s+$/, '');
  const body = trimmed === ''
    ? `\n${innerIndent}"${fieldKey}": ${literal}\n${baseIndent}`
    : `${trimmed}${/,$/.test(trimmed) ? '' : ','}\n${innerIndent}"${fieldKey}": ${literal}\n${baseIndent}`;
  return { text: text.slice(0, span.start + 1) + body + text.slice(span.end - 1), mode: 'inserted' };
}

/**
 * @param {{
 *   id:string, title:string, anchorKey:string, containerKey:string, fieldKey:string,
 *   allowedValues?:string[], injectedContent?:(value:any, ctx:any)=>Promise<string|null>,
 *   normalize?:(value:any)=>any,
 *   extraWarnings?:(value:any, ctx:any)=>Promise<string[]>, assertionNote?:string
 * }} p
 */
export function createJsonFieldHandle({
  id,
  title,
  anchorKey,
  containerKey,
  fieldKey,
  allowedValues,
  injectedContent,
  normalize,
  extraWarnings,
  assertionNote,
}) {
  const pathLabel = `${containerKey}.${fieldKey}`;

  /**
   * 与 WorkBuddy 自身行为对齐地规范化取值。
   * 依据：collector 读档后先 `trim()` 再校验
   *   —— `resolveToneStyle(e){ let t=e.trim(); return Us.has(t) ? t : '' }`
   *   —— `resolveCustomPrompt(e){ return typeof e==='string' ? e.trim() : '' }`
   * 所以"带尾随换行的取值"在 App 里其实**有效**，工具侧不该误拒。
   * @param {any} v
   * @returns {{value:any, note:string|null}}
   */
  function normalizeValue(v) {
    if (!normalize) return { value: v, note: null };
    const nv = normalize(v);
    if (nv === v) return { value: nv, note: null };
    return {
      value: nv,
      note: `已按 WorkBuddy 的读取行为规范化取值：${JSON.stringify(v)} → ${JSON.stringify(nv)}`
        + '（collector 会 trim 后再校验，故这是对齐而非篡改）',
    };
  }

  /**
   * @param {any} value
   * @param {any} ctx
   * @returns {Promise<{text:string|null, note:string|null}>}
   */
  async function injected(value, ctx) {
    if (!injectedContent) return { text: typeof value === 'string' ? value : '', note: null };
    const t = await injectedContent(value, ctx);
    return t == null
      ? { text: null, note: `无法解析「${pathLabel} = ${JSON.stringify(value)}」真正进入请求的内容` }
      : { text: t, note: null };
  }

  return {
    id,
    title,
    target: anchorKey,
    writeClass: 'user-data',
    privilege: 'none',
    channel: 'request-tail',
    upgradeBehavior: 'survives',
    gate: 'new-session-required',

    verification: {
      strategy: 'token-delta',
      channel: 'request-tail',
      baseline: '改动前最后一次会话的**首条**聊天请求 prompt_tokens',
      assertion: `prompt_tokens 增量 ≈ 「该字段真正注入的内容」的 token 差（±30%）。${assertionNote ?? ''}`,
    },

    /** 供界面呈现 */
    field: { container: containerKey, key: fieldKey, allowedValues: allowedValues ?? null },

    // ── 1. 探测 ────────────────────────────────────────────────
    async probe(ctx) {
      const { path: abs } = ctx.resolve(this.target);
      const exists = fs.existsSync(abs);
      const text = exists ? fs.readFileSync(abs, 'utf8') : '';
      const value = exists ? readField(text, containerKey, fieldKey) : undefined;
      const inj = await injected(value, ctx);
      return {
        path: abs,
        exists,
        text,
        bytes: Buffer.byteLength(text, 'utf8'),
        sha256: exists ? sha256(Buffer.from(text, 'utf8')) : null,
        value,
        valueValid: allowedValues ? allowedValues.includes(value) : value !== undefined,
        allowedValues: allowedValues ?? null,
        injectedChars: inj.text == null ? null : inj.text.length,
        injectedTokens: inj.text == null ? null : estimateTokens(inj.text).tokens,
        tokens: estimateTokens(text),
        injectedNote: inj.note,
      };
    },

    // ── 2. 差异预览 ────────────────────────────────────────────
    async preview(ctx, { next: rawNext } = {}) {
      const state = await this.probe(ctx);
      const warnings = [];
      const { value: next, note: normNote } = normalizeValue(rawNext);
      if (normNote) warnings.push(normNote);

      if (allowedValues && !allowedValues.includes(next)) {
        throw new InvalidValueError(
          `「${pathLabel}」只接受固定取值，拒绝写入 ${JSON.stringify(next)}`
          + '——WorkBuddy 对非法取值会**静默忽略**（风格/指令直接消失），所以这里必须拦住',
          { field: pathLabel, allowedValues, attempted: next },
        );
      }
      if (state.injectedNote) warnings.push(state.injectedNote);

      const write = state.exists ? writeField(state.text, containerKey, fieldKey, next) : null;
      if (state.exists && !write) {
        warnings.push('无法在保留原文件格式的前提下写入该字段 —— apply 会拒绝而不是整篇重排。');
      }
      const afterText = write ? write.text : state.text;
      const diff = diffLines(state.text, afterText);

      const beforeInj = await injected(state.value, ctx);
      const afterInj = await injected(next, ctx);
      const expectedDeltaTokens = (beforeInj.text != null && afterInj.text != null)
        ? estimateTokens(afterInj.text).tokens - estimateTokens(beforeInj.text).tokens
        : null;
      if (expectedDeltaTokens == null) {
        warnings.push('无法预估 token 增量：该字段真正注入的内容解析不出来（如 style 文件缺失）。'
          + '验证时需手工提供期望增量，或先修复锚点。');
      }

      if (extraWarnings) warnings.push(...await extraWarnings(next, ctx));

      return {
        path: state.path,
        willCreate: !state.exists,
        diff,
        diffText: renderDiff(diff),
        cost: estimateCost({ before: beforeInj.text ?? '', after: afterInj.text ?? '' }),
        expectedDeltaTokens,
        injectedChars: afterInj.text == null ? null : afterInj.text.length,
        truncated: false,
        dropped: 0,
        warnings,
        bytesDelta: (write ? Buffer.byteLength(write.text, 'utf8') : 0) - state.bytes,
        writeMode: write ? write.mode : null,
        valueBefore: state.value,
        valueAfter: next,
      };
    },

    // ── 4. 写入 ────────────────────────────────────────────────
    async apply(ctx, { next: rawNext } = {}) {
      const { value: next } = normalizeValue(rawNext);
      if (allowedValues && !allowedValues.includes(next)) {
        throw new InvalidValueError(`「${pathLabel}」拒绝写入非法取值 ${JSON.stringify(next)}`, {
          field: pathLabel, allowedValues, attempted: next,
        });
      }
      const { path: abs } = ctx.resolve(this.target);
      const text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '{}';
      const w = writeField(text, containerKey, fieldKey, next);
      if (!w) {
        throw new InvalidValueError(
          `无法在保留原格式的前提下写入「${pathLabel}」—— 拒绝整篇重排（会污染无关字段的格式）`,
          { field: pathLabel, path: abs },
        );
      }
      // 原子写（R27）：最小改动写入也必须原子落盘，否则 ENOSPC 会把整篇 app-config.json 截成 0 字节
      writeFileAtomic(abs, w.text);
      return { path: abs, bytes: Buffer.byteLength(w.text, 'utf8'), writeMode: w.mode, value: next };
    },

    // ── 5. 验证 ────────────────────────────────────────────────
    async verify(ctx, args = {}) {
      const state = await this.probe(ctx);
      const result = evaluateTokenDelta({
        baselineTokens: args.baselineTokens,
        observedTokens: args.observedTokens,
        expectedDelta: Number.isFinite(args.expectedDelta) ? args.expectedDelta : undefined,
      });
      const warnings = [];
      if (result.verdict === 'ineffective' && !state.valueValid) {
        warnings.push(
          `当前「${pathLabel}」取值非法（${JSON.stringify(state.value)}）——`
          + 'WorkBuddy 会静默忽略它，这本身就会让 Δ≈0。先修取值，再谈通道。',
        );
      }
      return {
        ...result,
        handle: this.id,
        currentValue: state.value,
        currentValueValid: state.valueValid,
        allowedValues: state.allowedValues,
        injectedNote: state.injectedNote,
        warnings,
      };
    },
  };
}
