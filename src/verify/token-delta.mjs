/**
 * 验证策略 · token-delta
 * ---------------------------------------------------------------
 * 适用：请求**尾段**通道（user-context：SOUL / 身份 / 风格 / 指令）。
 * 原理：单变量对照 —— 改前基线与改后的 prompt_tokens 之差，对照理论增量。
 *
 * 依据 docs/verification.md；这是尾段通道**唯一可靠**的策略
 * （trace grep 在尾段会因截断产生假阴性）。
 *
 * 输出恒为三态：effective / ineffective / undetermined，**不合并**。
 */

const SMALL_NOISE = 3;      // tokens 级别的噪声容忍
const MIN_MEANINGFUL = 20;  // 小于此预期增量不值得判定

/**
 * @param {{baselineTokens?:number, observedTokens?:number, expectedDelta?:number, tolerance?:number, note?:string}} p
 * @returns {{verdict:'effective'|'ineffective'|'undetermined', reason:string, delta?:number, expected?:number, deviation?:number}}
 */
export function evaluateTokenDelta({
  baselineTokens,
  observedTokens,
  expectedDelta,
  tolerance = 0.3,
  note,
} = {}) {
  if (!Number.isFinite(baselineTokens) || !Number.isFinite(observedTokens)) {
    return {
      verdict: 'undetermined',
      reason: '缺少基线或观测的 prompt_tokens —— 需要一次真实会话的单变量对照（改前测一次、改后测一次）',
    };
  }

  const delta = observedTokens - baselineTokens;

  if (!Number.isFinite(expectedDelta)) {
    return {
      verdict: 'undetermined',
      reason: `缺少理论增量；仅观测到 Δ${delta} tokens，无法判定`,
      delta,
    };
  }

  // 预期无变化（|期望| 在噪声级别）
  if (Math.abs(expectedDelta) <= SMALL_NOISE) {
    return Math.abs(delta) <= SMALL_NOISE
      ? { verdict: 'effective', reason: `预期无变化，实测 Δ${delta}（在噪声范围内）`, delta, expected: expectedDelta }
      : {
        verdict: 'undetermined',
        reason: `预期无变化但实测 Δ${delta} tokens —— 可能有别的变量在动`,
        delta,
        expected: expectedDelta,
      };
  }

  // 预期有增量，但实测几乎没动 → 未生效
  if (delta <= SMALL_NOISE) {
    return {
      verdict: 'ineffective',
      reason: `预期 +${expectedDelta} tokens，实测 Δ${delta} —— 改动未进入请求`,
      delta,
      expected: expectedDelta,
    };
  }

  const deviation = Math.abs(delta - expectedDelta) / Math.max(1, Math.abs(expectedDelta));
  const lowSensitivity = Math.abs(expectedDelta) < MIN_MEANINGFUL
    ? `（注意：期望增量仅 ${expectedDelta} tokens，判定敏感度低——样本误差占比高）`
    : '';

  if (deviation <= tolerance) {
    return {
      verdict: 'effective',
      reason: `实测 Δ${delta} ≈ 预期 +${expectedDelta}（偏差 ${(deviation * 100).toFixed(1)}%）${lowSensitivity}${note ? ` · ${note}` : ''}`,
      delta,
      expected: expectedDelta,
      deviation,
      lowSensitivity: Boolean(lowSensitivity),
    };
  }

  // 增量偏差过大：不硬判"生效"，也不硬判"未生效"
  return {
    verdict: 'undetermined',
    reason: `实测 Δ${delta} 与预期 +${expectedDelta} 偏差 ${(deviation * 100).toFixed(1)}%（超出 ${(tolerance * 100).toFixed(0)}% 容忍）—— 可能有别的变量在动，无法归因`,
    delta,
    expected: expectedDelta,
    deviation,
  };
}

export const tokenDeltaStrategy = Object.freeze({
  id: 'token-delta',
  channels: Object.freeze(['request-tail']),
  evaluate: evaluateTokenDelta,
});
