#!/usr/bin/env node
/**
 * P0 竖切自测 —— 不碰真实用户数据，全部在沙箱 fixture 上跑。
 *
 * 覆盖：六步契约 → 备份/还原 → 三态验证 → 锚点硬报错 → 铁律护栏
 * 运行：node src/selftest.mjs
 *
 * 纪律：**不允许存在空断言**。每个 test 必须真的断言，否则就是"假装成功"。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createEngine } from './core/engine.mjs';
import { registerAll } from './handles/index.mjs';
import { soulHandle } from './handles/personalization.soul.mjs';
import { register } from './core/registry.mjs';
import { assertHandle } from './core/contracts.mjs';
import { storeRoot as defaultStoreRoot, ensureDir, tildify } from './core/paths.mjs';
import { sha256 } from './core/backup.mjs';

let pass = 0;
let fail = 0;
/** @type {{name:string, error:string}[]} */
const failures = [];

function record(name, err) {
  if (err) {
    fail += 1;
    failures.push({ name, error: err.message });
    console.log(`  ❌ ${name}\n       ${err.message}`);
  } else {
    pass += 1;
    console.log(`  ✅ ${name}`);
  }
}

/** @param {string} name @param {() => any} fn */
function test(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error('断言为 false');
    record(name, null);
  } catch (e) { record(name, e); }
}

/** @param {string} name @param {() => Promise<any>} fn */
async function atest(name, fn) {
  try {
    const r = await fn();
    if (r === false) throw new Error('断言为 false');
    record(name, null);
  } catch (e) { record(name, e); }
}

function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`);
}
function throwsCode(fn, code) {
  try { fn(); } catch (e) {
    if (e.code !== code) throw new Error(`错误码不符（实际 ${e.code}，期望 ${code}）：${e.message}`);
    return e;
  }
  throw new Error(`未抛错（期望 ${code}）`);
}
async function athrowsCode(fn, code) {
  try { await fn(); } catch (e) {
    if (e.code !== code) throw new Error(`错误码不符（实际 ${e.code}，期望 ${code}）：${e.message}`);
    return e;
  }
  throw new Error(`未抛错（期望 ${code}）`);
}

// ── fixture（合成内容，**不含任何真实用户文本**）────────────
const fixtureRoot = ensureDir(path.join(defaultStoreRoot(), 'sandbox', `fixture-${Date.now()}`));
const store = ensureDir(path.join(fixtureRoot, '_store'));
const cfg = path.join(fixtureRoot, 'cfg');
const SOUL_REL = path.join('user-1390000000-personal', 'SOUL.md');
const ORIGINAL_SOUL = '# 人设\n\n- 称呼我：测试者\n- 底线：这是自测用的合成内容\n';

function writeFixture() {
  fs.rmSync(cfg, { recursive: true, force: true });
  ensureDir(path.join(cfg, 'app'));
  ensureDir(path.join(cfg, 'user-1390000000-personal'));
  ensureDir(path.join(cfg, 'plugins', 'cache', 'workbuddy-builtin', 'welcomemode-code', '5.9.3-wb.selftest.g0000.h0000'));
  fs.writeFileSync(path.join(cfg, 'app', 'app-config.json'),
    JSON.stringify({ personalization: { toneStyle: 'efficient', customPrompt: '' } }, null, 2));
  fs.writeFileSync(path.join(cfg, 'settings.json'),
    JSON.stringify({ sandbox: { orderedRules: { file: { rules: [] } } } }, null, 2));
  fs.writeFileSync(path.join(cfg, SOUL_REL), ORIGINAL_SOUL);
  fs.writeFileSync(path.join(cfg, 'user-1390000000-personal', 'USER.md'), '');
  fs.writeFileSync(path.join(cfg, 'user-1390000000-personal', 'IDENTITY.md'), '');
  fs.writeFileSync(
    path.join(cfg, 'plugins', 'cache', 'workbuddy-builtin', 'welcomemode-code', '5.9.3-wb.selftest.g0000.h0000', 'prompt.tpl'),
    '<personal_files_safety>fixture</personal_files_safety>',
  );
}

console.log(`\n沙箱 fixture：${tildify(fixtureRoot)}\n（合成内容，未触碰真实用户数据）`);
writeFixture();

const SOUL = path.join(cfg, SOUL_REL);
const NEXT = `${ORIGINAL_SOUL}\n- 追加：自测标记 WBC-SELFTEST-001\n`;

registerAll();
const engine = createEngine({ configRoot: cfg, storeRoot: store });

// ══════════════ 同步断言 ══════════════
console.log('\n【1】版本探测与锚点（铁律 3：不猜）');
test('版本从插件缓存目录探测到 5.9.3', () => eq(engine.resolver.version, '5.9.3', '版本不符'));
test('锚点解析到 SOUL.md', () => {
  ok(engine.resolver.resolve('personal.soul').path.toLowerCase().endsWith('soul.md'), '路径异常');
});
test('未知锚点键 → ANCHOR_MISSING（不猜）', () => {
  throwsCode(() => engine.resolver.resolve('personal.nonexistent'), 'ANCHOR_MISSING');
});
test('配置根无插件缓存 → 拒绝猜测版本', () => {
  const empty = ensureDir(path.join(fixtureRoot, 'empty'));
  throwsCode(() => createEngine({ configRoot: empty, storeRoot: store }), 'ANCHOR_MISSING');
});
test('缺锚点表版本 → ANCHOR_MISSING 且提示新增数据', () => {
  const e = throwsCode(() => createEngine({ configRoot: cfg, storeRoot: store, version: '9.9.9' }), 'ANCHOR_MISSING');
  ok(/新增数据/.test(e.message), '错误信息未提示"新增数据"');
});
test('doctor 全绿（可选锚点缺席不算失败）', () => {
  const d = engine.doctor();
  const badA = d.anchors.filter((a) => !a.ok).map((a) => a.key);
  const badH = d.handles.filter((h) => !h.anchorOk).map((h) => h.id);
  ok(d.ok, `doctor 未通过：锚点[${badA.join(',')}] 把手[${badH.join(',')}]`);
});
test('回归：目标文件缺席时锚点仍可确定（全新安装可用）', () => {
  const fresh = path.join(fixtureRoot, 'fresh');
  fs.rmSync(fresh, { recursive: true, force: true });
  ensureDir(path.join(fresh, 'user-0000000000-personal'));
  ensureDir(path.join(fresh, 'app'));
  ensureDir(path.join(fresh, 'plugins', 'cache', 'workbuddy-builtin', 'welcomemode-code', '5.9.3-wb.selftest.g0000.h0000'));
  fs.writeFileSync(path.join(fresh, 'plugins', 'cache', 'workbuddy-builtin', 'welcomemode-code', '5.9.3-wb.selftest.g0000.h0000', 'prompt.tpl'), 'x');
  const e2 = createEngine({ configRoot: fresh, storeRoot: store });
  const r = e2.resolver.resolve('personal.soul');
  ok(r.path && r.path.toLowerCase().endsWith('soul.md'), '锚点路径仍应可确定');
  eq(r.exists, false, 'SOUL.md 应报告"不存在"，而不是让锚点报错');
  ok(e2.doctor().ok, '全新安装下 doctor 应为绿');
});

console.log('\n【5】铁律护栏（同步）');
test('铁律2：缺 verify 的把手注册被拒', () => {
  throwsCode(() => assertHandle({
    id: 'x', title: 'x', target: 't', writeClass: 'user-data', privilege: 'none',
    channel: 'request-tail', upgradeBehavior: 'survives',
  }), 'HANDLE_CONTRACT');
});
test('尾段通道禁用 marker-trace-grep（截断会假阴性）', () => {
  throwsCode(() => assertHandle({
    id: 'x', title: 'x', target: 't', writeClass: 'user-data', privilege: 'none',
    channel: 'request-tail', upgradeBehavior: 'survives',
    verification: { strategy: 'marker-trace-grep', channel: 'request-tail', baseline: 'b', assertion: 'a' },
  }), 'HANDLE_CONTRACT');
});
test('死把手不得注册（extraAllowWrite 那类）', () => {
  throwsCode(() => assertHandle({
    id: 'x', title: 'x', target: 't', writeClass: 'user-data', privilege: 'none',
    channel: 'config-value', upgradeBehavior: 'dead',
    verification: { strategy: 'readback-after-restart', channel: 'config-value', baseline: 'b', assertion: 'a' },
  }), 'HANDLE_CONTRACT');
});
test('重复注册同 id 被拒', () => {
  throwsCode(() => register({
    id: 'personalization.soul', title: 'dup', target: 'personal.soul', writeClass: 'user-data',
    privilege: 'none', channel: 'request-tail', upgradeBehavior: 'survives',
    verification: { strategy: 'token-delta', channel: 'request-tail', baseline: 'b', assertion: 'a' },
  }), 'HANDLE_CONTRACT');
});
test('回归：verification（名词声明）与 verify()（动词方法）不再同名冲突', () => {
  ok(typeof soulHandle.verify === 'function', 'verify 应为动词方法');
  ok(soulHandle.verification && typeof soulHandle.verification === 'object', 'verification 应为名词声明');
  assertHandle(soulHandle); // 不应抛错 —— 曾经这里必定失败
});

// ══════════════ 异步断言（真实走六步）══════════════
console.log('\n【2】六步 · 探测 / 预览（实测）');
await atest('probe 读到原文并给出 sha256/字节/token', async () => {
  const p = await engine.probe('personalization.soul');
  eq(p.state.text, ORIGINAL_SOUL, '内容不符');
  ok(p.state.exists, '应为存在');
  ok(p.state.bytes > 0, '字节数应为正');
  eq(p.state.sha256, sha256(Buffer.from(ORIGINAL_SOUL, 'utf8')), 'sha256 不符');
  ok(p.state.tokens.tokens > 0, '估算 token 应为正');
});

const plan = await engine.plan('personalization.soul', { next: NEXT });
await atest('plan 给出差异、token 代价、缓存提示', async () => {
  ok(plan.preview.diff.added >= 1, '应至少有 1 行新增');
  ok(plan.preview.cost.delta > 0, 'token 增量应为正');
  ok(String(plan.preview.diffText).includes('WBC-SELFTEST-001'), '差异文本应含标记');
  ok(/预热|新会话|缓存/.test(plan.preview.cost.cacheNote), `缓存提示异常：${plan.preview.cost.cacheNote}`);
});
await atest('plan 对用户目录把手不要求额外确认', async () => eq(plan.needsConfirm, false, '不应要求确认'));
await atest('plan 对"需新会话"给出闸门提示', async () => {
  ok(plan.gate.warnings.length > 0, '应给出新会话提示');
  eq(plan.gate.blocked, false, '不应被阻断');
});

console.log('\n【3】apply → backup → restore（实测）');
const applied = await engine.apply('personalization.soul', { next: NEXT, reason: 'selftest' });
await atest('apply 返回备份 id', async () => ok(applied.backupId, '缺 backupId'));
await atest('写入后内容已变', async () => eq(fs.readFileSync(SOUL, 'utf8'), NEXT, '内容未更新'));
await atest('备份内容 = 改动前内容（sha256 一致）', async () => {
  const dir = path.join(store, 'backups', applied.backupId);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const stored = fs.readFileSync(path.join(dir, m.entries[0].stored));
  eq(sha256(stored), sha256(Buffer.from(ORIGINAL_SOUL, 'utf8')), '备份 sha 与原文不符');
});
await atest('台账已记录 apply（含备份引用）', async () => {
  ok(engine.audit().some((r) => r.event === 'apply' && r.backupId === applied.backupId), '台账缺 apply');
});

console.log('\n【4】验证三态（不得合并，禁止把"无法判定"显示成成功）');
const v1 = await engine.verify('personalization.soul', {});
await atest('无会话数据 → undetermined', async () => eq(v1.verdict, 'undetermined', `应为 undetermined：${v1.reason}`));
const v2 = await engine.verify('personalization.soul', { baselineTokens: 1000, observedTokens: 1523, expectedDelta: 523 });
await atest('增量吻合 → effective', async () => eq(v2.verdict, 'effective', `应为 effective：${v2.reason}`));
const v3 = await engine.verify('personalization.soul', { baselineTokens: 1000, observedTokens: 1000, expectedDelta: 523 });
await atest('预期有增量但实测为 0 → ineffective', async () => eq(v3.verdict, 'ineffective', `应为 ineffective：${v3.reason}`));
const v4 = await engine.verify('personalization.soul', { baselineTokens: 1000, observedTokens: 5000, expectedDelta: 523 });
await atest('增量异常 → undetermined（不硬判生效）', async () => eq(v4.verdict, 'undetermined', `应为 undetermined：${v4.reason}`));
await atest('验证结果已入台账', async () => {
  ok(engine.audit().filter((r) => r.event === 'verify').length >= 4, '台账 verify 记录不足');
});

console.log('\n【3b】还原');
const restored = engine.restore(applied.backupId);
await atest('restore 回到原文', async () => {
  eq(fs.readFileSync(SOUL, 'utf8'), ORIGINAL_SOUL, '未还原');
  eq(restored.changed.length, 1, '应有 1 项变化');
});
await atest('restore 预演不写盘，但报告漂移', async () => {
  fs.writeFileSync(SOUL, 'TEMP-DRIFT');
  const dry = engine.restore(applied.backupId, { dryRun: true });
  eq(fs.readFileSync(SOUL, 'utf8'), 'TEMP-DRIFT', '预演不应写盘');
  ok(dry.results[0].drift, '应报告漂移');
  engine.restore(applied.backupId);
  eq(fs.readFileSync(SOUL, 'utf8'), ORIGINAL_SOUL, '二次还原失败');
});

console.log('\n【6】静默截断约束（recon-amendments 新增约束 1：10 000 字符）');
await atest('probe 报告注入上限，当前内容未超限', async () => {
  const p = await engine.probe('personalization.soul');
  eq(p.state.limits.maxChars, 10000, '上限应为 10000');
  eq(p.state.limits.exceeded, false, '当前内容不应超限');
  ok(p.state.limits.injectedTokens > 0, '应给出注入后的估算 token');
});
await atest('超过上限的写入 → preview 出告警并报丢弃字符数', async () => {
  const pl = await engine.plan('personalization.soul', { next: 'A'.repeat(12000) });
  eq(pl.preview.truncated, true, '应标记截断');
  eq(pl.preview.dropped, 2000, '丢弃字符数应为 2000');
  ok(pl.preview.warnings.some((w) => /超出注入上限/.test(w)), '应给出超限告警');
});
await atest('期望增量按截断后文本计算 —— 不是全量（否则误导验证）', async () => {
  const pl = await engine.plan('personalization.soul', { next: 'A'.repeat(12000) });
  const fullEstimate = 12000 / 4;      // 'A' 非 CJK：约 4 字符/token
  ok(pl.preview.expectedDeltaTokens < fullEstimate - 100,
    `不应基于全量文本（实测期望 ${pl.preview.expectedDeltaTokens}，全量约 ${fullEstimate}）`);
  ok(pl.preview.expectedDeltaTokens <= 10000 / 4 + 5,
    `应基于截断后文本（实测期望 ${pl.preview.expectedDeltaTokens}）`);
});
await atest('模式可达性已声明（SOUL 两模式均注入）', async () => {
  eq(soulHandle.modeAvailability.normal, true, '普通模式应可达');
  eq(soulHandle.modeAvailability.expert, true, '专家模式应可达');
  ok(/IDENTITY/.test(soulHandle.modeAvailability.note), '应注明与 IDENTITY.md 的模式差异');
});

console.log('\n【5】铁律5：厂商文件逐次确认（实测）');
register({
  id: 'test.vendor',
  title: '合成厂商文件把手',
  target: 'config.appConfig',
  writeClass: 'vendor-file',
  privilege: 'none',
  channel: 'config-value',
  upgradeBehavior: 'survives',
  verification: { strategy: 'readback-after-restart', channel: 'config-value', baseline: 'b', assertion: 'a' },
  async probe() { return { exists: true, text: '{}', bytes: 2, exists_: true }; },
  async apply() { return { ok: true, bytes: 2 }; },
  async verify() { return { verdict: 'undetermined', reason: 'stub' }; },
});
await atest('厂商文件写入未确认 → CONFIRMATION_REQUIRED', async () => {
  await athrowsCode(() => engine.apply('test.vendor', { next: '{}' }), 'CONFIRMATION_REQUIRED');
});
await atest('厂商文件写入带确认 → 通过且自动备份', async () => {
  const r = await engine.apply('test.vendor', { next: '{"x":1}', confirm: true });
  ok(r.backupId, '缺备份 id');
});

// ══════════════ 汇总 ══════════════
console.log('\n────────────────────────────────');
console.log(`通过 ${pass}   失败 ${fail}`);
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  ❌ ${f.name}\n     ${f.error}`);
  process.exitCode = 1;
} else {
  console.log('✅ P0 竖切自测全部通过');
}
console.log(`\n沙箱：${tildify(fixtureRoot)}（可删）`);
