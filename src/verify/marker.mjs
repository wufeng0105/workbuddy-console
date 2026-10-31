/**
 * 验证策略 · 标记法（marker-trace-grep）
 * ---------------------------------------------------------------
 * 适用：请求**头部**通道（C 组 `prompt.tpl` / fragments）。
 *
 * 依据 docs/verification.md：
 *   头部通道的内容完整出现在 trace 的请求体里，因此"注入唯一标记 → 新 trace 里 grep"
 *   是可靠且便宜的判定方式。
 *
 * ⚠️ 与尾部通道的界限（这是本项目最贵的一条教训）：
 *   **绝不能**用本策略判请求**尾段**通道 —— trace 会在某个长度处截断，
 *   尾段内容天然缺席，grep 的"零命中"是**假阴性**，不是证据。
 *   `contracts.mjs` 的 `assertHandle` 已内建这条拦截。
 *
 * 三态纪律：
 *   - 找到 → effective
 *   - 没找到，但**确认有新 trace 落盘** → ineffective
 *   - 没有新 trace（用户还没发消息） → **undetermined**（不能判失败）
 */

import crypto from 'node:crypto';
import { readGenerations } from '../core/trace.mjs';
import { readTraceTextSince } from '../core/trace-raw.mjs';

/**
 * 生成一个不会被自然文本撞上的标记。
 * @param {string} prefix
 * @param {string} [tag]
 */
export function buildMarker(prefix = 'WBC-PROBE', tag) {
  const t = tag ?? crypto.randomBytes(4).toString('hex');
  return `${prefix}-${t}`;
}

/**
 * @param {{configRoot:string, marker:string, afterMs?:number, sessionStartOf?:Function}} p
 * @returns {Promise<{verdict:'effective'|'ineffective'|'undetermined', reason:string, hits:object[], warnings:string[]}>}
 */
export async function verifyMarker({ configRoot, marker, afterMs, sessionStartOf }) {
  if (typeof marker !== 'string' || marker.length < 6) {
    return {
      verdict: 'undetermined',
      reason: '标记太短或缺失 —— 无法作为可靠判据',
      hits: [],
      warnings: [],
    };
  }

  const scan = readTraceTextSince(configRoot, { afterMs });
  const warnings = [];

  if (scan.filesScanned === 0) {
    return {
      verdict: 'undetermined',
      reason: 'trace 目录里没有可读记录 —— 需要至少让 WorkBuddy 发过一次消息',
      hits: [],
      warnings,
    };
  }

  // 时间过滤必须**逐条**再做一次：
  // 文件 mtime 可能晚于改动时间，但文件里的记录本身更早（同一个 trace 文件持续追加）。
  // 只按文件 mtime 过滤会把"改动前的旧标记"误当成新证据。
  //
  // 无行内时间戳的记录：**不可判定时间** —— 既不算命中，也不算没命中，
  // 单独收集后决定是否降级为 undetermined。绝不拿文件 mtime 冒充（那是猜）。
  const hits = [];
  const undatedHits = [];
  for (const m of scan.matches) {
    if (!m.line.includes(marker)) continue;
    if (!Number.isFinite(afterMs)) { hits.push(m); continue; }
    if (Number.isFinite(m.at)) {
      if (m.at >= afterMs) hits.push(m);
    } else {
      undatedHits.push(m);
    }
  }

  if (hits.length > 0) {
    return {
      verdict: 'effective',
      reason: `在 ${hits.length} 处 trace 记录里找到标记 ${marker} —— 内容确实进入了请求`,
      hits,
      warnings,
    };
  }

  // 有标记但全部缺时间戳 → 无法判断是不是"改动后的"
  if (undatedHits.length > 0) {
    warnings.push(
      `找到 ${undatedHits.length} 处标记，但那些记录**没有时间戳**，无法确定是否在改动之后。`
      + '这种情况下不判"生效"也不判"未生效"。',
    );
    return {
      verdict: 'undetermined',
      reason: `有 ${undatedHits.length} 处标记无法判定时间先后 —— 请让 WorkBuddy 再发一条消息后重试`,
      hits: [],
      warnings,
    };
  }

  // 没找到：只有确认"改动后有新请求落盘"时才能判未生效
  const gens = readGenerations(configRoot, { limitFiles: 40 });
  const latest = gens.map((g) => g.atMs).filter((t) => Number.isFinite(t)).sort((a, b) => b - a)[0];
  if (!Number.isFinite(latest)) {
    return {
      verdict: 'undetermined',
      reason: '没有找到任何聊天请求记录 —— 无法判断标记是否进入',
      hits: [],
      warnings,
    };
  }
  if (Number.isFinite(afterMs) && latest < afterMs) {
    return {
      verdict: 'undetermined',
      reason: '改动之后还没有新请求。请让 WorkBuddy 发一条消息（若在运行中改的模板，建议重启后再发），然后重新验证',
      hits: [],
      warnings,
    };
  }

  warnings.push(
    '未命中标记，且确认改动后已有新请求 —— 可能原因：① 闸门未满足（应用运行中改模板可能不生效）；'
    + '② 该插件不是当前活跃的 welcomemode；③ 升级已重建版本目录。',
  );
  return {
    verdict: 'ineffective',
    reason: `改动后的新请求里**没有**标记 ${marker}`,
    hits: [],
    warnings,
  };
}

export const markerStrategy = Object.freeze({
  id: 'marker-trace-grep',
  channels: Object.freeze(['request-head']),
  verify: verifyMarker,
});
