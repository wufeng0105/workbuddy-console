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
 *
 * ⚠️ **会话的判据是 trace 文件，不是 worker**（真实数据实测教训）：
 *   WorkBuddy 会**复用 worker 进程**：同一个 worker=14824 在 50 秒内产生了
 *   3 条独立的聊天请求（35044 → 35289 → 35537），每次都是**新建会话**。
 *   若按 worker 分会话，这三条会被错误地当成"同会话累积历史"，
 *   从而把真实增量（+245/+248）误判成历史长度变化。
 *
 *   正确判据：**一个 trace 文件 = 一次请求**。同会话内的多轮，prompt_tokens 会
 *   随历史累积而增长；跨会话则回到基线水平。故取"每个会话的**第一条**"时，
 *   若 worker 被复用，应取该 worker 在**时间窗口内最早的**那条。
 *
 * @param {Array} generations readGenerations 的输出
 * @param {number} applyAtMs
 * @param {(worker:string)=>number|null} sessionStartOf
 * @param {{preferModel?:string}} [opts]
 */
export function pickSessions(generations, applyAtMs, sessionStartOf, opts = {}) {
  // 只保留可信的聊天样本
  const chat = generations.filter(
    (g) => g.isChat && g.atMs != null && g.promptTokens > 0 && g.finishReason !== 'content_filter',
  );
  const excluded = generations.length - chat.length;

  /** 自动选模型：优先用"改动前最后一次聊天所用的模型" */
  const beforeAll = chat.filter((g) => g.atMs < applyAtMs).sort((a, b) => b.atMs - a.atMs);
  const targetModel = opts.preferModel ?? beforeAll[0]?.model ?? null;
  const sameModel = targetModel ? chat.filter((g) => g.model === targetModel) : chat;

  /**
   * 每个 **trace 文件**（= 一次请求）作为一个样本点。
   * 但同一会话的多轮请求都应该聚合：取该会话的**首轮**。
   *
   * 会话边界如何判定？用 worker 目录的创建时间 + 请求间隔：
   *   - worker 目录创建时间 = 该 worker 进程的起点（一个进程可能服务多次新建会话）
   *   - 相邻请求间隔 > GAP 视为新会话（用户手动新建）
   */
  const GAP_MS = 20 * 1000;

  /** 按 worker 分组，再按时间切分成若干"会话" */
  const byWorker = new Map();
  for (const g of sameModel) {
    if (!byWorker.has(g.worker)) byWorker.set(g.worker, []);
    byWorker.get(g.worker).push(g);
  }

  const sessions = [];
  for (const [worker, list] of byWorker) {
    list.sort((a, b) => a.atMs - b.atMs);
    const dirStart = sessionStartOf(worker);
    /**
     * 关键：worker 目录创建时间 = 该 **worker 进程**的起点。
     * WorkBuddy 复用 worker 进程服务多次"新建会话"，所以：
     *   - 用 request-gap 切分出的是**逻辑会话**（用户点了新建）
     *   - 但 user-context 在**逻辑会话启动时**渲染，工作进程复不影响它
     *
     * 因此判定"该逻辑会话是否在改动之后创建"，用它的**首条请求时间**与 apply 比。
     * 只有在整个 worker 只有一个分片（即 worker 从头到尾就是这一条会话）时，
     * 才用目录创建时间（更精确地反映"会话何时开始"）。
     */
    let chunk = [list[0]];
    const push = () => {
      const onlyChunk = list.length === chunk.length;
      sessions.push({
        worker,
        first: chunk[0],
        startMs: onlyChunk && dirStart != null ? dirStart : chunk[0].atMs,
        startSource: onlyChunk && dirStart != null ? 'dir-created' : 'request-gap',
      });
    };
    for (let i = 1; i < list.length; i += 1) {
      const gap = list[i].atMs - list[i - 1].atMs;
      if (gap > GAP_MS) {
        push();
        chunk = [list[i]];
      } else {
        chunk.push(list[i]);
      }
    }
    push();
  }

  sessions.sort((a, b) => a.startMs - b.startMs);

  const before = sessions.filter((s) => s.startMs < applyAtMs);
  const after = sessions.filter((s) => s.startMs > applyAtMs);

  /** 其它模型被排除的样本数（供告警用） */
  const otherModelsExcluded = targetModel ? chat.length - sameModel.length : 0;

  return {
    baselineSession: before.at(-1) ?? null,
    observedSession: after[0] ?? null,
    chatCount: sameModel.length,
    excludedCount: excluded,
    sessionCount: sessions.length,
    /** 使用的模型（跨模型不可比，所以固定一个） */
    targetModel,
    otherModelsExcluded,
    /** 是否所有会话起点都来自目录创建时间（否则是次优信号） */
    allStartsAuthoritative: sessions.every((s) => s.startSource === 'dir-created'),
    /** 会话切分依据（供排障） */
    splitting: 'trace-file + request-gap',
  };
}

/**
 * 基线新鲜度阈值：改动前多久之内必须有过可比会话。
 * 超过这个窗口，基线与观测很可能来自不同场景（不同模板、不同工具集），
 * 跨场景比基线是**假阴性**的常见来源 —— 实测教训：拿 10-31 的 E 组会话
 * 当 11-01 普通会话的基线，得出 Δ-1013 判"未生效"，实际改动是生效的。
 */
export const BASELINE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 小时

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

  // ── 硬约束 0：观测必须真在改动之后创建的新会话 ──
  // 若观测来自"旧 worker 里按 request-gap 切出的分片"，其 user-context 可能仍是旧的
  // （worker 复用 + 逻辑会话边界 ≠ user-context 重渲染边界）⇒ Δ≈0 是假阴性。
  if (observedSession.startSource === 'request-gap') {
    const dirStart = startOf(observedSession.worker);
    if (dirStart != null && dirStart < applyAtMs) {
      return {
        warnings,
        blockedReason: `观测点所在的 worker（${observedSession.worker}）在**改动之前**就已启动 —— `
          + '它是旧 worker 里切出来的分片，user-context 很可能仍是旧的。'
          + '请**完全新建会话**（或重启 WorkBuddy）后重测，否则 Δ≈0 是假阴性。',
      };
    }
  }

  // ── 硬约束 1：基线必须新鲜 ──
  // 陈旧基线 = 跨场景比较 = 假阴性。宁可说"无法判定"，也不给错结论。
  const baselineAge = applyAtMs - baselineSession.startMs;
  if (Number.isFinite(baselineAge) && baselineAge > BASELINE_MAX_AGE_MS) {
    const hours = (baselineAge / 3600_000).toFixed(1);
    return {
      warnings,
      blockedReason: `基线会话距改动已 ${hours} 小时（超过 ${BASELINE_MAX_AGE_MS / 3600_000} 小时上限）——`
        + '跨场景比较会把模板/工具集/角色的差异算进增量，结论不可信。'
        + `请先跑一次普通会话说句话建立新基线，再 apply 改动，最后再跑一次会话验证。`,
    };
  }

  // ── 硬约束 2：请求结构必须可比（MCP 工具数）──
  // 工具定义进请求前缀；MCP 工具数不同 ⇒ 前缀不同 ⇒ 增量不能归因给提示词改动。
  const bMcp = baselineSession.first.mcpToolCount ?? null;
  const oMcp = observedSession.first.mcpToolCount ?? null;
  if (Number.isFinite(bMcp) && Number.isFinite(oMcp) && bMcp !== oMcp) {
    warnings.push(
      `两轮的 MCP 工具数不同（${bMcp} vs ${oMcp}）—— 工具定义进请求前缀，`
      + '这部分差异**不能归因**给你的改动。实测教训：某次会话工具数从 20 降到 6，'
      + '造成了 1200+ tokens 的伪偏移。',
    );
  }

  if (applyAtMs && observedSession && baselineSession) {
    const baseStart = baselineSession.startMs;
    const obsStart = observedSession.startMs;
    if (!(obsStart > baseStart)) {
      // 不该发生，但万一集合顺序错了要早发现
      warnings.push('观测会话的起点不晚于基线会话 —— 采样顺序异常，结论不可信。');
    }
  }

  if(!picked.allStartsAuthoritative) {
    warnings.push(
      '部分会话起点取自**首条请求时间**（拿不到目录创建时间）——'
      + '若某会话在改动前创建、改动后才发请求，它会被误当作观测点，结论可能偏保守。',
    );
  }
  if (picked.otherModelsExcluded > 0) {
    warnings.push(
      `已排除 ${picked.otherModelsExcluded} 条**其它模型**的样本（本次只用 ${picked.targetModel}）——`
      + '不同模型的静态前缀与分词器不同，跨模型算增量没有意义。',
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
      targetModel: picked.targetModel,
      otherModelsExcluded: picked.otherModelsExcluded,
      /** 请求结构探针：两轮 MCP 工具数，供调用方判断可比性 */
      mcpToolCount: { baseline: bMcp, observed: oMcp, comparable: bMcp === oMcp },
      /** 基线新鲜度 */
      baselineAgeMs: Number.isFinite(baselineAge) ? baselineAge : null,
      /** 会话首条请求才是可比量：同会话后续轮次含累积历史 */
      basis: 'session-first-request',
    },
    warnings,
    blockedReason: null,
  };
}
