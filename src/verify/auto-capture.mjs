/**
 * 自动对照采集 —— 把 token-delta 从"手工填数字"变成"改完点一下"。
 *
 * 原理：
 *   审计台账里有 apply 的**时间戳**与**期望增量**；
 *   trace 里有每次 generation 的 **prompt_tokens**；
 *   `traces/<worker-pid>/` 的**目录创建时间 ≈ 会话起点**（本机实测：与首条请求相差 27–250ms）。
 *
 *   ⇒ 基线 = apply 之前**最后一次会话**的首条聊天请求
 *     观测 = apply 之后**第一次会话**的首条聊天请求
 *
 * 为什么用「会话」而不是「时间上最近的一条请求」：
 *   - 同一条会话内，prompt_tokens 会随历史累积而**逐轮增长**，
 *     "最近一条"会把历史长度混进增量里 → 归因失效。
 *   - 会话的**首条**请求才代表"静态前缀 + user-context + 首条提问"，才是可比的量。
 *
 * 为什么用「会话起点」而不是「首条请求时间」：
 *   - user-context 在**会话启动时**渲染。若会话在改动**之前**就已创建，
 *     它之后哪怕发出请求，用的也是**旧** user-context → Δ≈0 是**假阴性**。
 *   - 用目录创建时间可以把这种会话整个排除掉，而不是误判成"未生效"。
 *
 * 诚实边界：
 *   - 排除非聊天请求（标题生成走 `wb-lite`，约 517 tokens 静态提示词）
 *   - 排除 prompt_tokens=0 / content_filter 的异常记录
 *   - 取不到会话起点时**明确标注**为次优信号（首条请求时间），不假装精确
 *   - 找不到观测点就说"找不到"，**不要**退化成"未生效"
 */

import fs from 'node:fs';
import path from 'node:path';
import { readGenerations, traceRoot } from '../core/trace.mjs';

/**
 * 默认的会话起点探测器：`traces/<worker>/` 的目录创建时间。
 * @param {string} configRoot
 * @returns {(worker:string) => number|null}
 */
export function defaultSessionStartOf(configRoot) {
  const root = traceRoot(configRoot);
  const cache = new Map();
  return (worker) => {
    if (cache.has(worker)) return cache.get(worker);
    let v = null;
    try {
      const st = fs.statSync(path.join(root, String(worker)));
      if (Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0) v = st.birthtimeMs;
    } catch { /* 取不到就走次优信号 */ }
    cache.set(worker, v);
    return v;
  };
}

/**
 * 选出基线会话与观测会话。
 * @param {Array} generations readGenerations 的输出
 * @param {number} applyAtMs
 * @param {(worker:string)=>number|null} sessionStartOf
 */
export function pickSessions(generations, applyAtMs, sessionStartOf) {
  // 只保留可信的聊天样本
  const chat = generations.filter(
    (g) => g.isChat && g.atMs != null && g.promptTokens > 0 && g.finishReason !== 'content_filter',
  );
  const excluded = generations.length - chat.length;

  /** 每个 worker 一条会话，取其**首条**聊天请求 */
  const byWorker = new Map();
  for (const g of chat) {
    const cur = byWorker.get(g.worker);
    if (!cur || g.atMs < cur.first.atMs) byWorker.set(g.worker, { worker: g.worker, first: g });
  }

  const sessions = [...byWorker.values()].map((s) => {
    const fromDir = sessionStartOf(s.worker);
    return {
      worker: s.worker,
      first: s.first,
      /** 会话起点：优先目录创建时间，回退首条请求时间 */
      startMs: fromDir ?? s.first.atMs,
      startSource: fromDir != null ? 'dir-created' : 'first-request',
    };
  }).sort((a, b) => a.startMs - b.startMs);

  const before = sessions.filter((s) => s.startMs < applyAtMs);
  const after = sessions.filter((s) => s.startMs > applyAtMs);

  return {
    baselineSession: before.at(-1) ?? null,
    observedSession: after[0] ?? null,
    chatCount: chat.length,
    excludedCount: excluded,
    sessionCount: sessions.length,
    /** 是否所有会话起点都来自目录创建时间（否则是次优信号） */
    allStartsAuthoritative: sessions.every((s) => s.startSource === 'dir-created'),
  };
}

/**
 * @param {{configRoot:string, applyAtMs:number, expectedDelta?:number, limitFiles?:number, sessionStartOf?:Function}} p
 */
export function autoCapture({ configRoot, applyAtMs, expectedDelta, limitFiles, sessionStartOf }) {
  const warnings = [];
  const generations = readGenerations(configRoot, { limitFiles });
  const startOf = sessionStartOf ?? defaultSessionStartOf(configRoot);
  const picked = pickSessions(generations, applyAtMs, startOf);
  const { baselineSession, observedSession } = picked;

  if (generations.length === 0) {
    return { warnings, blockedReason: 'trace 里没有任何记录 —— 需要至少跑过一次真实会话' };
  }
  if (picked.chatCount === 0) {
    return { warnings, blockedReason: 'trace 里没有任何**聊天**请求记录（标题生成不算）—— 需要至少跑过一次真实会话' };
  }
  if (!baselineSession) {
    return { warnings, blockedReason: '改动之前没有任何会话 —— 无法取基线' };
  }
  if (!observedSession) {
    return {
      warnings,
      blockedReason: '改动后还没有**新会话**。请在 WorkBuddy 中新建一个会话并发送一条消息'
        + '（user-context 在会话启动时渲染，旧会话不会反映改动），然后重新运行 verify',
    };
  }

  if (!picked.allStartsAuthoritative) {
    warnings.push(
      '部分会话起点取自**首条请求时间**（拿不到目录创建时间）——'
      + '若某会话在改动前创建、改动后才发请求，它会被误当作观测点，结论可能偏保守。',
    );
  }
  if (baselineSession.first.model !== observedSession.first.model) {
    warnings.push(
      `基线与观测的模型不同（${baselineSession.first.model} vs ${observedSession.first.model}）——`
      + '模型不同则静态前缀不同，增量不可直接归因。',
    );
  }

  const b = baselineSession.first;
  const o = observedSession.first;

  return {
    baselineTokens: b.promptTokens,
    observedTokens: o.promptTokens,
    expectedDelta: Number.isFinite(expectedDelta) ? expectedDelta : undefined,
    evidence: {
      baseline: {
        at: b.at, worker: b.worker, model: b.model,
        promptTokens: b.promptTokens, cachedTokens: b.cachedTokens,
        traceFile: b.traceFile, sessionStart: new Date(baselineSession.startMs).toISOString(),
        sessionStartSource: baselineSession.startSource,
      },
      observed: {
        at: o.at, worker: o.worker, model: o.model,
        promptTokens: o.promptTokens, cachedTokens: o.cachedTokens,
        traceFile: o.traceFile, sessionStart: new Date(observedSession.startMs).toISOString(),
        sessionStartSource: observedSession.startSource,
      },
      excludedSamples: picked.excludedCount,
      sessionCount: picked.sessionCount,
      /** 会话首条请求才是可比量：同会话后续轮次含累积历史 */
      basis: 'session-first-request',
    },
    warnings,
    blockedReason: null,
  };
}
