/**
 * trace 原文扫描 —— 标记法需要看**完整请求体**，而不只是 usage 摘要。
 *
 * 与 core/trace.mjs 的分工：
 *   - trade.mjs：抽取 usage（token 增量法用）
 *   - 本模块：抽取**文本**（标记法用），可按时间过滤
 *
 * ⚠️ 本模块刻意**不做**"请求头部 vs 请求尾部"的判断 —— 它只告诉你
 *   "某段文本是否出现在 trace 文件里"。是否可据此判定，由调用方（验证策略）负责。
 */

import fs from 'node:fs';
import { listTraceFiles } from './trace.mjs';

/** 单文件扫描上限，避免超大 trace 拖垮内存 */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * @param {string} configRoot
 * @param {{afterMs?:number, limitFiles?:number}} [opts]
 */
export function readTraceTextSince(configRoot, opts = {}) {
  const { afterMs, limitFiles = 60 } = opts;
  const files = listTraceFiles(configRoot).slice(0, limitFiles);

  let skippedByTime = 0;
  let filesScanned = 0;
  /** @type {{file:string, worker:string, at:number|null, line:string}[]} */
  const matches = [];

  for (const f of files) {
    if (Number.isFinite(afterMs) && f.mtime < afterMs) { skippedByTime += 1; continue; }
    let raw;
    try {
      if (f.size > MAX_BYTES) {
        raw = fs.readFileSync(f.path, { encoding: 'utf8' }).slice(-MAX_BYTES);
      } else {
        raw = fs.readFileSync(f.path, 'utf8');
      }
    } catch { continue; }
    filesScanned += 1;

    for (const line of raw.split('\n')) {
      if (!line) continue;
      let at = null;
      const m = /"startedAt":"([^"]+)"/.exec(line);
      if (m) { const t = Date.parse(m[1]); if (Number.isFinite(t)) at = t; }
      // 行内没有时间戳时，用文件 mtime 兜底 —— 否则"改动前的旧标记"会因为没有
      // 时间戳而被当成新证据（时间过滤失效）。这是保守方向：宁可高估时间。
      matches.push({ file: f.path, worker: f.worker, at, fileMtime: f.mtime, line });
    }
  }

  return { filesScanned, skippedByTime, matches };
}
