/**
 * 极简行差异 —— 只为 preview 阶段的"改了什么"服务，不求花哨。
 * 大文件退化为摘要（不假装精确）。
 */

const DEFAULT_CAP = 1200;

/** @param {string} text */
function splitLines(text) {
  if (typeof text !== 'string' || text === '') return [];
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * LCS 行差异。
 * @param {string} beforeText
 * @param {string} afterText
 * @param {{maxLines?:number, context?:number}} [opts]
 */
export function diffLines(beforeText, afterText, opts = {}) {
  const cap = opts.maxLines ?? DEFAULT_CAP;
  const context = opts.context ?? 2;
  const a = splitLines(beforeText);
  const b = splitLines(afterText);

  if (a.length > cap || b.length > cap) {
    return {
      coarse: true,
      note: `行数超过 ${cap}，仅给摘要（不假装精确）`,
      added: b.length,
      removed: a.length,
      linesAdded: b.length,
      linesRemoved: 0,
      ops: [],
    };
  }

  // 去掉公共前后缀，缩小 DP 规模
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;

  /** @type {(' '|'+'|'-')[]} */
  const midOps = [];
  if (n === 0) {
    for (let j = 0; j < m; j += 1) midOps.push('+');
  } else if (m === 0) {
    for (let i = 0; i < n; i += 1) midOps.push('-');
  } else {
    // DP 表
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * w + j] = midA[i] === midB[j]
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { midOps.push(' '); i += 1; j += 1; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) { midOps.push('-'); i += 1; }
      else { midOps.push('+'); j += 1; }
    }
    while (i < n) { midOps.push('-'); i += 1; }
    while (j < m) { midOps.push('+'); j += 1; }
  }

  // 组装成 op 列表（带行号）
  const ops = [];
  for (let k = 0; k < start; k += 1) ops.push({ op: ' ', text: a[k], aLine: k + 1, bLine: k + 1 });
  let ai = start;
  let bi = start;
  for (const o of midOps) {
    if (o === ' ') { ops.push({ op: ' ', text: a[ai], aLine: ai + 1, bLine: bi + 1 }); ai += 1; bi += 1; }
    else if (o === '-') { ops.push({ op: '-', text: a[ai], aLine: ai + 1, bLine: null }); ai += 1; }
    else { ops.push({ op: '+', text: midB[bi - start], aLine: null, bLine: bi + 1 }); bi += 1; }
  }
  for (let k = endA; k < a.length; k += 1) {
    ops.push({ op: ' ', text: a[k], aLine: k + 1, bLine: k - endA + endB + 1 });
  }

  const added = ops.filter((o) => o.op === '+').length;
  const removed = ops.filter((o) => o.op === '-').length;

  // 只保留有变化的区段（带 context 行）
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, idx) => {
    if (o.op === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k += 1) keep[k] = true;
  });
  const hunks = [];
  let cur = null;
  ops.forEach((o, idx) => {
    if (!keep[idx]) { cur = null; return; }
    if (!cur) { cur = []; hunks.push(cur); }
    cur.push(o);
  });

  return { coarse: false, added, removed, hunks, opCount: ops.length };
}

/**
 * 渲染为可读文本。
 * @param {ReturnType<typeof diffLines>} d
 */
export function renderDiff(d) {
  if (d.coarse) return `（${d.note}：原 ${d.removed} 行 → 新 ${d.added} 行）`;
  if (d.hunks.length === 0) return '（无变化）';
  const out = [];
  let last = null;
  for (const h of d.hunks) {
    const firstA = h.find((o) => o.aLine !== null)?.aLine ?? null;
    if (last !== null && firstA !== null && firstA > last + 1) out.push('  ⋯');
    for (const o of h) {
      out.push(`${o.op}${o.text}`);
      if (o.aLine !== null) last = o.aLine;
    }
  }
  return out.join('\n');
}
