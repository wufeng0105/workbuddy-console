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

  // 预期有增量，但实测几乎没动 —— 先看增量是否小到"本来就不该判"
  //
  // 曾经（T4 第一版）：`MIN_MEANINGFUL` 只被用来拼一句提示语，没有参与判定，
  // 于是"期望 +7、实测 +0"被判成 `ineffective` —— 假确定性。
  // 第一版修法（把 <20 一律判 undetermined）**引入了两个新问题**，由独立复核抓出：
  //   ① 用带符号 delta 判"几乎没动"：删减改动的期望增量为负，
  //      实测 Δ-60 会落进 `delta <= SMALL_NOISE`，被说成"未进入请求"——
  //      于是**任何"删内容"的改动永远判不出 effective**（实测 apply 缩短 SOUL 得 expectedDelta=-375）。
  //   ② 小增量把真实异常吞掉：期望 +19、实测 -3000（样本完全跑飞）也被说成
  //      "无法与样本噪声区分"，理由与事实相反，而且把一个本该报警的异常降级成了"判不了"。
  //
  // 现在按三条独立判据分别处理：
  //   a) 噪声带用**绝对值**判（|delta|），负增量不再被误当成"没动"；
  //   b) 小增量只在**实测确实接近 0** 时才降级为 undetermined；偏离很大要如实报异常；
  //   c) 剩下的正常区间统一用带符号的偏差比较。
  const nearZero = Math.abs(delta) <= SMALL_NOISE;

  if (Math.abs(expectedDelta) < MIN_MEANINGFUL) {
    // 小增量但**实测与期望吻合**：样本本来就该动这么多，而且确实动了 —— 这就是生效。
    // （曾经的坑：一律判 undetermined，把"吻合"也吞成"判不了"，属反向误判。）
    const smallDeviation = Math.abs(delta - expectedDelta) / Math.max(1, Math.abs(expectedDelta));
    if (!nearZero && smallDeviation <= tolerance) {
      return {
        verdict: 'effective',
        reason: `实测 Δ${delta} ≈ 预期 ${expectedDelta >= 0 ? '+' : ''}${expectedDelta}（偏差 ${(smallDeviation * 100).toFixed(1)}%）`
          + `（注意：期望增量仅 ${expectedDelta} tokens，判定敏感度低——样本误差占比高）${note ? ` · ${note}` : ''}`,
        delta,
        expected: expectedDelta,
        deviation: smallDeviation,
        lowSensitivity: true,
      };
    }
    if (nearZero) {
      return {
        verdict: 'undetermined',
        reason: `预期增量仅 ${expectedDelta >= 0 ? '+' : ''}${expectedDelta} tokens（小于 ${MIN_MEANINGFUL} 的判定下限），`
          + `实测 Δ${delta} —— 改动量太小，无法与样本噪声区分。`
          + '要做判定，请把改动写大一些（例如多写几行），再重新验证。',
        delta,
        expected: expectedDelta,
        lowSensitivity: true,
      };
    }
    // 小期望值 + 大实测偏差：这是异常，不是"判不了"，必须说出来
    return {
      verdict: 'undetermined',
      reason: `预期仅 ${expectedDelta >= 0 ? '+' : ''}${expectedDelta} tokens，实测 Δ${delta} —— 两者差距远超改动量本身。`
        + '可能是别的变量在动（换了模型/工具集、会话不是新建的、或基线不新鲜）。'
        + '请先排除这些干扰，再重新验证；不要据此认为改动"生效"或"未生效"。',
      delta,
      expected: expectedDelta,
      lowSensitivity: true,
      anomaly: true,
    };
  }

  // 预期有明显增量，但实测几乎没动（用绝对值：删减改动的"没动"同样是接近 0）→ 未生效
  if (nearZero) {
    return {
      verdict: 'ineffective',
      reason: `预期 ${expectedDelta >= 0 ? '+' : ''}${expectedDelta} tokens，实测 Δ${delta} —— 改动未进入请求`,
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
