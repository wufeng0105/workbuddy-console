/**
 * 后端自测（补充）—— 零依赖，node --test 直接跑。
 *
 * 为什么要单独一个文件：`src/selftest.mjs` 是 150 条的竖切自测，跑在合成 fixture 上；
 * 这里补的是**纯函数级**的三态判定断言——它们不需要 fixture，但必须守住
 * `token-delta` 的判定语义（这是"B 为魂"最关键的一环，判错方向就是误报）。
 *
 * 由来（如实登记）：2026-11-02 的独立复核发现 T4 的修复**零断言覆盖**——
 * 把新分支改成 `if (false)` 自测仍全绿；同时还发现负期望增量永远判不出 effective。
 * 两条现在都由本文件守住。
 *
 * 运行：node --test test/token-delta.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTokenDelta } from '../src/verify/token-delta.mjs';

/* ══════════ 基本三态 ══════════ */

test('缺基线或缺观测 → undetermined（不硬判）', () => {
  assert.equal(evaluateTokenDelta({}).verdict, 'undetermined');
  assert.equal(evaluateTokenDelta({ baselineTokens: 1000 }).verdict, 'undetermined');
  assert.equal(evaluateTokenDelta({ observedTokens: 1000 }).verdict, 'undetermined');
});

test('缺理论增量 → undetermined（不能只凭实测 Δ 下结论）', () => {
  const r = evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 1200 });
  assert.equal(r.verdict, 'undetermined');
  assert.match(r.reason, /理论增量/);
});

test('增量吻合 → effective', () => {
  assert.equal(evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 1060, expectedDelta: 60 }).verdict, 'effective');
});

test('预期有明显增量、实测几乎为 0 → ineffective', () => {
  assert.equal(evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 1001, expectedDelta: 60 }).verdict, 'ineffective');
});

test('增量偏差过大 → undetermined（不硬判生效）', () => {
  assert.equal(evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 1600, expectedDelta: 60 }).verdict, 'undetermined');
});

/* ══════════ 负期望增量（删减改动）— 曾经的硬缺陷 ══════════ */

test('删内容的改动必须能判出 effective（负 expectedDelta）', () => {
  /**
   * 曾经的缺陷：`if (delta <= SMALL_NOISE)` 用的是**带符号** delta。
   * 删 60 token 时实测 Δ-60，`-60 <= 3` 成立 → 被判成"改动未进入请求"（ineffective）。
   * 后果：**任何"删内容"的改动永远判不出生效**。真实场景里 apply 缩短 SOUL
   * 得到的 expectedDeltaTokens 就是负数（identity-file.mjs 的差值算法）。
   */
  const r = evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 940, expectedDelta: -60 });
  assert.equal(r.verdict, 'effective', `实测 Δ-60 / 预期 -60 应判生效，实际 ${r.verdict}：${r.reason}`);
});

test('删得多也照样能判 effective', () => {
  const r = evaluateTokenDelta({ baselineTokens: 1200, observedTokens: 1000, expectedDelta: -200 });
  assert.equal(r.verdict, 'effective');
});

test('删了但实测没动 → ineffective（负方向也要能判负）', () => {
  const r = evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 1000, expectedDelta: -60 });
  assert.equal(r.verdict, 'ineffective');
});

/* ══════════ 小增量降级 — T4 的正确形态 ══════════ */

test('小增量且实测≈0 → undetermined（不假装确定）', () => {
  // 注意：|expectedDelta| <= SMALL_NOISE(3) 时走的是更早的"预期无变化"分支，
  // 那不是"判不了"，而是**本来就等于没变**（1 token 连噪声都不算）—— 那里判 effective 是对的。
  // 本用例只覆盖超出噪声、但未达判定下限（4..19）的两难区间。
  for (const exp of [4, 7, 19, -4, -7, -19]) {
    const r = evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 1000, expectedDelta: exp });
    assert.equal(r.verdict, 'undetermined', `expectedDelta=${exp} 应判无法判定，实际 ${r.verdict}`);
  }
});

test('极小的期望增量（|Δ|≤3）按"无变化"处理，判 effective', () => {
  for (const exp of [0, 1, 2, 3, -2]) {
    const r = evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 1000, expectedDelta: exp });
    assert.equal(r.verdict, 'effective', `expectedDelta=${exp} 本就在噪声带内，应判生效，实际 ${r.verdict}`);
  }
});

test('小增量但实测严重跑飞 → undetermined 且**必须**说这是异常', () => {
  /**
   * 曾经的缺陷：期望 +19、实测 -3000（样本完全跑飞），
   * 却被描述成"改动量太小，无法与样本噪声区分"——理由与事实相反，
   * 把一个本该报警的异常降级成了"判不了"。
   */
  const r = evaluateTokenDelta({ baselineTokens: 1000, observedTokens: -2000, expectedDelta: 19 });
  assert.equal(r.verdict, 'undetermined');
  assert.doesNotMatch(r.reason, /样本噪声/, '实测偏差巨大时不许说是"噪声"');
  assert.match(r.reason, /其它变量|别的变量|异常|干扰/, '必须提示这是异常，不能轻描淡写');
  assert.equal(r.anomaly, true, '应带 anomaly 标记供上层区分');
});

test('小增量但实测与期望吻合 → effective（不能把"吻合"也吞成"判不了"）', () => {
  /**
   * 这条是被 selftest 的既有断言抓出来的真实缺口：
   * 期望 +12、实测 Δ+12（完全吻合），第一版修法却判 undetermined ——
   * 理由是"增量太小无法与噪声区分"，但样本明明就是按预期动了。
   * 小增量只降低**置信度**（所以 reason 里要提示敏感度低），不改变"动了就是动了"这一事实。
   */
  const r = evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 1012, expectedDelta: 12 });
  assert.equal(r.verdict, 'effective', `实测与预期吻合应判生效，实际 ${r.verdict}：${r.reason}`);
  assert.match(r.reason, /敏感度低/, '但必须如实提示敏感度低');
  assert.equal(r.lowSensitivity, true);
});

test('小增量吻合的负方向也要判 effective', () => {
  const r = evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 988, expectedDelta: -12 });
  assert.equal(r.verdict, 'effective');
});

test('阈值边界：20 是判定下限（19 判不了，20 能判）', () => {
  const under = evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 1000, expectedDelta: 19 });
  assert.equal(under.verdict, 'undetermined');
  const at = evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 1000, expectedDelta: 20 });
  assert.equal(at.verdict, 'ineffective', '达到下限就该给出"未生效"的结论');
});

/* ══════════ 零变更 ══════════ */

test('预期无变化 + 实测无变化 → effective（不是"无法判定"）', () => {
  assert.equal(evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 1000, expectedDelta: 0 }).verdict, 'effective');
});

test('预期无变化 + 实测有明显变化 → undetermined（有别的东西在动）', () => {
  assert.equal(evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 1100, expectedDelta: 0 }).verdict, 'undetermined');
});
