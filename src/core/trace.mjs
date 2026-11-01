/**
 * trace 读取 —— token-delta 验证的数据来源。
 *
 * 结构（本机实测）：
 *   <configRoot>/traces/<worker-pid>/trace_<hash>.jsonl
 *   每行一个 JSON；span 名称有 mcp_tools / cli / generation
 *   已完成的 generation 在 `type === 'span_end'` 且 `span.toolOutput` 内是 chat.completion 原文，
 *   usage 形如：
 *     "usage":{"prompt_tokens":35849,"completion_tokens":4,
 *              "prompt_tokens_details":{"cached_tokens":7680,...}}
 *
 * ⚠️ 必须过滤非聊天模型：标题生成走 `wb-lite`（约 517 tokens 的静态提示词），
 *    混进来会污染基线（见 docs/verification.md 的"单变量"纪律）。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 非聊天模型（不作为 token-delta 样本）
 *
 * 实测（本机 560 条 generation）：
 *   - `wb-lite`：标题生成，静态提示词约 517 tokens → 明显不是聊天
 *   - `step-5-preview`：302 条，首条 token 跨度 **530–180541**（340 倍）
 *     → 这不是普通聊天：极可能是子任务/预览类请求，规模随任务而变。
 *     拿它当基线会严重失真，因此**排除出 token-delta 样本池**。
 *   - `minimax-m3.1-flash` / `deepseek-v4.1-flash`：真正的聊天模型
 *
 * 判据是"是否参与主聊天链路"，不是"模型名字像不像聊天"。
 * 新增模型时：若它的 token 规模与主聊天差异巨大，就应加进这里。
 */
const NON_CHAT_MODEL = /^(wb-lite|step-5-preview)$/i;

/** @param {string} configRoot */
export function traceRoot(configRoot) {
  return path.join(configRoot, 'traces');
}

/**
 * 列出全部 trace 文件（新→旧）。
 * @param {string} configRoot
 */
export function listTraceFiles(configRoot) {
  const root = traceRoot(configRoot);
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const p = path.join(dir, n);
      try {
        const st = fs.statSync(p);
        out.push({ path: p, worker: d.name, mtime: st.mtimeMs, size: st.size });
      } catch { /* 忽略不可读 */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * 从 toolOutput 提取 usage。优先结构化解析，失败回退正则。
 * @param {string} raw
 */
export function parseGeneration(raw) {
  if (!raw) return null;
  let obj = null;
  const trimmed = raw.trim();
  try {
    obj = JSON.parse(trimmed);
  } catch {
    const i = trimmed.indexOf('{');
    if (i >= 0) { try { obj = JSON.parse(trimmed.slice(i)); } catch { obj = null; } }
  }
  if (obj && obj.usage && Number.isFinite(obj.usage.prompt_tokens)) {
    return {
      promptTokens: obj.usage.prompt_tokens,
      completionTokens: obj.usage.completion_tokens ?? null,
      cachedTokens: obj.usage.prompt_tokens_details?.cached_tokens
        ?? obj.usage.prompt_cache_hit_tokens
        ?? obj.usage.cache_read_input_tokens
        ?? null,
      model: typeof obj.model === 'string' ? obj.model : null,
      finishReason: obj.choices?.[0]?.finish_reason ?? null,
      content: typeof obj.choices?.[0]?.message?.content === 'string' ? obj.choices[0].message.content : '',
    };
  }
  // 回退：正则（结构可能被包装或截断）
  const g = (re) => { const m = raw.match(re); return m ? m[1] : null; };
  const pt = g(/"prompt_tokens":(\d+)/);
  if (!pt) return null;
  return {
    promptTokens: Number(pt),
    completionTokens: g(/"completion_tokens":(\d+)/) ? Number(g(/"completion_tokens":(\d+)/)) : null,
    cachedTokens: g(/"cached_tokens":(\d+)/) ? Number(g(/"cached_tokens":(\d+)/)) : null,
    model: g(/"model":"([^"]+)"/),
    finishReason: g(/"finish_reason":"([^"]+)"/),
    content: '',
  };
}

/**
 * 读取全部 generation 记录（按时间升序）。
 * @param {string} configRoot
 * @param {{limitFiles?:number}} [opts]
 */
export function readGenerations(configRoot, opts = {}) {
  const limitFiles = opts.limitFiles ?? 80;
  const recs = [];
  for (const f of listTraceFiles(configRoot).slice(0, limitFiles)) {
    let lines;
    try { lines = fs.readFileSync(f.path, 'utf8').split('\n'); } catch { continue; }
    for (const l of lines) {
      if (!l || l.charCodeAt(0) !== 0x7b) continue; // 快速跳过非 '{' 开头
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.type !== 'span_end' || j.span?.name !== 'generation') continue;
      const raw = String(j.span.toolOutput ?? '');
      if (!raw) continue;
      const u = parseGeneration(raw);
      if (!u || !Number.isFinite(u.promptTokens)) continue;
      const at = j.span.startedAt ?? j.span.endedAt ?? null;
      const atMs = at ? Date.parse(at) : NaN;
      recs.push({
        at,
        atMs: Number.isFinite(atMs) ? atMs : null,
        worker: f.worker,
        traceFile: path.basename(f.path),
        traceId: j.span.traceId ?? j.traceId ?? null,
        status: j.span.status ?? null,
        model: u.model,
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        cachedTokens: u.cachedTokens,
        finishReason: u.finishReason,
        contentPreview: String(u.content ?? '').slice(0, 80),
        /** 只有参与主聊天链路的请求才可作为对照样本 */
        isChat: !NON_CHAT_MODEL.test(String(u.model ?? '')),
        /**
         * 该 trace 文件里 mcp_tools 的出现次数 —— **请求结构探针**。
         * 工具定义进请求前缀：MCP 工具数变化会直接改变 prompt_tokens，
         * 这种差异**不能归因给提示词改动**。实测教训：某次会话从 20 降到 6，
         * 造成 1200+ tokens 的伪偏移。
         */
        mcpToolCount: (lines.filter((x) => x.includes('mcp_tools')).length) || 0,
      });
    }
  }
  return recs.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
}
