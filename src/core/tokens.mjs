/**
 * Token 估算 —— **只是估算，不是验证结论**。
 *
 * 真正的"有没有进 LLM"由 docs/verification.md 的 token-delta 策略用真实会话判定。
 * 本模块只服务于 preview 阶段的"代价预告"。
 */

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * 粗估 token 数。
 * 规则：CJK 字符 ≈ 1 token/字；其余按字符数 / 4 估。
 * @param {string} text
 * @returns {{tokens:number, cjk:number, other:number, chars:number}}
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { tokens: 0, cjk: 0, other: 0, chars: 0 };
  }
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk += 1;
    else other += 1;
  }
  return {
    tokens: cjk + Math.ceil(other / 4),
    cjk,
    other,
    chars: text.length,
  };
}

/**
 * 代价预告：给出估算区间与"缓存代价"提示。
 * @param {{before:string, after:string}} p
 */
export function estimateCost({ before, after }) {
  const b = estimateTokens(before);
  const a = estimateTokens(after);
  const delta = a.tokens - b.tokens;
  return {
    before: b.tokens,
    after: a.tokens,
    delta,
    /** 尾段通道改动 = 该会话历史缓存清零（见 docs/framework.md 缓存代价） */
    cacheNote: delta === 0
      ? '无 token 变化'
      : '改的是 user-context 尾段：本会话后续请求需重新预热缓存（一次性全价，之后自愈）。建议在新会话开始前改。',
  };
}
