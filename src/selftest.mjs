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
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createEngine } from './core/engine.mjs';
import { registerAll } from './handles/index.mjs';
import { soulHandle } from './handles/personalization.soul.mjs';
import { register, list as registryList } from './core/registry.mjs';
import { assertHandle } from './core/contracts.mjs';
import { storeRoot as defaultStoreRoot, ensureDir, tildify } from './core/paths.mjs';
import { sha256 } from './core/backup.mjs';
import { readAudit } from './core/audit.mjs';

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

/**
 * 剥掉 JS 源码里的 `/* … *\/` 块注释与 `//` 行注释（**字符串字面量里的内容原样保留**）。
 *
 * 为什么需要它：D5 曾经直接对源码正则，于是"只把 `confirm: true` 写进注释里、
 * 真调用里删掉"就能骗过它（独立复核 inj16）——注释不是证据。
 *
 * 为什么不用正则：正则分不清 `//` 是注释还是字符串里的两个字符（`'http://…'`）。
 * 这里用一个小状态机；块注释里的换行**保留**，免得行号/边界跑掉。
 * 已知边界：模板字符串里的 `${…}` 表达式按字符串内容处理（其中的 `//` 不会被剥），
 * 对本用途（找 `confirm: true` 这类实参）足够。
 * @param {string} src
 */
function stripJsComments(src) {
  let out = '';
  let mode = 'code';   // code | line | block | s | d | t
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    const nx = src[i + 1];
    if (mode === 'code') {
      if (ch === '/' && nx === '*') { mode = 'block'; i += 2; continue; }
      if (ch === '/' && nx === '/') { mode = 'line'; i += 2; continue; }
      if (ch === "'") mode = 's';
      else if (ch === '"') mode = 'd';
      else if (ch === '`') mode = 't';
      out += ch; i += 1; continue;
    }
    if (mode === 'line') {
      if (ch === '\n') { mode = 'code'; out += ch; }
      i += 1; continue;
    }
    if (mode === 'block') {
      if (ch === '*' && nx === '/') { mode = 'code'; i += 2; continue; }
      if (ch === '\n') out += ch;   // 保留换行
      i += 1; continue;
    }
    // 字符串模式（'s' | 'd' | 't'）
    if (ch === '\\') { out += ch + (nx ?? ''); i += 2; continue; }
    if ((mode === 's' && ch === "'") || (mode === 'd' && ch === '"') || (mode === 't' && ch === '`')) mode = 'code';
    out += ch; i += 1;
  }
  return out;
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
  // C 组三个模式都要有，否则 prompt.welcomemode-* 的锚点会红、doctor 全绿断言失效
  for (const mode of ['code', 'work', 'design']) {
    ensureDir(path.join(cfg, 'plugins', 'cache', 'workbuddy-builtin', `welcomemode-${mode}`, '5.9.3-wb.selftest.g0000.h0000'));
  }
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

// 安装目录 fixture（style 七档）—— 必须在任何 createEngine 之前就位，
// 否则 style.* 把手的 resolveTarget 会因锚点未命中而让 doctor 变红。
const installRoot = ensureDir(path.join(fixtureRoot, 'install'));
const styleDir = ensureDir(path.join(installRoot, 'resources', 'app.asar.unpacked', 'resources', 'templates', 'style'));
const STYLE_TEXTS = {
  creative: `天马行空：${'想象力叙事流，把解题当冒险，用比喻设景，适度 emoji。'.repeat(8)}`,
  efficient: '高效务实：先答案后背景，列表优先。',
  friendly: '亲和友善：先共情再确认，结尾鼓励并邀请追问。',
  professional: '专业严谨：结论先行，量化表达，区分事实与观点。',
  sarcastic: '毒舌吐槽：讽刺开场但只 roast 想法不 roast 人，收尾再补一刀。',
  socratic: '启发引导：先问你怎么想，提示分级，最后才给答案。',
  straightforward: '直言不讳：第一句就是结论，坏主意直说。',
};
for (const [id, text] of Object.entries(STYLE_TEXTS)) {
  fs.writeFileSync(path.join(styleDir, `style-${id}.md`), text, 'utf8');
}
process.env.WORKBUDDY_CONSOLE_INSTALL_DIR = installRoot;

/**
 * 最初基线账本必须指向沙箱，**绝不许落进项目目录 `baselines/`**。
 *
 * 曾经的坑（T8）：自测直接调 `captureBaseline()`，而账本目录默认是项目 `baselines/`，
 * 于是每跑一次自测就在真实账本目录里留下一本 `5.9.3(0000).json`（内容是"自测用的合成内容"），
 * UI 还会把它当成一套真账本显示出来。这不是"测试脏"，是"测试污染了用户数据"。
 *
 * 必须在任何 createEngine / captureBaseline 之前设置。
 */
const fixtureBaselines = ensureDir(path.join(fixtureRoot, 'baselines'));
process.env.WORKBUDDY_BASELINES_DIR = fixtureBaselines;

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
test('插件缓存目录在、但无任何合法版本目录 → ANCHOR_MISSING（不猜版本）', () => {
  /**
   * 覆盖洞由来（独立复核 inj02）：`detectVersion` 有两个 "探测失败" 出口 ——
   *   `core/anchor.mjs:77` 插件缓存目录**不存在**（上一条断言已覆盖，inj02b 红）；
   *   `core/anchor.mjs:88` 目录**在**、但里面没有任何 `x.y.z-` 版本目录 —— **无覆盖**：
   *   把它改成 `return '5.9.3'`（猜一个版本）自测仍全绿。
   *
   * 脏插件缓存目录（装了非插件目录 / 版本目录被清空）就会走到这个出口。
   * 铁律 3：探测失败 = 硬报错，绝不回退到猜测值。
   */
  const dirty = path.join(fixtureRoot, 'dirty-plugin-cache');
  fs.rmSync(dirty, { recursive: true, force: true });
  const pluginDir = ensureDir(path.join(dirty, 'plugins', 'cache', 'workbuddy-builtin', 'welcomemode-code'));
  fs.writeFileSync(path.join(pluginDir, 'README.txt'), '这个目录不是版本目录', 'utf8');
  ensureDir(path.join(pluginDir, 'not-a-version'));   // 目录名不匹配 ^\d+\.\d+\.\d+-
  const e = throwsCode(() => createEngine({ configRoot: dirty, storeRoot: store }), 'ANCHOR_MISSING');
  ok(/版本/.test(e.message), `错误信息应说明版本探测失败，实际：${e.message}`);
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
  // 全新安装也有三个 welcomemode 插件（否则 prompt.* 把手必然红灯）
  for (const mode of ['code', 'work', 'design']) {
    const d = ensureDir(path.join(fresh, 'plugins', 'cache', 'workbuddy-builtin', `welcomemode-${mode}`, '5.9.3-wb.fresh.g0000.h0000'));
    fs.writeFileSync(path.join(d, 'prompt.tpl'), 'x', 'utf8');
  }
  const e2 = createEngine({ configRoot: fresh, storeRoot: store });
  const r = e2.resolver.resolve('personal.soul');
  ok(r.path && r.path.toLowerCase().endsWith('soul.md'), '锚点路径仍应可确定');
  eq(r.exists, false, 'SOUL.md 应报告"不存在"，而不是让锚点报错');
  const bad = e2.doctor().handles.filter((h) => !h.anchorOk).map((h) => h.id);
  eq(bad.length, 0, `全新安装下 doctor 应为绿，失败：${bad.join(',')}`);
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
/**
 * 合成厂商文件把手 —— 目标是**独立 fixture 文件**，不是 config.appConfig。
 *
 * 为什么不能用 config.appConfig（实测踩过）：那是 toneStyle / customPrompt 的真实目标，
 * 这个 stub 往里写 `_stub` 字段会把后面的十几条个性化断言连锁打红。
 *
 * 为什么 apply 必须真的写盘：引擎现在比对"目标文件字节变没变"来判 noop（D4 修法），
 * stub 不写就会被判 noop、备份不建，测的就不是"写入成功"而是"stub 没实现"。
 */
const VENDOR_STUB_FILE = path.join(fixtureRoot, 'vendor-stub.txt');
fs.writeFileSync(VENDOR_STUB_FILE, 'v0', 'utf8');
let vendorStubSeq = 0;
register({
  id: 'test.vendor',
  title: '合成厂商文件把手',
  target: 'config.appConfig',
  resolveTarget: () => ({ key: 'test.vendorFile', path: VENDOR_STUB_FILE }),
  writeClass: 'vendor-file',
  privilege: 'none',
  channel: 'config-value',
  upgradeBehavior: 'survives',
  verification: { strategy: 'readback-after-restart', channel: 'config-value', baseline: 'b', assertion: 'a' },
  writesWholeFile: true,
  async probe() {
    const text = fs.existsSync(VENDOR_STUB_FILE) ? fs.readFileSync(VENDOR_STUB_FILE, 'utf8') : '';
    return { path: VENDOR_STUB_FILE, exists: true, text, bytes: Buffer.byteLength(text, 'utf8') };
  },
  async apply(ctx, { next = '' } = {}) {
    // 每次写不同内容，避免被正确判成 noop（noop 时引擎不建备份 → 本断言就会误红）
    vendorStubSeq += 1;
    const body = `${next}#${vendorStubSeq}`;
    fs.writeFileSync(VENDOR_STUB_FILE, body, 'utf8');
    return { ok: true, bytes: Buffer.byteLength(body, 'utf8') };
  },
  async verify() { return { verdict: 'undetermined', reason: 'stub' }; },
});
await atest('厂商文件写入未确认 → CONFIRMATION_REQUIRED', async () => {
  await athrowsCode(() => engine.apply('test.vendor', { next: '{}' }), 'CONFIRMATION_REQUIRED');
});
await atest('厂商文件写入带确认 → 通过且自动备份', async () => {
  const r = await engine.apply('test.vendor', { next: '{"x":1}', confirm: true });
  ok(r.backupId, '缺备份 id');
});

// ══════════════ P0b：token-delta 自动对照 ══════════════
console.log('\n【7】token-delta 自动对照（P0b：从 trace 自动取基线/观测）');

const tracesDir = path.join(cfg, 'traces');

/** 造一个像样的 trace 文件（结构与本机实测一致） */
function writeTrace(worker, name, startedAtIso, model, promptTokens, opts = {}) {
  const dir = ensureDir(path.join(tracesDir, worker));
  const body = {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, finish_reason: opts.finishReason ?? 'stop', message: { role: 'assistant', content: 'OK' } }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 4,
      total_tokens: promptTokens + 4,
      prompt_tokens_details: { cached_tokens: 128 },
    },
  };
  const lines = [
    JSON.stringify({ type: 'trace_start', traceId: 'T-1' }),
    JSON.stringify({
      type: 'span_end',
      span: {
        traceId: 'T-1', spanId: `S-${worker}-${name}`, name: 'generation', type: 'llm',
        status: 'ok', startedAt: startedAtIso, endedAt: startedAtIso,
        toolOutput: JSON.stringify(body),
      },
    }),
  ];
  fs.writeFileSync(path.join(dir, name), `${lines.join('\n')}\n`, 'utf8');
}

const CHAT_MODEL = 'minimax-m3.1-flash';
const TITLE_MODEL = 'wb-lite';

const applyRec = engine.audit().filter((r) => r.event === 'apply' && r.handle === 'personalization.soul').at(-1);
const applyAtMs = Date.parse(applyRec.at);
const EXP = applyRec.expectedDeltaTokens;

await atest('台账记录了期望增量（供自动对照）', async () => ok(EXP > 0, `期望增量应为正，实际 ${EXP}`));

// ── 纯函数：会话选择规则（不依赖文件系统）──
await atest('pickSessions：取会话**首条**请求（同会话后续轮含累积历史，不可作基线）', async () => {
  const { pickSessions } = await import('./verify/auto-capture.mjs');
  const gens = [
    { worker: 'X', atMs: 100, promptTokens: 1000, isChat: true, finishReason: 'stop', model: CHAT_MODEL },
    { worker: 'X', atMs: 200, promptTokens: 1400, isChat: true, finishReason: 'stop', model: CHAT_MODEL },
    { worker: 'Y', atMs: 400, promptTokens: 1100, isChat: true, finishReason: 'stop', model: CHAT_MODEL },
  ];
  const p = pickSessions(gens, 300, () => null);
  eq(p.baselineSession.first.promptTokens, 1000, '基线应取 X 的首条（1000），不是后续轮（1400）');
  eq(p.observedSession.first.promptTokens, 1100, '观测应取 Y 的首条');
  eq(p.baselineSession.startSource, 'request-gap', '无目录时间时应标注为次优信号');
});
await atest('pickSessions：排除非聊天、0 tokens、content_filter 异常样本', async () => {
  const { pickSessions } = await import('./verify/auto-capture.mjs');
  const gens = [
    { worker: 'A', atMs: 100, promptTokens: 1000, isChat: true, finishReason: 'stop', model: CHAT_MODEL },
    { worker: 'B', atMs: 110, promptTokens: 517, isChat: false, finishReason: 'stop', model: TITLE_MODEL },
    { worker: 'C', atMs: 120, promptTokens: 0, isChat: true, finishReason: 'content_filter', model: CHAT_MODEL },
  ];
  const p = pickSessions(gens, 50, () => null);
  eq(p.chatCount, 1, '只应剩 1 条可信样本');
  eq(p.excludedCount, 2, '应记录 2 条被排除');
});

// ── 端到端：会话起点由注入的时钟决定（避免依赖目录创建时间）──
const SESS = new Map();
const startOf = (w) => SESS.get(w) ?? null;
const engineB = createEngine({ configRoot: cfg, storeRoot: store, sessionStartOf: startOf });

// S1：改动前的会话；首条 1000，后续轮累积到 1400
SESS.set('111', applyAtMs - 120000);
writeTrace('111', 'r1.jsonl', new Date(applyAtMs - 115000).toISOString(), CHAT_MODEL, 1000);
writeTrace('111', 'r2.jsonl', new Date(applyAtMs - 100000).toISOString(), CHAT_MODEL, 1400);
// S2：改动后新建的会话 → 唯一合法的观测点
SESS.set('222', applyAtMs + 5000);
writeTrace('222', 'r1.jsonl', new Date(applyAtMs + 10000).toISOString(), CHAT_MODEL, 1000 + EXP);
writeTrace('222', 'title.jsonl', new Date(applyAtMs + 11000).toISOString(), TITLE_MODEL, 517);
// S3：**改动前**就已创建的会话，改动后才发请求 → 内容仍是旧的，绝不可是观测点
SESS.set('333', applyAtMs - 60000);
writeTrace('333', 'late.jsonl', new Date(applyAtMs + 20000).toISOString(), CHAT_MODEL, 1000);

await atest('readGenerations 读出全部记录并标记非聊天', async () => {
  const { readGenerations } = await import('./core/trace.mjs');
  const recs = readGenerations(cfg);
  eq(recs.length, 5, `应读到 5 条，实际 ${recs.length}`);
  eq(recs.filter((r) => !r.isChat).length, 1, '标题生成应为 1 条');
  eq(recs.filter((r) => r.isChat)[0].cachedTokens, 128, '应读出 cached_tokens');
});

const autoRes = await engineB.verify('personalization.soul');
await atest('自动对照 → 取会话首条并判为 effective', async () => {
  eq(autoRes.verdict, 'effective', `应为 effective：${autoRes.reason}`);
  eq(autoRes.evidence.basis, 'session-first-request', '应标明以会话首条为基准');
  eq(autoRes.evidence.observed.promptTokens, 1000 + EXP, '观测 token 不符');
  eq(autoRes.evidence.excludedSamples, 1, '应记录被排除的样本数');
});
await atest('损坏的假阴性：改动前创建的会话即使请求更晚，也不当观测点', async () => {
  eq(autoRes.evidence.observed.worker, '222', `观测必须来自改动后新建的会话，实际 ${autoRes.evidence.observed.worker}`);
  ok(autoRes.evidence.observed.sessionStart > autoRes.evidence.baseline.sessionStart, '观测会话起点应晚于基线会话');
});

await atest('旧会话继续发消息 → 明确要求新建会话（不给含糊结论）', async () => {
  const { autoCapture } = await import('./verify/auto-capture.mjs');
  fs.rmSync(tracesDir, { recursive: true, force: true });
  SESS.clear();
  SESS.set('111', applyAtMs - 120000);
  writeTrace('111', 'r1.jsonl', new Date(applyAtMs - 115000).toISOString(), CHAT_MODEL, 1000);
  writeTrace('111', 'r2.jsonl', new Date(applyAtMs + 20000).toISOString(), CHAT_MODEL, 1000); // 旧会话续聊，无增量
  const cap = autoCapture({ configRoot: cfg, applyAtMs, expectedDelta: EXP, sessionStartOf: startOf });
  ok(cap.blockedReason !== null, '应阻断而不是判"未生效"');
  ok(/新建/.test(cap.blockedReason), `应指导新建会话：${cap.blockedReason}`);
});

await atest('改动前没有会话 → undetermined（无法取基线）', async () => {
  const { autoCapture } = await import('./verify/auto-capture.mjs');
  const cap = autoCapture({ configRoot: cfg, applyAtMs: 0, expectedDelta: EXP, sessionStartOf: startOf });
  ok(cap.blockedReason !== null, '应给出阻断原因');
  ok(/基线/.test(cap.blockedReason), `应说明缺基线：${cap.blockedReason}`);
});

await atest('无 trace 目录 → undetermined，不崩', async () => {
  const { autoCapture } = await import('./verify/auto-capture.mjs');
  const cap = autoCapture({ configRoot: path.join(fixtureRoot, 'fresh'), applyAtMs, expectedDelta: EXP });
  ok(cap.blockedReason !== null, '应给出阻断原因');
});

await atest('跨模型自动隔离：只会用同一模型的样本，并告警排除了多少', async () => {
  const { autoCapture } = await import('./verify/auto-capture.mjs');
  fs.rmSync(tracesDir, { recursive: true, force: true });
  SESS.clear();
  SESS.set('111', applyAtMs - 120000);
  SESS.set('222', applyAtMs + 5000);
  // 基线用 minimax，观测故意用另一个模型 → 应被排除，导致"找不到观测"
  writeTrace('111', 'base.jsonl', new Date(applyAtMs - 115000).toISOString(), CHAT_MODEL, 1000);
  writeTrace('222', 'obs.jsonl', new Date(applyAtMs + 10000).toISOString(), 'other-model', 1000 + EXP);

  const cap = autoCapture({ configRoot: cfg, applyAtMs, expectedDelta: EXP, sessionStartOf: startOf });
  // 观测被排除 → 报"没有新会话"，而不是拿另一个模型硬比
  ok(cap.blockedReason !== null, '跨模型时应阻断而不是硬比');
  ok(/新建/.test(cap.blockedReason ?? ''), `应指导用户：${cap.blockedReason}`);
});

await atest('跨模型：有同模型样本时优先用同模型，并如实报告排除了多少', async () => {
  const { autoCapture } = await import('./verify/auto-capture.mjs');
  fs.rmSync(tracesDir, { recursive: true, force: true });
  SESS.clear();
  SESS.set('111', applyAtMs - 120000);
  SESS.set('222', applyAtMs + 5000);
  SESS.set('333', applyAtMs + 8000);
  writeTrace('111', 'base.jsonl', new Date(applyAtMs - 115000).toISOString(), CHAT_MODEL, 1000);
  writeTrace('222', 'other.jsonl', new Date(applyAtMs + 6000).toISOString(), 'other-model', 9999);
  writeTrace('333', 'obs.jsonl', new Date(applyAtMs + 10000).toISOString(), CHAT_MODEL, 1000 + EXP);

  const cap = autoCapture({ configRoot: cfg, applyAtMs, expectedDelta: EXP, sessionStartOf: startOf });
  eq(cap.blockedReason, null, `不应阻断：${cap.blockedReason}`);
  eq(cap.evidence.targetModel, CHAT_MODEL, `应锁定同一模型，实际 ${cap.evidence.targetModel}`);
  eq(cap.evidence.observed.worker, '333', `应跳过 other-model，实际观测来自 ${cap.evidence.observed.worker}`);
  eq(cap.evidence.observed.promptTokens, 1000 + EXP, '观测 token 应来自同模型那一次');
  ok(cap.evidence.otherModelsExcluded >= 1, '应报告排除了其它模型样本');
  ok(cap.warnings.some((w) => /其它模型|跨模型/.test(w)), `应告警：${JSON.stringify(cap.warnings)}`);
});

// ══════════════ P1a：个性化五项 ══════════════
console.log('\n【8】P1a · 个性化五项（SOUL / USER / IDENTITY / toneStyle / customPrompt）');

// 安装目录 fixture 已在 setup 阶段建好（见文件顶部），此处直接复用

const APP_CONFIG = path.join(cfg, 'app', 'app-config.json');

await atest('五项个性化把手全部注册且锚点可解析', async () => {
  const d = engineB.doctor();
  const want = [
    'personalization.soul', 'personalization.user', 'personalization.identity',
    'personalization.tone-style', 'personalization.custom-prompt',
  ];
  const have = d.handles.map((h) => h.id);
  const missing = want.filter((id) => !have.includes(id));
  eq(missing.length, 0, `缺把手：${missing.join(',')}`);
  const bad = d.handles.filter((h) => !h.anchorOk).map((h) => h.id);
  eq(bad.length, 0, `锚点应全部可解析，失败：${bad.join(',')}`);
});

await atest('安装目录锚点命中（候选根探测 + 环境变量覆盖）', async () => {
  const a = engineB.resolver.resolve('templates.style');
  ok(a.path.includes('style'), `style 目录应命中，实际 ${a.path}`);
  eq(a.exists, true, '应存在');
});

await atest('模式可达性已按文件区分（IDENTITY 在专家模式下不注入）', async () => {
  const list = (await import('./handles/index.mjs')).ALL_HANDLES;
  const byId = Object.fromEntries(list.map((h) => [h.id, h]));
  eq(byId['personalization.identity'].modeAvailability.expert, false, 'IDENTITY 专家模式应为不可达');
  eq(byId['personalization.soul'].modeAvailability.expert, true, 'SOUL 专家模式应可达');
  eq(byId['personalization.user'].modeAvailability.expert, true, 'USER 专家模式应可达');
});

console.log('\n   ── toneStyle（JSON 字段 + 枚举守卫）──');
await atest('toneStyle probe 读到当前取值 efficient', async () => {
  const p = await engineB.probe('personalization.tone-style');
  eq(p.state.value, 'efficient', '取值不符');
  eq(p.state.valueValid, true, '取值应合法');
  eq(p.state.allowedValues.length, 7, '枚举应为 7 档');
});
await atest('非法取值 → 拒绝（拦住"写成功但风格消失"的静默失败）', async () => {
  await athrowsCode(() => engineB.plan('personalization.tone-style', { next: 'super-cool' }), 'INVALID_VALUE');
});
await atest('带尾随换行的取值 → 按 collector 的 trim 行为规范化后接受（不误拒）', async () => {
  const pl = await engineB.plan('personalization.tone-style', { next: 'creative\r\n' });
  eq(pl.preview.valueAfter, 'creative', '取值应被规范化');
  ok(pl.preview.warnings.some((w) => /规范化/.test(w)), `应如实告知已规范化：${JSON.stringify(pl.preview.warnings)}`);
});
await atest('换档位 → 期望增量 = 两个 style 文件的 token 差（不是字符串长度差）', async () => {
  const pl = await engineB.plan('personalization.tone-style', { next: 'creative' });
  ok(pl.preview.expectedDeltaTokens > 0, `应给出正增量，实际 ${pl.preview.expectedDeltaTokens}`);
  ok(pl.preview.injectedChars === STYLE_TEXTS.creative.length, '注入字符数应等于 style 文件长度');
  ok(/style/.test(pl.preview.cost.cacheNote) || pl.preview.cost.delta > 0, '应给出版本换档的代价');
});
await atest('toneStyle apply 只改该字段，其余键逐字不动', async () => {
  const before = fs.readFileSync(APP_CONFIG, 'utf8');
  await engineB.apply('personalization.tone-style', { next: 'creative' });
  const after = fs.readFileSync(APP_CONFIG, 'utf8');
  const bj = JSON.parse(before);
  const aj = JSON.parse(after);
  eq(aj.personalization.toneStyle, 'creative', '取值应已更新');
  eq(aj.personalization.customPrompt, bj.personalization.customPrompt, 'customPrompt 不应被动');
  eq(Object.keys(aj).join(','), Object.keys(bj).join(','), '顶层键不应变化');
  // 规范 JSON → 允许重序列化；除该值外应逐字一致
  eq(after, before.replace('"efficient"', '"creative"'), '规范 JSON 下应只有该值变化');
});

console.log('\n   ── customPrompt（JSON 字段）──');
await atest('customPrompt probe → plan → apply 走通，且增量 = 字段值本身', async () => {
  const p0 = await engineB.probe('personalization.custom-prompt');
  eq(p0.state.value, '', '初始应为空串');
  const NEXT_CP = '回答尽量简洁，先给结论。';
  const pl = await engineB.plan('personalization.custom-prompt', { next: NEXT_CP });
  ok(pl.preview.expectedDeltaTokens > 0, '应给出正增量');
  ok(pl.preview.warnings.some((w) => /长度上限/.test(w)) === false, '不应误报截断');
  await engineB.apply('personalization.custom-prompt', { next: NEXT_CP });
  const after = JSON.parse(fs.readFileSync(APP_CONFIG, 'utf8'));
  eq(after.personalization.customPrompt, NEXT_CP, '字段应已写入');
  eq(after.personalization.toneStyle, 'creative', 'toneStyle 不应被动');
});

console.log('\n   ── JSON 写入的格式保全（纯函数）──');
await atest('非规范 JSON → 定向替换，其余字节逐字不变', async () => {
  const { writeField } = await import('./handles/json-field.mjs');
  const src = '{"a":1,  "personalization":{"toneStyle":"efficient","customPrompt":"x"},"b":[1,2]}';
  const w = writeField(src, 'personalization', 'toneStyle', 'creative');
  eq(w.mode, 'targeted', '应走定向替换而非重排');
  eq(w.text, '{"a":1,  "personalization":{"toneStyle":"creative","customPrompt":"x"},"b":[1,2]}',
    '其余字节必须逐字不变');
});
await atest('规范 JSON → 走重序列化，结果仍逐字可控', async () => {
  const { writeField } = await import('./handles/json-field.mjs');
  const src = `${JSON.stringify({ personalization: { toneStyle: 'efficient' } }, null, 2)}\n`;
  const w = writeField(src, 'personalization', 'toneStyle', 'creative');
  eq(w.mode, 'reserialize', '规范 JSON 应走重序列化');
  eq(w.text, src.replace('"efficient"', '"creative"'), '除该值外应逐字一致');
});
await atest('字段不存在 → 插入，且不破坏原结构', async () => {
  const { writeField } = await import('./handles/json-field.mjs');
  const w = writeField('{"personalization":{"toneStyle":"efficient"}}', 'personalization', 'customPrompt', 'hello');
  eq(JSON.parse(w.text).personalization.customPrompt, 'hello', '应插入成功');
  eq(JSON.parse(w.text).personalization.toneStyle, 'efficient', '不应破坏已有字段');
  eq(w.mode, 'inserted', '应走定向插入（而非整篇重排）');
});

console.log('\n   ── USER / IDENTITY 走六步 ──');
await atest('USER.md 六步走通（写入 + 备份 + 还原）', async () => {
  const NEXT_USER = '- **Name:** 测试者\n';
  const userPath = path.join(cfg, 'user-1390000000-personal', 'USER.md');
  const appliedUser = await engineB.apply('personalization.user', { next: NEXT_USER });
  eq(fs.readFileSync(userPath, 'utf8'), NEXT_USER, '应已写入');
  engineB.restore(appliedUser.backupId);
  eq(fs.readFileSync(userPath, 'utf8'), '', '应已还原');
});
await atest('IDENTITY.md 的 preview 会提示"专家模式下不注入"', async () => {
  const pl = await engineB.plan('personalization.identity', { next: '- **Name:** 小助手\n' });
  ok(pl.preview.warnings.some((w) => /专家模式/.test(w)), `应给出模式告警：${JSON.stringify(pl.preview.warnings)}`);
});

// ══════════════ P0c：控制台服务端（HTTP 冒烟）══════════════
console.log('\n【9】P0c · 本地控制台服务端（HTTP 冒烟，含鉴权与真实走链）');

const { createConsoleServer } = await import('./server.mjs');
const consoleApp = createConsoleServer({ configRoot: cfg, storeRoot: store });
const listened = await consoleApp.listen(0);
const BASE = `http://127.0.0.1:${listened.port}`;
const AUTH = { 'X-WBC-Token': consoleApp.token };
const JSON_CT = { 'Content-Type': 'application/json' };

await atest('无令牌 → 401；正确令牌 → doctor 返回 5 把手', async () => {
  const r1 = await fetch(`${BASE}/api/doctor`);
  eq(r1.status, 401, '无令牌应 401');
  const r2 = await fetch(`${BASE}/api/doctor`, { headers: AUTH });
  eq(r2.status, 200, '带令牌应 200');
  const j = await r2.json();
  eq(j.ok, true, 'ok 应为 true');
  ok(j.data.handles.length >= 5, `应返回至少 5 个把手，实际 ${j.data.handles.length}`);
});
await atest('错误令牌 → 401', async () => {
  const r = await fetch(`${BASE}/api/doctor`, { headers: { 'X-WBC-Token': 'definitely-wrong-token' } });
  eq(r.status, 401, '错误令牌应 401');
});
await atest('静态首页可访问且含标题', async () => {
  const r = await fetch(`${BASE}/`);
  eq(r.status, 200, '首页应 200');
  const html = await r.text();
  ok(html.includes('WorkBuddy 控制台'), '首页内容不符');
});
await atest('未知接口 → 404 且带稳定错误码', async () => {
  const r = await fetch(`${BASE}/api/nope`, { headers: AUTH });
  eq(r.status, 404, '应 404');
  const j = await r.json();
  eq(j.error.code, 'NOT_FOUND', '错误码不符');
});
await atest('probe → plan → apply → verify → restore 经 HTTP 全链走通', async () => {
  const probe = await (await fetch(`${BASE}/api/handle/personalization.soul/probe`, { headers: AUTH })).json();
  const next = `${probe.data.state.text}\n- HTTP-SMOKE\n`;
  const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: { ...AUTH, ...JSON_CT }, body: JSON.stringify(body) });

  const plan = await (await post('/api/handle/personalization.soul/plan', { next })).json();
  ok(plan.data.preview.diff.added >= 1, 'plan 应给出差异');

  const ap = await (await post('/api/handle/personalization.soul/apply', { next })).json();
  ok(ap.data.backupId, 'apply 应返回备份 id');

  const v = await (await post('/api/handle/personalization.soul/verify', {})).json();
  eq(v.data.verdict, 'undetermined', '无会话数据时应如实报 undetermined');

  // 还原是写操作（T10）：不确认必须被拒，确认后才还原
  const noConfirm = await post('/api/restore', { backupId: ap.data.backupId });
  eq(noConfirm.status, 400, '不带 confirm 的还原应被拒（400）');
  const noConfirmBody = await noConfirm.json();
  eq(noConfirmBody.error.code, 'CONFIRMATION_REQUIRED', '应回可判定的错误码');
  ok(fs.readFileSync(SOUL, 'utf8') !== ORIGINAL_SOUL, '被拒时不许动文件');

  const dry = await (await post('/api/restore', { backupId: ap.data.backupId, dryRun: true })).json();
  eq(dry.data.changed.length, 1, '预演应报出将发生的 1 项变化');
  eq(fs.readFileSync(SOUL, 'utf8') !== ORIGINAL_SOUL, true, '预演不许写盘');

  const rs = await (await post('/api/restore', { backupId: ap.data.backupId, confirm: true })).json();
  eq(rs.data.changed.length, 1, '应还原 1 项');
  eq(fs.readFileSync(SOUL, 'utf8'), ORIGINAL_SOUL, 'fixture 文件应还原到原文');
});
await atest('厂商文件经 HTTP 写入仍需 confirm（铁律 5）', async () => {
  const r = await fetch(`${BASE}/api/handle/test.vendor/apply`, {
    method: 'POST', headers: { ...AUTH, ...JSON_CT }, body: JSON.stringify({ next: '{}' }),
  });
  eq(r.status, 400, '未确认应被拒（400）');
  const j = await r.json();
  eq(j.error.code, 'CONFIRMATION_REQUIRED', '错误码不符');
});
await atest('档位接口经 HTTP 全链走通（save → list → plan → apply → verify → delete）', async () => {
  const post = (p, body) => fetch(`${BASE}${p}`, {
    method: 'POST', headers: { ...AUTH, ...JSON_CT }, body: JSON.stringify(body),
  });
  const saved = await (await post('/api/profiles/save', { name: 'HTTP档位', id: 'selftest-http' })).json();
  eq(saved.data.id, 'selftest-http', 'id 不符');
  eq(Object.keys(saved.data.values).length, 4, '应覆盖 4 个把手（含当前生效的风格内容）');

  const list = await (await fetch(`${BASE}/api/profiles`, { headers: AUTH })).json();
  ok(list.data.some((p) => p.id === 'selftest-http'), '列表应含新档位');

  const plan = await (await post('/api/profiles/plan', { id: 'selftest-http' })).json();
  eq(plan.data.items.length, 4, '预览应覆盖 4 个把手');
  eq(plan.data.needsConfirm, true, '含厂商文件 → 需要确认');

  const refused = await post('/api/profiles/apply', { id: 'selftest-http' });
  eq(refused.status, 400, '未确认应被拒');
  eq((await refused.json()).error.code, 'CONFIRMATION_REQUIRED', '错误码不符');

  const ap = await (await post('/api/profiles/apply', { id: 'selftest-http', confirm: true })).json();
  ok(ap.data.backupId, '切换应产生备份');
  eq(ap.data.files, 3, '应覆盖 3 个文件');

  const v = await (await post('/api/profiles/verify', { id: 'selftest-http' })).json();
  eq(v.data.verdict, 'undetermined', '无会话数据时应如实报 undetermined');

  const del = await (await post('/api/profiles/delete', { id: 'selftest-http' })).json();
  eq(del.data.deleted, true, '应删除成功');
});

await consoleApp.close();

// ══════════════ P1b：专家档位（多把手事务）══════════════
console.log('\n【10】P1b · 专家档位（一次切换 = 一次备份 = 一个期望增量）');

const APP_CFG = path.join(cfg, 'app', 'app-config.json');
const hashOf = (p) => sha256(fs.readFileSync(p));

// 先把现状设成 X 并采集为档位 A
await engineB.apply('personalization.tone-style', { next: 'creative' });
await engineB.apply('personalization.custom-prompt', { next: 'X-档位的指令' });

let profileA;
await atest('采集档位：从当前实际状态吸回源（chezmoi 的 re-add 语义）', async () => {
  profileA = await engineB.captureProfile({ name: '自测档位A', id: 'selftest-a' });
  eq(profileA.id, 'selftest-a', 'id 不符');
  eq(Object.keys(profileA.values).length, 4, '应覆盖 4 个把手（3 项个性化 + 当前生效的风格内容）');
  eq(profileA.values['personalization.tone-style'], 'creative', 'toneStyle 应采到当前值');
  eq(profileA.values['personalization.custom-prompt'], 'X-档位的指令', 'customPrompt 应采到当前值');
  eq(profileA.values['personalization.soul'], ORIGINAL_SOUL, 'SOUL 应采到当前内容');
  eq(profileA.values['style.creative'], STYLE_TEXTS.creative, '应采到当前生效档位的风格全文');
});
await atest('档位存进用户数据目录，不在仓库内', async () => {
  const f = path.join(store, 'profiles', 'selftest-a.json');
  ok(fs.existsSync(f), `档位文件应在 ${f}`);
  ok(!f.includes('recon-baseline'), '不应落在历史目录');
});

// 把现状改成 Y，再切回档位 A
await engineB.apply('personalization.tone-style', { next: 'efficient' });
await engineB.apply('personalization.custom-prompt', { next: 'Y-另一套指令' });
const ySoul = hashOf(SOUL);
const yCfg = hashOf(APP_CFG);
const yStyle = hashOf(path.join(styleDir, 'style-creative.md'));

await atest('档位预览：逐把手差异 + 合计期望增量', async () => {
  const pl = await engineB.planProfile('selftest-a');
  eq(pl.items.length, 4, '应给出 4 个把手的差异');
  ok(pl.items.every((i) => typeof i.diffText === 'string'), '每项都应有差异文本');
  ok(Number.isFinite(pl.expectedDeltaTokens), '应有合计期望增量');
  eq(pl.needsConfirm, true, '含厂商文件（style 内容）→ 需要确认');
});

let appliedProfile;
await atest('含厂商文件的档位：未确认 → 整体拒绝，且一个文件都没动', async () => {
  const soulNow = hashOf(SOUL);
  const cfgNow = hashOf(APP_CFG);
  await athrowsCode(() => engineB.applyProfile('selftest-a'), 'CONFIRMATION_REQUIRED');
  eq(hashOf(SOUL), soulNow, '拒绝后 SOUL.md 不应被改');
  eq(hashOf(APP_CFG), cfgNow, '拒绝后 app-config.json 不应被改');
});
await atest('切换档位：一次备份覆盖全部文件（同文件只备一次）', async () => {
  appliedProfile = await engineB.applyProfile('selftest-a', { confirm: true });
  ok(appliedProfile.backupId, '缺备份 id');
  eq(appliedProfile.files, 3, `应覆盖 3 个文件（SOUL.md + app-config.json + style-creative.md），实际 ${appliedProfile.files}`);
  const m = JSON.parse(fs.readFileSync(path.join(store, 'backups', appliedProfile.backupId, 'manifest.json'), 'utf8'));
  eq(m.entries.length, 3, 'manifest 应含 3 个条目（按绝对路径去重）');
  eq(new Set(m.entries.map((e) => e.absPath)).size, 3, '不应有重复条目');
});
await atest('切换后实际状态 == 档位 A 的内容（含风格全文）', async () => {
  const tp = await engineB.probe('personalization.tone-style');
  const cp = await engineB.probe('personalization.custom-prompt');
  const sp = await engineB.probe('personalization.soul');
  const st = await engineB.probe('style.creative');
  eq(tp.state.value, 'creative', 'toneStyle 应回到 creative');
  eq(cp.state.value, 'X-档位的指令', 'customPrompt 应回到 X');
  eq(sp.state.text, ORIGINAL_SOUL, 'SOUL 应回到档位 A 的内容');
  eq(st.state.text, STYLE_TEXTS.creative, '风格全文应回到档位 A 的内容');
});
await atest('切换后台账记录为 apply-profile（含合计期望增量）', async () => {
  const rec = engineB.audit().filter((r) => r.event === 'apply-profile').at(-1);
  ok(rec, '应有 apply-profile 记录');
  eq(rec.profile, 'selftest-a', '档位 id 不符');
  eq(rec.backupId, appliedProfile.backupId, '备份引用不符');
  ok(Number.isFinite(rec.expectedDeltaTokens), '应记录合计期望增量');
});
await atest('一次还原把整套档位收回切换前状态（三个文件都回）', async () => {
  engineB.restore(appliedProfile.backupId);
  eq(hashOf(SOUL), ySoul, 'SOUL.md 应逐字节回到切换前');
  eq(hashOf(APP_CFG), yCfg, 'app-config.json 应逐字节回到切换前');
  eq(hashOf(path.join(styleDir, 'style-creative.md')), yStyle, 'style-creative.md 应逐字节回到切换前');
});
await atest('档位验证：没有可用会话时如实报 undetermined，不编造结论', async () => {
  // 清掉【7】留下的 fixture trace（它们带未来时间戳，会污染本节的会话归属判断）
  fs.rmSync(tracesDir, { recursive: true, force: true });
  const v = await engineB.verifyProfile('selftest-a');
  eq(v.verdict, 'undetermined', `应为 undetermined：${v.reason}`);
  ok(/会话|新建/.test(v.reason), `应给出可执行的下一步：${v.reason}`);
});
await atest('档位切换是事务：厂商文件把手会被整体拒绝（而非部分写入）', async () => {
  const bad = { id: 'selftest-bad', name: '含厂商文件', values: { 'test.vendor': '{}' } };
  await athrowsCode(() => engineB.applyProfile(bad), 'CONFIRMATION_REQUIRED');
});
await atest('删除档位', async () => {
  const r = engineB.removeProfile('selftest-a');
  eq(r.deleted, true, '应删除');
  eq(engineB.profiles().some((p) => p.id === 'selftest-a'), false, '列表里不应再有');
});

// ══════════════ P1c：style 档位内容（厂商文件）══════════════
console.log('\n【11】P1c · style 档位内容把手（安装目录 / 厂商文件 / 升级失效）');

await atest('七个 style 把手全部注册且锚点可解析', async () => {
  const d = engineB.doctor();
  const ids = d.handles.map((h) => h.id).filter((x) => x.startsWith('style.'));
  eq(ids.length, 7, `应有 7 个 style 把手，实际 ${ids.length}`);
  const bad = d.handles.filter((h) => !h.anchorOk).map((h) => h.id);
  eq(bad.length, 0, `锚点应全部可解析：${bad.join(',')}`);
});

await atest('resolveTarget 按 id 定位到各自的 style 文件（静态锚点表达不了）', async () => {
  const h = engineB.doctor().handles.find((x) => x.id === 'style.socratic');
  ok(h.anchorPath.endsWith('style-socratic.md'), `路径不符：${h.anchorPath}`);
});

await atest('probe 辨识"是否为当前生效档位"', async () => {
  const active = await engineB.probe('style.efficient');
  eq(active.state.isActive, true, 'efficient 应为当前生效档位');
  eq(active.state.writeAccess, true, 'fixture 文件应可写');
  const other = await engineB.probe('style.socratic');
  eq(other.state.isActive, false, 'socratic 未生效');
  eq(other.state.activeStyle, 'efficient', '应报出生效档位');
});

await atest('非生效档位：preview 明确告警"改了不影响请求"，期望增量为 0', async () => {
  const pl = await engineB.plan('style.socratic', { next: 'SOC-新内容' });
  eq(pl.preview.expectedDeltaTokens, 0, '非生效档位期望增量应为 0');
  ok(pl.preview.warnings.some((w) => /当前未生效/.test(w)), `应告警：${JSON.stringify(pl.preview.warnings)}`);
});

await atest('非生效档位：verify 判 undetermined（前置条件不成立），绝不判"未生效"', async () => {
  const v = await engineB.verify('style.socratic', { baselineTokens: 1000, observedTokens: 1000, expectedDelta: 0 });
  eq(v.verdict, 'undetermined', `应为 undetermined：${v.reason}`);
  ok(/当前未生效|前置条件/.test(v.reason), `应说明前置条件：${v.reason}`);
});

await atest('生效档位：期望增量 = 新旧内容 token 差', async () => {
  const pl = await engineB.plan('style.efficient', { next: `${STYLE_TEXTS.efficient}追加一句。` });
  ok(pl.preview.expectedDeltaTokens > 0, `应给出正增量，实际 ${pl.preview.expectedDeltaTokens}`);
});

await atest('厂商文件：未确认 → 拒绝写入（铁律 5）', async () => {
  await athrowsCode(() => engineB.apply('style.efficient', { next: 'X' }), 'CONFIRMATION_REQUIRED');
});

await atest('厂商文件：带确认 → 写入 + 备份 + 逐字节还原', async () => {
  const p = path.join(styleDir, 'style-efficient.md');
  const before = hashOf(p);
  const ap = await engineB.apply('style.efficient', { next: '新的高效档内容', confirm: true });
  eq(fs.readFileSync(p, 'utf8'), '新的高效档内容', '应已写入');
  ok(hashOf(p) !== before, '内容应已变化');
  engineB.restore(ap.backupId);
  eq(hashOf(p), before, '应逐字节还原');
});

await atest('档位采集默认带上"当前生效"的 style 把手（专家 = 人设 + 表达方式）', async () => {
  const p = await engineB.captureProfile({ name: '带风格内容的档位', id: 'selftest-with-style' });
  const keys = Object.keys(p.values);
  ok(keys.includes('style.efficient'), `应含 style.efficient，实际 ${keys.join(',')}`);
  eq(keys.length, 4, `应覆盖 4 个把手（3 + 生效风格），实际 ${keys.length}`);
  engineB.removeProfile('selftest-with-style');
});

// ══════════════ P2a：C 组提示词模板（请求头部通道 + 标记法验证）══════════════
console.log('\n【12】P2a · C 组提示词模板（版本定位 / 头部通道 / 标记法）');

// 造 C 组插件缓存：双版本并存（低版本 + fixture 已有版本），并注入 content_policy 段
const builtinDir = path.join(cfg, 'plugins', 'cache', 'workbuddy-builtin');
const FIXTURE_VER = '5.9.3-wb.selftest.g0000.h0000';
const FIXTURE_VER_NEXT = '5.9.4-wb.99999999.gdeadbeef.hcafebabe';
const OLD_VER = '5.8.3-wb.41334564.gdb0e9b51.h4da087921e4a';
function seedPromptTpl(mode, versionDir, body) {
  const d = ensureDir(path.join(builtinDir, `welcomemode-${mode}`, versionDir));
  fs.writeFileSync(path.join(d, 'prompt.tpl'), body, 'utf8');
}
const POLICY_TXT = '<personal_files_safety>No-Go Zones / Scan = Read-Only / Vague = Ask First</personal_files_safety>';
for (const mode of ['code', 'work', 'design']) {
  seedPromptTpl(mode, OLD_VER, `旧版 ${mode}\n${POLICY_TXT}\n`);
  seedPromptTpl(mode, FIXTURE_VER, `新版 ${mode}\n${POLICY_TXT}\n`);
}

await atest('三个提示词模板把手注册，doctor 全绿', async () => {
  const d = engineB.doctor();
  const ids = d.handles.map((h) => h.id).filter((x) => x.startsWith('prompt.welcomemode-'));
  eq(ids.length, 3, `应有 3 个模板把手，实际 ${ids.length}`);
  const bad = d.handles.filter((h) => !h.anchorOk).map((h) => h.id);
  eq(bad.length, 0, `锚点应全部可解析：${bad.join(',')}`);
});

await atest('版本定位：挑最高版本目录，双版本并存时不猜', async () => {
  const p = await engineB.probe('prompt.welcomemode-code');
  eq(p.state.version, FIXTURE_VER, `应挑最高版本，实际 ${p.state.version}`);
  eq(p.state.otherVersions.length, 1, '应报告另有 1 个旧版本');
  eq(p.state.otherVersions[0], OLD_VER, '旧版本应为 5.8.3');
});

await atest('识别 content_policy / personal_files_safety 段存在', async () => {
  const p = await engineB.probe('prompt.welcomemode-work');
  eq(p.state.hasPolicy, true, '应识别到 personal_files_safety 段');
});

await atest('通道是请求头部，验证策略必须是标记法（不是 token-delta）', async () => {
  const d = engineB.doctor();
  const h = d.handles.find((x) => x.id === 'prompt.welcomemode-code');
  eq(h.channel, 'request-head', '通道应为 request-head');
  eq(h.verification.strategy, 'marker-trace-grep', '验证策略应为标记法');
  eq(h.verification.channel, 'request-head', '验证通道应为 request-head');
});

await atest('闸门：应用运行中/未确认状态下的保护齐备', async () => {
  const d = engineB.doctor();
  const h = d.handles.find((x) => x.id === 'prompt.welcomemode-code');
  eq(h.writeClass, 'vendor-file', '应为厂商文件（逐次确认）');
  eq(h.upgradeBehavior, 'invalidated', '升级应标记为失效');
});

await atest('删除安全条款时 preview 显著告警', async () => {
  const pl = await engineB.plan('prompt.welcomemode-code', { next: '完全没有任何安全条款的提示词\n' });
  ok(pl.preview.warnings.some((w) => /personal_files_safety/.test(w)),
    `应告警安全条款被移除：${JSON.stringify(pl.preview.warnings)}`);
});

await atest('闸门：应用运行时拒绝写入（而不是写了不生效）', async () => {
  const guarded = createEngine({
    configRoot: cfg, storeRoot: store, sessionStartOf: startOf,
    appStateProbe: () => true, // 模拟"WorkBuddy 正在运行"
  });
  const g = await athrowsCode(
    () => guarded.apply('prompt.welcomemode-code', { next: 'x', confirm: true }),
    'GATE_BLOCKED',
  );
  ok(/正在运行|退出/.test(g.message), `闸门信息应说明原因：${g.message}`);
});

// 真实探测：不再只靠注入假值。这条用例会真的调 tasklist，
// 验证 isWorkBuddyRunning() 至少能给出一个确定的三态之一（而不是崩溃/抛错）。
// 具体是 true 还是 false 取决于运行测试时 WorkBuddy 是否开着 —— 两者都算通过。
await atest('真实进程探测：isWorkBuddyRunning() 返回确定值而非抛错', async () => {
  const { isWorkBuddyRunning } = await import('./core/appstate.mjs');
  const r = isWorkBuddyRunning();
  ok(r === true || r === false || r === 'unknown',
    `应返回 true/false/'unknown'，实际 ${JSON.stringify(r)}（${typeof r}）`);
  console.log(`      实际探测结果：${JSON.stringify(r)}（取决于本机 WorkBuddy 是否在运行）`);
});
await atest('闸门放开 + 未确认 → 仍被铁律 5 拦下', async () => {
  const open = createEngine({
    configRoot: cfg, storeRoot: store, sessionStartOf: startOf, appStateProbe: () => false,
  });
  await athrowsCode(() => open.apply('prompt.welcomemode-code', { next: 'x' }), 'CONFIRMATION_REQUIRED');
});
await atest('厂商文件：带确认 → 写入并逐字节还原', async () => {
  const open = createEngine({
    configRoot: cfg, storeRoot: store, sessionStartOf: startOf, appStateProbe: () => false,
  });
  const tplPath = path.join(builtinDir, 'welcomemode-code', FIXTURE_VER, 'prompt.tpl');
  const before = hashOf(tplPath);
  const ap = await open.apply('prompt.welcomemode-code', { next: `新版 code\n${POLICY_TXT}\n追加一行\n`, confirm: true });
  ok(hashOf(tplPath) !== before, '内容应已变');
  open.restore(ap.backupId);
  eq(hashOf(tplPath), before, '应逐字节还原');
});

console.log('\n   ── 标记法验证（三态）──');
const { buildMarker, verifyMarker } = await import('./verify/marker.mjs');

await atest('buildMarker 生成可辨识标记', async () => {
  const m = buildMarker('WBC-PROBE', 'abc123');
  eq(m, 'WBC-PROBE-abc123', '标记格式不符');
});

await atest('标记法：没有 trace → undetermined（不判失败）', async () => {
  fs.rmSync(tracesDir, { recursive: true, force: true });
  const r = await verifyMarker({ configRoot: cfg, marker: 'WBC-PROBE-abc123' });
  eq(r.verdict, 'undetermined', `应为 undetermined：${r.reason}`);
});

await atest('标记法：trace 里出现标记 → effective', async () => {
  writeTrace('555', 'req.jsonl', new Date().toISOString(), CHAT_MODEL, 1000);
  const f = path.join(tracesDir, '555', 'req.jsonl');
  fs.appendFileSync(f, `\n${JSON.stringify({ type: 'span_start', span: { name: 'generation', body: 'HEAD WBC-PROBE-abc123 tail' } })}\n`, 'utf8');
  const r = await verifyMarker({ configRoot: cfg, marker: 'WBC-PROBE-abc123' });
  eq(r.verdict, 'effective', `应为 effective：${r.reason}`);
  ok(r.hits.length >= 1, '应给出命中位置');
});

await atest('标记法：有请求但无标记 → ineffective（且给出排查方向）', async () => {
  fs.rmSync(path.join(tracesDir, '555', 'req.jsonl'), { force: true });
  writeTrace('666', 'req2.jsonl', new Date().toISOString(), CHAT_MODEL, 1000);
  const r = await verifyMarker({ configRoot: cfg, marker: 'WBC-PROBE-nothere' });
  eq(r.verdict, 'ineffective', `应为 ineffective：${r.reason}`);
  ok(r.warnings.some((w) => /闸门|活跃|升级/.test(w)), '应给出排查方向');
});

await atest('标记法：只有改动前的 trace、且之后无新请求 → undetermined', async () => {
  fs.rmSync(tracesDir, { recursive: true, force: true }); // 隔离：清掉前面测试留下的 now 时间戳 trace
  const oldAt = new Date(Date.now() - 3600_000).toISOString();
  writeTrace('777', 'old.jsonl', oldAt, CHAT_MODEL, 1000);
  // 带 startedAt 的行 —— 真实 trace 的 span 行都有时间戳
  fs.appendFileSync(path.join(tracesDir, '777', 'old.jsonl'),
    `\n${JSON.stringify({ type: 'span_start', span: { name: 'generation', startedAt: oldAt, body: 'OLD WBC-PROBE-oldonly' } })}\n`, 'utf8');
  const r = await verifyMarker({
    configRoot: cfg, marker: 'WBC-PROBE-oldonly', afterMs: Date.now() - 60_000,
  });
  eq(r.verdict, 'undetermined', `改动后无新请求应判 undetermined：${r.reason}`);
  ok(/还没有新请求/.test(r.reason), `应说明还没发新消息：${r.reason}`);
});
await atest('标记法：旧 trace 有标记 + 新请求无标记 → ineffective（正确判负）', async () => {
  const oldAt = new Date(Date.now() - 3600_000).toISOString();
  // 上面已有 777/old.jsonl（带旧标记）；再加一条"改动后"的新请求
  writeTrace('777', 'new.jsonl', new Date().toISOString(), CHAT_MODEL, 1000);
  const r = await verifyMarker({
    configRoot: cfg, marker: 'WBC-PROBE-oldonly', afterMs: Date.now() - 60_000,
  });
  eq(r.verdict, 'ineffective', `确有新请求且无标记时应判 ineffective：${r.reason}`);
});
await atest('标记法：有标记但无时间戳 → undetermined（不拿文件 mtime 冒充）', async () => {
  fs.rmSync(tracesDir, { recursive: true, force: true });
  writeTrace('888', 'nots.jsonl', new Date().toISOString(), CHAT_MODEL, 1000);
  fs.appendFileSync(path.join(tracesDir, '888', 'nots.jsonl'),
    `\n${JSON.stringify({ body: 'UNDATED WBC-PROBE-nots' })}\n`, 'utf8');
  const r = await verifyMarker({ configRoot: cfg, marker: 'WBC-PROBE-nots', afterMs: Date.now() - 60_000 });
  eq(r.verdict, 'undetermined', `无法判定时间时应为 undetermined：${r.reason}`);
  ok(r.warnings.some((w) => /没有时间戳/.test(w)), '应说明原因');
});

await atest('引擎对头部通道不套用 token-delta 自动对照', async () => {
  fs.rmSync(tracesDir, { recursive: true, force: true });
  const v = await engineB.verify('prompt.welcomemode-code', {});
  eq(v.strategy, 'marker-trace-grep', '应走标记法');
  ok(!v.capture, '不应产生 token-delta 的 capture');
});

await atest('没改过就验证 → undetermined（不是"未生效"）', async () => {
  fs.rmSync(tracesDir, { recursive: true, force: true });
  writeTrace('999', 'x.jsonl', new Date().toISOString(), CHAT_MODEL, 1000);
  const v = await engineB.verify('prompt.welcomemode-work', {});
  eq(v.verdict, 'undetermined', `从未 apply 过应判 undetermined，实际 ${v.verdict}：${v.reason}`);
  ok(/还没有 apply 记录/.test(v.reason), `应说明原因：${v.reason}`);
});

// ══════════════ P2b：规则矩阵（重启后回读）══════════════
console.log('\n【13】P2b · 规则矩阵（结构化操作 / 重启后回读）');

const SETTINGS = path.join(cfg, 'settings.json');
const RULES_FIXTURE = {
  file: [
    { id: 'file-preset-1', source: 'preset', path: '~/.ssh/', isDirectory: true, read: 'ask', write: 'ask', delete: 'ask' },
    { id: 'file-preset-2', source: 'preset', path: '~/.aws/', isDirectory: true, read: 'allow', write: 'ask', delete: 'ask' },
    { id: 'file-preset-3', source: 'preset', path: '~/projects/', isDirectory: true, read: 'allow', write: 'ask', delete: 'ask' },
    { id: 'file-preset-4', source: 'preset', path: '~/notes/', isDirectory: true, read: 'allow', write: 'allow', delete: 'allow' },
  ],
  command: [],
  network: [],
};
function seedSettings() {
  fs.writeFileSync(SETTINGS, `${JSON.stringify({
    sandbox: {
      orderedRules: {
        file: { presetVersion: 4, customized: false, rules: RULES_FIXTURE.file },
        command: { presetVersion: 1, customized: false, rules: [] },
        network: { presetVersion: 1, customized: false, rules: [] },
      },
    },
  }, null, 2)}\n`, 'utf8');
}
seedSettings();

// 规则把手的闸门是 app-must-be-closed；测试里注入"应用已退出"，否则开发机上
// WorkBuddy 真在跑，所有写入都会被正确阻断（那是产品行为，不是缺陷）。
const engineRules = createEngine({
  configRoot: cfg, storeRoot: store, sessionStartOf: startOf, appStateProbe: () => false,
});

await atest('三域规则把手注册，doctor 全绿', async () => {
  const d = engineB.doctor();
  const ids = d.handles.map((h) => h.id).filter((x) => x.startsWith('rules.'));
  eq(ids.length, 3, `应有 3 个规则把手，实际 ${ids.length}`);
  const bad = d.handles.filter((h) => !h.anchorOk).map((h) => h.id);
  eq(bad.length, 0, `锚点应全部可解析：${bad.join(',')}`);
});

await atest('probe 给出规则数与动作分布', async () => {
  const p = await engineRules.probe('rules.file');
  eq(p.state.ruleCount, 4, '规则数不符');
  eq(p.state.summary.write.ask, 3, 'write=ask 应为 3');
  eq(p.state.summary.read.ask, 1, 'read=ask 应为 1');
  eq(p.state.pending.writeAsk, 3, 'pending.writeAsk 不符');
});

await atest('批量操作：只放开 write，不碰 read/delete', async () => {
  const pl = await engineRules.plan('rules.file', { next: { from: 'ask', to: 'allow', actions: ['write'] } });
  eq(pl.preview.changed, 4,
    `应命中 3 条规则 + customized 被翻动 1 处 = 4，实际 ${pl.preview.changed}`);
  // ⚠️ 期望值从 3 改成 4 是 **R40 修复的正确后果**，不是为凑绿而放宽：
  // 旧值 3 编码的正是"少报 customized 那一处"的缺陷行为。这里再钉一条"到底是哪一处"，
  // 免得将来有人把数字改回去了事。
  ok(pl.preview.changedPaths.includes('sandbox.orderedRules.file.customized'),
    `改动清单里必须看得见 customized 那一处：${JSON.stringify(pl.preview.changedPaths.slice(-3))}`);
  ok(pl.preview.diffText.includes('~/.ssh/'), 'diff 应列出命中路径');
});

await atest('批量操作：放开全部动作时给出"删除也会放开"的告警', async () => {
  const pl = await engineRules.plan('rules.file', { next: { from: 'ask', to: 'allow' } });
  ok(pl.preview.warnings.some((w) => /删除类操作也会一起放开/.test(w)),
    `应告警：${JSON.stringify(pl.preview.warnings)}`);
});

await atest('非法动作被拒', async () => {
  await athrowsCode(() => engineRules.plan('rules.file', { next: { from: 'ask', to: 'whatever' } }), 'INVALID_VALUE');
  await athrowsCode(() => engineRules.plan('rules.file', { next: { from: 'ask', to: 'allow', actions: ['rm'] } }), 'INVALID_VALUE');
});

await atest('空域 + 无命中 → 明确报 NO_RULES_MATCHED（不是静默成功）', async () => {
  await athrowsCode(
    () => engineRules.apply('rules.command', { next: { from: 'ask', to: 'allow' } }),
    'NO_RULES_MATCHED',
  );
});

let rulesApply;
await atest('apply：只改 write，其余动作与格式保持不变', async () => {
  const before = fs.readFileSync(SETTINGS, 'utf8');
  rulesApply = await engineRules.apply('rules.file', { next: { from: 'ask', to: 'allow', actions: ['write'] } });
  eq(rulesApply.changed, 4, '应改 3 条规则 + customized 1 处 = 4（R40 修复后计入 customized）');
  const after = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const rules = after.sandbox.orderedRules.file.rules;
  eq(rules.filter((r) => r.write === 'allow').length, 4, '应有 4 条 write=allow');
  eq(rules.find((r) => r.path === '~/.ssh/').delete, 'ask', 'delete 不应被动');
  eq(rules.find((r) => r.path === '~/.ssh/').read, 'ask', 'read 不应被动');
  eq(after.sandbox.orderedRules.file.customized, true, '应标记为已定制');
  eq(Object.keys(after).join(','), Object.keys(JSON.parse(before)).join(','), '顶层键不应变化');
});

await atest('规则矩阵：verify 未重启时判 undetermined（并说明必须重启）', async () => {
  const v = await engineRules.verify('rules.file', {});
  eq(v.verdict, 'undetermined', `应为 undetermined：${v.reason}`);
  eq(v.stage, 'after-write', '阶段应为 after-write');
  ok(/重启/.test(v.reason), `应要求重启：${v.reason}`);
});

await atest('规则矩阵：重启后仍一致 → effective', async () => {
  const v = await engineRules.verify('rules.file', { restarted: true });
  eq(v.verdict, 'effective', `重启后应生效：${v.reason}`);
  eq(v.stage, 'after-restart', '阶段应为 after-restart');
});

await atest('规则矩阵：重启后被还原 → ineffective（extraAllowWrite 那类坑的判据）', async () => {
  // 模拟 WorkBuddy 启动时把规则重置回预设
  seedSettings();
  const v = await engineRules.verify('rules.file', { restarted: true });
  eq(v.verdict, 'ineffective', `被还原时应判 ineffective：${v.reason}`);
  ok(v.warnings.some((w) => /被还原|抹掉/.test(w)), '应指出这是"被抹掉"而非"没写进去"');
});

await atest('规则矩阵进还原链：restore 能收回规则改动', async () => {
  seedSettings();
  const before = hashOf(SETTINGS);
  const ap = await engineRules.apply('rules.file', { next: { from: 'ask', to: 'allow', actions: ['write'] } });
  ok(hashOf(SETTINGS) !== before, '应已改动');
  engineB.restore(ap.backupId);
  eq(hashOf(SETTINGS), before, '应逐字节还原');
});

await atest('按路径定向：只改指定路径的规则', async () => {
  seedSettings();
  const ap = await engineRules.apply('rules.file', {
    next: { from: 'ask', to: 'allow', actions: ['write'], paths: ['~/.ssh/'] },
  });
  eq(ap.changed, 2, '只应改 1 条规则 + customized 1 处 = 2（R40 修复后计入 customized）');
  const rules = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).sandbox.orderedRules.file.rules;
  eq(rules.find((r) => r.path === '~/.ssh/').write, 'allow', '指定路径应被改');
  eq(rules.find((r) => r.path === '~/.aws/').write, 'ask', '其他路径不应被动');
  engineB.restore(ap.backupId);
});

// ══════════════ P2c：版本重放（演进契约）══════════════
console.log('\n【14】P2c · 版本重放（升级后走一遍路线）');

await atest('建重放包：只收 invalidated 的把手，跳过存活的', async () => {
  const r = await engineB.captureBundle();
  const ids = Object.keys(r.bundle.entries);
  ok(ids.includes('style.creative'), `应收录 style.creative，实际 ${ids.join(',')}`);
  ok(ids.includes('prompt.welcomemode-code'), '应收录 prompt.welcomemode-code');
  eq(ids.includes('personalization.soul'), false, 'SOUL.md 是 survives，不应收录');
  ok(r.bundle.skipped.some((s) => s.id === 'personalization.soul' && /survives/.test(s.reason)),
    '应说明跳过原因');
});

await atest('重放包存的是**锚点键**而非绝对路径（升级后路径会变）', async () => {
  const r = await engineB.captureBundle();
  const e = r.bundle.entries['style.creative'];
  eq(e.anchor, 'templates.style', `应存锚点键，实际 ${e.anchor}`);
  ok(e.content.length > 0, '应存全文');
  ok(e.sha256, '应存指纹');
});

await atest('drift：定制都还在 → unchanged，无需重放', async () => {
  await engineB.captureBundle();
  const d = await engineB.checkDrift();
  eq(d.ok, true, '应有重放包');
  eq(d.needReplay.length, 0, `现状应与快照一致，实际需要重放：${d.needReplay.join(',')}`);
  ok(d.results.every((r) => r.kind === 'unchanged'), '应全部为 unchanged');
});

await atest('drift：内容被替换（模拟升级）→ vendor-restored', async () => {
  await engineB.captureBundle();
  const p = path.join(styleDir, 'style-creative.md');
  fs.writeFileSync(p, '升级后变成出厂内容', 'utf8');
  const d = await engineB.checkDrift();
  const r = d.results.find((x) => x.id === 'style.creative');
  eq(r.kind, 'vendor-restored', `应识别为被替换，实际 ${r.kind}`);
  eq(r.severity, 'warn', '应为警告级');
  ok(d.needReplay.includes('style.creative'), '应列入待重放');
});

await atest('重放：未确认的厂商文件 → 拒绝（铁律 5）', async () => {
  await athrowsCode(() => engineB.replay({ only: ['style.creative'] }), 'CONFIRMATION_REQUIRED');
});

/** 把 style-creative.md 恢复成"用户定制"的样子，再建包 —— 保证快照里是好内容 */
async function freshBundle(engine, styleText = STYLE_TEXTS.creative) {
  fs.writeFileSync(path.join(styleDir, 'style-creative.md'), styleText, 'utf8');
  return engine.captureBundle();
}

await atest('重放：带确认 → 把定制灌回 + 一次备份 + 逐字节可还原', async () => {
  const e = createEngine({ configRoot: cfg, storeRoot: store, sessionStartOf: startOf, appStateProbe: () => false });
  await freshBundle(e);
  const p = path.join(styleDir, 'style-creative.md');
  fs.writeFileSync(p, '升级后变成出厂内容', 'utf8'); // 模拟升级替换
  const beforeReplay = hashOf(p);

  const r = await e.replay({ only: ['style.creative'], confirm: true });
  eq(r.replayed.length, 1, '应重放 1 项');
  eq(r.ok, 1, `应成功 1 项，失败 ${r.failed}：${JSON.stringify(r.replayed)}`);
  eq(r.failed, 0, '不应有失败');
  eq(fs.readFileSync(p, 'utf8'), STYLE_TEXTS.creative, '内容应回到快照');
  eq(r.files, 1, '应备份 1 个文件');

  e.restore(r.backupId);
  eq(hashOf(p), beforeReplay, '应能还原到重放前（即被升级替换后的状态）');
});

await atest('重放失败必须如实报告，不得假装成功', async () => {
  const e = createEngine({ configRoot: cfg, storeRoot: store, sessionStartOf: startOf, appStateProbe: () => false });
  await freshBundle(e);
  // 把目标文件删掉 → apply 会失败
  fs.rmSync(path.join(styleDir, 'style-creative.md'), { force: true });
  const r = await e.replay({ only: ['style.creative'], confirm: true });
  eq(r.failed, 1, '失败数应为 1');
  eq(r.ok, 0, '成功数应为 0');
  eq(r.replayed[0].ok, false, '该项应标记失败');
  ok(/不存在|STYLE_FILE/.test(r.replayed[0].error), `错误信息应可读：${r.replayed[0].error}`);
  // 复原
  fs.writeFileSync(path.join(styleDir, 'style-creative.md'), STYLE_TEXTS.creative, 'utf8');
});

await atest('重放后在检测 → 回到 unchanged', async () => {
  const e = createEngine({ configRoot: cfg, storeRoot: store, sessionStartOf: startOf, appStateProbe: () => false });
  await freshBundle(e);
  fs.writeFileSync(path.join(styleDir, 'style-creative.md'), '又被替换了', 'utf8');
  await e.replay({ only: ['style.creative'], confirm: true });
  const d = await e.checkDrift();
  const r = d.results.find((x) => x.id === 'style.creative');
  eq(r.kind, 'unchanged', `重放后应一致，实际 ${r.kind}`);
});

await atest('升级换了版本目录 → 仍能按锚点键重新定位（重放的核心价值）', async () => {
  const e = createEngine({ configRoot: cfg, storeRoot: store, sessionStartOf: startOf, appStateProbe: () => false });
  await freshBundle(e);
  const oldDir = path.join(builtinDir, 'welcomemode-code', FIXTURE_VER);
  const newDir = path.join(builtinDir, 'welcomemode-code', FIXTURE_VER_NEXT);
  ensureDir(newDir);
  fs.writeFileSync(path.join(newDir, 'prompt.tpl'), '升级后的出厂 prompt', 'utf8');
  fs.rmSync(oldDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(styleDir, 'style-creative.md'), '升级后出厂风格', 'utf8');

  const d = await e.checkDrift();
  const promptDrift = d.results.find((x) => x.id === 'prompt.welcomemode-code');
  eq(promptDrift.kind, 'vendor-restored', `新版本目录应被识别为已替换，实际 ${promptDrift.kind}`);
  eq(promptDrift.moved, true, '应标记"路径也变了"');

  const r = await e.replay({ only: ['prompt.welcomemode-code', 'style.creative'], confirm: true });
  eq(r.failed, 0, `重放不应失败：${JSON.stringify(r.replayed.map((x) => x.error))}`);
  eq(fs.readFileSync(path.join(newDir, 'prompt.tpl'), 'utf8'), `新版 code\n${POLICY_TXT}\n`,
    '应灌回到**新**版本目录（按锚点键重新定位）');
  eq(fs.readFileSync(path.join(styleDir, 'style-creative.md'), 'utf8'), STYLE_TEXTS.creative,
    'style 也应灌回');

  // 复原：把版本目录换回去，避免影响后续测试
  fs.rmSync(newDir, { recursive: true, force: true });
  writeFixture();
  for (const mode of ['code', 'work', 'design']) {
    seedPromptTpl(mode, OLD_VER, `旧版 ${mode}\n${POLICY_TXT}\n`);
    seedPromptTpl(mode, FIXTURE_VER, `新版 ${mode}\n${POLICY_TXT}\n`);
  }
});

await atest('没有重放包时 drift/replay 明确报未准备', async () => {
  const emptyStore = ensureDir(path.join(fixtureRoot, 'empty-store'));
  const e3 = createEngine({ configRoot: cfg, storeRoot: emptyStore, sessionStartOf: startOf, appStateProbe: () => false });
  const d = await e3.checkDrift();
  eq(d.ok, false, '没有包时应报 ok=false');
  ok(/重放包/.test(d.reason), `应提示先建包：${d.reason}`);
  await athrowsCode(() => e3.replay({ confirm: true }), 'NO_BUNDLE');
});

await atest('版本探测到未知版本 → 硬报错并提示"新增数据"（升级后第一道关）', async () => {
  const upRoot = path.join(fixtureRoot, 'upgraded');
  fs.rmSync(upRoot, { recursive: true, force: true });
  ensureDir(path.join(upRoot, 'app'));
  ensureDir(path.join(upRoot, 'user-0000000000-personal'));
  ensureDir(path.join(upRoot, 'plugins', 'cache', 'workbuddy-builtin', 'welcomemode-code', FIXTURE_VER_NEXT));
  const e = (() => { try { return { engine: createEngine({ configRoot: upRoot, storeRoot: store }) }; } catch (err) { return { err }; } })();
  ok(e.err, '应当抛错而不是猜一个锚点表');
  eq(e.err.code, 'ANCHOR_MISSING', '错误码应为 ANCHOR_MISSING');
  ok(/新增数据/.test(e.err.message), `应提示新增数据：${e.err.message}`);
  ok(Array.isArray(e.err.detail?.available), '应列出已有版本');
});

// ══════════════ P3：审批自动同意（编排两面）══════════════
console.log('\n【15】P3 · 审批自动同意（规则面 + 提示词面，逐面诚实报告）');

const { applyLevel, detectLevel, parseRules, rulesToDrop } = await import('./core/safety-block.mjs');
const { APPROVAL_LEVELS, previewApproval, combineVerdicts } = await import('./core/approval.mjs');

const FULL_BLOCK = `<personal_files_safety>
**CRITICAL: Operations on personal files are HIGH-RISK.**
**Rules (ALL mandatory, cannot be overridden):**
1. **No-Go Zones.** NEVER recursively delete Desktop, Downloads, Documents, Home.
2. **Scan = Read-Only.** When asked to scan: only generate a report.
3. **Vague = Ask First.** For vague requests, ask the user to specify first.
4. **Warn + List + Confirm.** Before any destructive action, warn and list files.
5. **Back Up First.** Before any move/rename/delete, create a backup.
6. **Trash, Not Delete.** Use OS trash mechanisms. Never rm on personal files.
7. **Small Batches.** Max 10 files per batch.
8. **No Script Files on Windows.** Do not write .ps1/.bat with non-ASCII paths.
</personal_files_safety>`;

await atest('解析出 8 条规则并正确分类语义', async () => {
  const rules = parseRules(FULL_BLOCK);
  eq(rules.length, 8, `应解析 8 条，实际 ${rules.length}`);
  eq(rules[0].semantics.kind, 'redline', '第 1 条应为红线');
  eq(rules[1].semantics.kind, 'ask', '第 2 条应为强制询问');
  eq(rules[4].semantics.kind, 'safety', '第 5 条应为安全网');
});

await atest('档位定义：relaxed 只去 3 条询问，保留红线与安全网', async () => {
  eq(rulesToDrop('off').length, 0, 'off 不应去任何规则');
  eq(rulesToDrop('relaxed').join(','), '2,3,4', 'relaxed 应只去 2/3/4');
  eq(rulesToDrop('aggressive').join(','), '2,3,4,5,6,7', 'aggressive 应去 2/3/4/5/6/7');
});

await atest('应用 relaxed：去掉 3 条询问 + 保留红线 + 重新编号连续', async () => {
  const r = applyLevel(FULL_BLOCK, 'relaxed');
  eq(r.changed, true, '应发生变化');
  eq(r.dropped.join(','), '2,3,4', '应去掉 2/3/4');
  eq(r.kept.length, 5, '应保留 5 条');
  ok(r.text.includes('No-Go Zones'), '红线必须保留');
  ok(r.text.includes('Trash, Not Delete'), '回收站安全网必须保留');
  ok(!r.text.includes('Scan = Read-Only'), '扫描强制询问应去掉');
  // 编号应连续 1..5
  const nums = parseRules(r.text).map((x) => x.num).join(',');
  eq(nums, '1,2,3,4,5', `编号应连续，实际 ${nums}`);
});

await atest('幂等：同一档位重复应用不再变化', async () => {
  const once = applyLevel(FULL_BLOCK, 'relaxed');
  const twice = applyLevel(once.text, 'relaxed');
  eq(twice.changed, false, '第二次应用应无变化');
  eq(twice.text, once.text, '内容应完全一致');
});

await atest('往回切：relaxed → off 不会自动恢复（明确告知而非假装）', async () => {
  const relaxed = applyLevel(FULL_BLOCK, 'relaxed');
  const back = applyLevel(relaxed.text, 'off');
  eq(back.changed, false, '被删掉的规则无法凭空恢复 —— off 档对已放宽的文本是 no-op');
  ok(back.kept.length === 5, '仍只有 5 条');
});

await atest('拒绝：任何档位都不得去掉厂商红线', async () => {
  const noRedline = FULL_BLOCK.replace(/\n1\. \*\*No-Go Zones[\s\S]*?\n/, '\n');
  let threw = false;
  try { applyLevel(noRedline, 'relaxed'); } catch (e) { threw = true; ok(/红线/.test(e.message), e.message); }
  ok(threw, '缺少红线时应拒绝应用档位');
});

await atest('detectLevel 正确识别档位', async () => {
  eq(detectLevel(FULL_BLOCK).level, 'off', '原文应为 off');
  eq(detectLevel(applyLevel(FULL_BLOCK, 'relaxed').text).level, 'relaxed', '放宽后应为 relaxed');
  eq(detectLevel(applyLevel(FULL_BLOCK, 'aggressive').text).level, 'aggressive', '激进后应为 aggressive');
});

await atest('aggressive 会告警"安全网被去掉"', async () => {
  const r = applyLevel(FULL_BLOCK, 'aggressive');
  ok(r.warnings.some((w) => /先备份|回收站|小批量/.test(w)), `应告警：${JSON.stringify(r.warnings)}`);
  ok(r.text.includes('No-Go Zones'), '红线仍必须保留');
  ok(!r.text.includes('Trash, Not Delete'), '回收站条款应被去掉');
});

await atest('previewApproval：规则面标记为"可可靠验证"，提示词面标记为"无法保证"', async () => {
  const p = previewApproval({
    level: 'relaxed',
    rulesProbe: { rules: [
      { path: '~/.ssh/', read: 'allow', write: 'ask', delete: 'ask' },
      { path: '~/.aws/', read: 'allow', write: 'ask', delete: 'ask' },
    ] },
    promptText: FULL_BLOCK,
  });
  const rules = p.faces.find((x) => x.face === 'rules');
  const prompt = p.faces.find((x) => x.face === 'prompt');
  eq(rules.certainty, 'reliable', '规则面应标记为可可靠验证');
  eq(prompt.certainty, 'uncertain', '提示词面应标记为无法保证');
  eq(rules.changed, 2, '应命中 2 条 write=ask');
  eq(p.faceCount ?? p.faces.length, 2, '应有两面');
});

await atest('combineVerdicts：任一面未生效 → ineffective', async () => {
  const r = combineVerdicts({ ruleVerdict: 'effective', promptVerdict: 'ineffective', ruleChanged: true, promptChanged: true });
  eq(r.verdict, 'ineffective', '应为 ineffective');
});
await atest('combineVerdicts：有面无法判定 → undetermined（不合并成成功）', async () => {
  const r = combineVerdicts({ ruleVerdict: 'effective', promptVerdict: 'undetermined', ruleChanged: true, promptChanged: true });
  eq(r.verdict, 'undetermined', '应为 undetermined');
  ok(/提示词面/.test(r.reason), '应指明是哪个面');
  ok(/无法证明模型不再自己问/.test(r.reason), '应说明根因');
});
await atest('combineVerdicts：两面都成立 → effective 但仍带保留说明', async () => {
  const r = combineVerdicts({ ruleVerdict: 'effective', promptVerdict: 'effective', ruleChanged: true, promptChanged: true });
  eq(r.verdict, 'effective', '应为 effective');
  ok(/不表示模型一定不再问/.test(r.reason), '必须保留那句免责说明');
});

console.log('\n   ── 引擎层：真实编排 ──');

/** 每个编排测试前把两个面都恢复到"原厂"，避免测试间相互污染 */
function resetApprovalFixture() {
  for (const mode of ['code', 'work', 'design']) {
    seedPromptTpl(mode, FIXTURE_VER, `新版 ${mode}\n${FULL_BLOCK}\n`);
  }
  seedSettings();
}

await atest('approvalState 读出现状（三模板档位 + 规则分布）', async () => {
  resetApprovalFixture();
  const s = await engineB.approvalState();
  eq(s.levels.length, 3, '应有 3 个档位');
  eq(s.prompts.length, 3, '应有 3 个提示词模板');
  ok(s.rules.ok, '规则面应可读');
  ok(Number.isInteger(s.rules.pending.writeAsk), '应给出 write=ask 计数');
  for (const p of s.prompts) {
    if (p.error) continue;
    eq(p.level.level, 'off', `${p.handle} 应处于原厂档，实际 ${p.level.level}`);
  }
});

await atest('planApproval relaxed：两面都给出，且都不误解为"完全可靠"', async () => {
  resetApprovalFixture();
  const p = await engineB.planApproval('relaxed');
  eq(p.level, 'relaxed', '档位不符');
  const rules = p.faces.find((x) => x.face === 'rules');
  const prompt = p.faces.find((x) => x.face === 'prompt');
  ok(rules.changed > 0, `规则面应命中，实际 ${rules.changed}`);
  eq(prompt.changed, 3, '提示词面应去掉 3 条');
  eq(prompt.certainty, 'uncertain', '提示词面必须标记为不确定');
  eq(p.maxCertainty, 'partial', '总体只能是 partial');
});

await atest('未知档位被拒', async () => {
  await athrowsCode(() => engineB.planApproval('yolo'), 'INVALID_VALUE');
});

await atest('applyApproval off：什么都不改', async () => {
  resetApprovalFixture();
  const r = await engineB.applyApproval('off');
  eq(r.changed, false, 'off 不应改动');
});

await atest('applyApproval 未确认 → 拒绝（提示词面是厂商文件）', async () => {
  resetApprovalFixture();
  const e = createEngine({ configRoot: cfg, storeRoot: store, sessionStartOf: startOf, appStateProbe: () => false });
  await athrowsCode(() => e.applyApproval('relaxed'), 'CONFIRMATION_REQUIRED');
});

await atest('applyApproval relaxed：一次备份覆盖两面、规范检查、可整体还原', async () => {
  resetApprovalFixture();
  const e = createEngine({ configRoot: cfg, storeRoot: store, sessionStartOf: startOf, appStateProbe: () => false });
  const tplPath = path.join(builtinDir, 'welcomemode-code', FIXTURE_VER, 'prompt.tpl');
  const beforeTpl = hashOf(tplPath);
  const beforeSettings = hashOf(SETTINGS);

  const r = await e.applyApproval('relaxed', { confirm: true });
  eq(r.failed, 0, `不应有失败：${JSON.stringify(r.done)}`);
  eq(r.ok, 2, '两面都应成功');
  eq(r.files, 2, '应备份 2 个文件（提示词 + settings）');

  const rules = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).sandbox.orderedRules.file.rules;
  eq(rules.filter((x) => x.write === 'allow').length, 4, 'write 应全放开');
  eq(rules.filter((x) => x.delete === 'ask').length, 3, 'delete 应保持不变（relaxed 不动删除）');

  const tpl = fs.readFileSync(tplPath, 'utf8');
  ok(tpl.includes('No-Go Zones'), '红线应保留');
  ok(!tpl.includes('Scan = Read-Only'), '询问条款应去掉');

  e.restore(r.backupId);
  eq(hashOf(tplPath), beforeTpl, '提示词应逐字节还原');
  eq(hashOf(SETTINGS), beforeSettings, 'settings 应逐字节还原');
});

await atest('applyApproval 后 approvalState 能反映出已放宽', async () => {
  resetApprovalFixture();
  const e = createEngine({ configRoot: cfg, storeRoot: store, sessionStartOf: startOf, appStateProbe: () => false });
  await e.applyApproval('relaxed', { confirm: true });
  const s = await e.approvalState();
  const code = s.prompts.find((p) => p.handle === 'prompt.welcomemode-code');
  eq(code.level.level, 'relaxed', `档位应为 relaxed，实际 ${code.level.level}`);
});

await atest('verifyApproval：无重启/无新请求时如实报 undetermined，并给出免责说明', async () => {
  fs.rmSync(tracesDir, { recursive: true, force: true });
  const r = await engineB.verifyApproval('relaxed');
  eq(r.verdict, 'undetermined', `应为 undetermined：${r.reason}`);
  ok(r.parts.length === 2, '应给出两面各自的结论');
  ok(/永远不可能被完全验证/.test(r.caveat), '必须带那句免责说明');
});

// ══════════════ 审计修复回归（2026-11-01 只读审计发现的问题）══════════════
//
// 这一节守的是"审计发现 → 修复 → 不再复发"。
// 每条断言都对应一个真实缺陷，不是假想场景。

await atest('DRIFT_KINDS 覆盖 replay 实际产出的所有漂移 kind', async () => {
  // 教训：文档写「漂移 5 类」，DRIFT_KINDS 只冻了 4 类，而 replay 实际产出第 5 类
  // （target-missing）。分类常量与实际产出不同源 = 违反本项目自己的状态契约。
  const { DRIFT_KINDS } = await import('./core/contracts.mjs');
  const src = fs.readFileSync(new URL('./core/replay.mjs', import.meta.url), 'utf8');
  const produced = new Set();
  for (const m of src.matchAll(/kind:\s*'([a-z-]+)'/g)) produced.add(m[1]);
  ok(produced.size > 0, '应至少抓到一个 kind');
  // unchanged / handle-missing 是"无需动作"的结果，不属于漂移分类
  const ignore = new Set(['unchanged', 'handle-missing']);
  const real = [...produced].filter((k) => !ignore.has(k));
  const frozen = new Set(DRIFT_KINDS);
  const missing = real.filter((k) => !frozen.has(k));
  eq(missing.length, 0, `这些 kind 产出了但未进 DRIFT_KINDS：${missing.join(', ')}`);
  ok(real.includes('target-missing'), 'target-missing 必须仍被 replay 产出（否则覆盖检查失去意义）');
});

await atest('applyProfile 部分失败：仍写审计且带 status/written/failed', async () => {
  // 教训：原来循环裸 await，第二个把手抛错时第一个已落盘，
  // 但 appendAudit 在循环之后永不执行 → 孤儿备份 + 无台账。
  const aFile = path.join(fixtureRoot, 'partial-a.txt');
  const bFile = path.join(fixtureRoot, 'partial-b.txt');
  fs.writeFileSync(aFile, 'A');
  fs.writeFileSync(bFile, 'B');

  register({
    id: 'test.partial-a',
    title: '事务测试 A',
    target: 'test.partial-a',
    resolveTarget: () => ({ key: 'test.partial-a', path: aFile }),
    writeClass: 'user-data',
    channel: 'request-tail',
    privilege: 'none',
    upgradeBehavior: 'survives',
    verification: { strategy: 'token-delta', channel: 'request-tail', baseline: 'session-first', assertion: 'delta-tokens' },
    async probe() { return { exists: true, path: aFile, text: 'A' }; },
    async preview() { return { expectedDeltaTokens: 10 }; },
    async apply() { fs.writeFileSync(aFile, 'A2'); return { changed: true }; },
  });
  register({
    id: 'test.partial-b',
    title: '事务测试 B',
    target: 'test.partial-b',
    resolveTarget: () => ({ key: 'test.partial-b', path: bFile }),
    writeClass: 'user-data',
    channel: 'request-tail',
    privilege: 'none',
    upgradeBehavior: 'survives',
    verification: { strategy: 'token-delta', channel: 'request-tail', baseline: 'session-first', assertion: 'delta-tokens' },
    async probe() { return { exists: true, path: bFile, text: 'B' }; },
    async preview() { return { expectedDeltaTokens: 20 }; },
    async apply() { throw Object.assign(new Error('人为失败'), { code: 'BOOM' }); },
  });

  const eTx = createEngine({ configRoot: cfg, storeRoot: store, appStateProbe: () => false });
  const { writeProfile } = await import('./core/profiles.mjs');
  const p = writeProfile(store, {
    id: 'selftest-partial',
    name: '部分失败档位',
    values: { 'test.partial-a': 'A2', 'test.partial-b': 'B2' },
  });
  const r = await eTx.applyProfile(p.id, { confirm: true });

  eq(r.status, 'partial', `应为 partial，实际 ${r.status}`);
  eq(r.written.map((w) => w.handle).join(','), 'test.partial-a', '成功项应只有 A');
  eq(r.failed.map((x) => x.handle).join(','), 'test.partial-b', '失败项应只有 B');
  ok(r.backupId, '仍必须有备份 id（备份已先做）');

  const au = readAudit(store).filter((x) => x.event === 'apply-profile').at(-1);
  ok(au, '审计必须存在 —— 这正是"孤儿备份"的防线');
  eq(au.status, 'partial', '审计必须记下 partial');
  eq(au.failed.length, 1, '审计里必须有失败清单');
});

await atest('writeDomainRules 定点替换：path 含 ] 时仍能正确收尾', async () => {
  // 教训：原来用 /\[[\s\S]*?\]/ 非贪婪匹配，path 含 ']' 会在第一个 ']' 处提前收尾，
  // 把数组截断 → 写坏 settings.json。改用花括号配对（跳过字符串）。
  const { writeDomainRules } = await import('./core/rules.mjs');
  const settings = `{
    "sandbox": {
        "orderedRules": {
            "file": {"presetVersion": 4, "customized": false, "rules": [
                {"id":"r1","path":"~/[x]/","read":"ask","write":"ask","delete":"ask"}
            ]},
            "command": {"rules": []}
        }
    },
    "other": 1
}`;
  const rules = [{ id: 'r1', path: '~/[x]/', read: 'allow', write: 'allow', delete: 'ask' }];
  const res = writeDomainRules(settings, 'file', rules);
  ok(res.mode === 'targeted', `应走 targeted 分支，实际 ${res.mode}`);
  let parsed;
  try {
    parsed = JSON.parse(res.text);
  } catch (err) {
    throw new Error(`写出的 JSON 非法（说明数组被提前截断）：${err.message}`);
  }
  eq(parsed.sandbox.orderedRules.file.rules[0].read, 'allow', '规则应已更新');
  eq(parsed.other, 1, '数组之后的兄弟字段必须完好（截断会吃掉它）');
});

// ══════════════ 独立复核补的断言（2026-11-02）══════════════
// 三条都对应"曾真实发生过、且注入即红"的缺口。缺它们，修复会在下次重构时静默退回。

await atest('T8：自测不得把账本写进项目 baselines/（工作区级断言，不只靠环境变量）', async () => {
  /**
   * 缺口由来（独立复核 [C8]）：T8 的修复只是"在某处设了 WORKBUDDY_BASELINES_DIR"。
   * 把那一行删掉，自测照样 150/150 全绿，而项目账本目录会重新长出 5.9.3(0000).json。
   * ——修复没有断言守着，等于没有修复。
   *
   * 本断言直接检查"环境变量确实指向沙箱，且不在项目目录内"。
   */
  const { fileURLToPath } = await import('node:url');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const projectBaselines = path.join(repoRoot, 'baselines');
  const envDir = process.env.WORKBUDDY_BASELINES_DIR;

  ok(envDir, '自测必须设置 WORKBUDDY_BASELINES_DIR（否则会写进项目账本目录）');
  ok(!path.resolve(envDir).startsWith(path.resolve(projectBaselines)),
    `账本目录不许落在项目 baselines/ 里（实际 ${envDir}）`);
  ok(path.resolve(envDir).startsWith(path.resolve(fixtureRoot)),
    `账本目录应落在沙箱内（实际 ${envDir}）`);
});

await atest('T4：小增量与负增量的判定分支必须真的存在（注入即红）', async () => {
  /**
   * 缺口由来（独立复核 [C9]/[C31]）：T4 改了三版，把新分支改成 `if(false)` 自测仍全绿。
   * 这条断言把"分支配置"变成可验证事实 —— 不是看源码字面，而是直接调用函数要结果。
   */
  const { evaluateTokenDelta } = await import('./verify/token-delta.mjs');

  // 负增量必须能判生效（曾经用带符号 delta，导致删内容永远判不出生效）
  eq(evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 940, expectedDelta: -60 }).verdict,
    'effective', '删减改动（负期望增量）必须能判生效');

  // 小期望值 + 实测吻合 → 生效（曾经被吞成"判不了"）
  eq(evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 1012, expectedDelta: 12 }).verdict,
    'effective', '小增量但与期望吻合应判生效');

  // 小期望值 + 实测≈0 → 无法判定（不是"未生效"）
  eq(evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 1000, expectedDelta: 7 }).verdict,
    'undetermined', '小增量实测无变化应判无法判定');

  // 小期望值 + 实测严重跑飞 → 无法判定且标 anomaly（不许说成"噪声"）
  const wild = evaluateTokenDelta({ baselineTokens: 1000, observedTokens: -2000, expectedDelta: 19 });
  eq(wild.verdict, 'undetermined', '大偏差应判无法判定');
  eq(wild.anomaly, true, '大偏差必须标 anomaly，不能轻描淡写成"噪声"');
});

await atest('V8：`serve` 必须把 --store 传下去，且隔离运行时账本也跟着隔离', async () => {
  /**
   * 曾经的两层断链（排查 fixture 污染真实 baselines 时抓出来）：
   *   ① `cli.mjs` 的 serve 分支只传 root/port，`--store` 被解析后丢掉
   *      → `serve --store X` 实际用默认数据目录，帮助文案在撒谎；
   *   ② 就算传了 store，`baselinesDir()` 也只看 WORKBUDDY_BASELINES_DIR，
   *      仍然把账本写进**项目目录** baselines/ → 隔离运行污染真实账本。
   *
   * 后果实测过两次：fixture 起一次服务就在真实账本目录留下 `5.9.3(0000).json`，
   * UI 显示"共 2 套账本"，用户分不清哪本是出厂快照。
   *
   * ⚠️ ② 的真行为断言已拆到下面那条独立的 `V8②`（原来这里是 `/isolatedBaselines/`
   * **词存在性**检查 —— 切断接线、把词留在注释里仍然全绿，独立复核 inj13）。
   */
  const cliSrc = fs.readFileSync(new URL('./cli.mjs', import.meta.url), 'utf8');
  const serveBlock = /case 'serve': \{[\s\S]*?\n    \}/.exec(cliSrc)?.[0] ?? '';
  ok(serveBlock, '找不到 serve 分支');
  ok(/store:\s*typeof f\.store/.test(serveBlock), 'serve 必须把 f.store 传给 startConsole（否则 --store 是空承诺）');

  // 行为验证：给了 baselinesDir 就必须落在那儿，不许碰项目目录
  const isoDir = ensureDir(path.join(fixtureRoot, 'iso-baselines'));
  const e = createEngine({ configRoot: cfg, storeRoot: store, baselinesDir: isoDir });
  const b = await e.baselineCapture();
  ok(b?.versionKey, '捕获应成功');
  const files = fs.readdirSync(isoDir).filter((x) => x.endsWith('.json'));
  ok(files.length >= 1, `账本必须落在指定的 baselinesDir（实际 ${files.length} 个文件）`);
});
await atest('V8②：隔离运行时账本真的落到 `<storeRoot>/baselines`（起真服务，只认落盘位置）', async () => {
  /**
   * 这条替代原来的 `/isolatedBaselines/.test(server.mjs 源码)` —— 那是**词存在性**检查：
   * 把 `baselinesDir: isolatedBaselines ? … : undefined` 的接线切断、只把 `isolatedBaselines`
   * 这个词留在注释里，自测仍全绿（独立复核 inj13）；只把这个词改名却会红（inj14）——
   * 证明它认的是词，不是行为。
   *
   * 现在只认「落盘位置」这个事实：起一个真的 `createConsoleServer({isolatedBaselines:true})`，
   * 账本必须出现在 `<storeRoot>/baselines`。词在不在、叫什么都不相干。
   * 隔离运行（`serve --store <tmp>`）是"试跑不污染真账本"的唯一依赖；接线一断，
   * fixture 起一次服务就会在项目 `baselines/` 里长出合成账本（T8 已发生过两次）。
   */
  const isoStore = ensureDir(path.join(fixtureRoot, 'iso-server-store'));
  fs.rmSync(path.join(isoStore, 'baselines'), { recursive: true, force: true });
  const isoApp = createConsoleServer({ configRoot: cfg, storeRoot: isoStore, isolatedBaselines: true });
  try {
    const { port } = await isoApp.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/api/baseline/capture`, {
      method: 'POST',
      headers: { 'X-WBC-Token': isoApp.token, 'Content-Type': 'application/json' },
      body: '{}',
    });
    eq(res.status, 200, `隔离账本的捕获接口应 200（实际 ${res.status}）`);
    const ledgerDir = path.join(isoStore, 'baselines');
    ok(fs.existsSync(ledgerDir),
      `隔离运行时账本必须落在 <storeRoot>/baselines（实际不存在：${tildify(ledgerDir)}）—— `
      + '接线断了的话它会落进环境变量指定的沙箱账本，而不是这个 store');
    const ledgers = fs.readdirSync(ledgerDir).filter((x) => x.endsWith('.json'));
    ok(ledgers.length >= 1, `<storeRoot>/baselines 里必须有账本文件（实际 ${ledgers.length} 个）`);
  } finally {
    await isoApp.close();
  }
});
await atest('D2/F3：apply 必须把 preview 的 warnings 带出来（不许丢掉"写了也白写"的提醒）', async () => {
  /**
   * 曾经的实现（engine.mjs）：只取 preview 的 expectedDeltaTokens，把 warnings 直接扔掉。
   * 于是 style 把手那条「该档位当前未生效 —— 改这个文件不会影响任何请求」
   * 在前端不调 /plan 的前提下**彻底不可达**：两处都断。
   * 这正好是本项目存在的理由（防"写成功但效果为零"）在自己代码里失守。
   */
  const st = await engine.probe('style.socratic');
  const next = (st.text ?? '') + '\n<!-- selftest -->';
  const r = await engine.apply('style.socratic', { next, confirm: true, actor: 'selftest' });
  ok(Array.isArray(r.previewWarnings), 'apply 返回值必须含 previewWarnings 数组');
  ok(typeof r.isActive === 'boolean', 'apply 返回值必须含 isActive（该档是不是当前生效档）');
  const joined = r.previewWarnings.join('\n');
  ok(/未生效|不可写/.test(joined), '未生效档位的警告必须原样带出（实际：' + JSON.stringify(r.previewWarnings).slice(0, 160) + '）');
});
await atest('T3/noop：内容没变时不得谎报"生效"（三态纪律）', async () => {
  /**
   * 缺口由来（独立复核 [C28]/[C34]，三个版本的代码上全部复现）：
   * noop apply 曾在台账里写 `expectedDeltaTokens: 0`，verify 读到 0 →
   * "预期无变化 + 实测无变化" → 回 **effective**。用户什么都没改，工具报绿色「✅ 生效」。
   *
   * 修法：noop 记 `null`（没有可验证的期望），verify 见到 noop 直接判 undetermined。
   * 本断言同时守住这两半。
   */
  const { evaluateTokenDelta } = await import('./verify/token-delta.mjs');

  // 缺理论增量 → 不许判生效（noop 传 null 后走的就是这条路）
  const r = evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 1000 });
  eq(r.verdict, 'undetermined', '没有理论增量时不许判生效');

  // 台账里的 noop 记录不得带 expectedDeltaTokens: 0
  const audit = readAudit(store);
  const noopRec = audit.find((x) => x.event === 'apply' && x.noop === true);
  if (noopRec) {
    ok(noopRec.expectedDeltaTokens === null,
      `noop 记录的 expectedDeltaTokens 必须是 null（实际 ${JSON.stringify(noopRec.expectedDeltaTokens)}）——`
      + '写 0 会让 verify 判出"生效"');
  }
});

await atest('T3/noop（纯文本预判分支）：同一段纯文本两次 apply，第二次台账 null + noop', async () => {
  /**
   * 半空转由来（独立复核 inj09）：上面那条只在台账里**找**一条 `noop === true` 的记录，
   * 而 fixture 里第一条 noop 来自 `personalization.tone-style`（JSON 字段 → 走
   * `engine.mjs` 的**结构化**分支，写完再比）。于是 `engine.mjs` 的**纯文本预判分支**
   * （`isTextHandle && before === nextText`）的 `expectedDeltaTokens: null` 改成 `0`
   * 仍全绿 —— 它宣称守住的语义在那一半上没人管。
   *
   * 这里真的走纯文本分支：整文件把手（SOUL）同一段文本 apply 两次，
   * 第二次必须判 noop，且台账里 `expectedDeltaTokens === null`（不是 0）。
   */
  const st = await engine.probe('personalization.soul');
  const original = st.state.text ?? '';
  const sameText = `${original}\n- WBC-TEXT-NOOP-001\n`;
  const n0 = readAudit(store).length;

  const first = await engine.apply('personalization.soul', { next: sameText, confirm: true, actor: 'selftest' });
  ok(!first.noop, '第一次内容确实变了，不该判 noop');
  const second = await engine.apply('personalization.soul', { next: sameText, confirm: true, actor: 'selftest' });
  eq(second.noop, true, '同一段纯文本第二次 apply 必须判 noop（走文本预判分支）');
  eq(second.expectedDeltaTokens, null, '文本分支 noop 的返回里 expectedDeltaTokens 必须是 null（写 0 会骗出"生效"）');

  const rows = readAudit(store).slice(n0)
    .filter((x) => x.event === 'apply' && x.handle === 'personalization.soul');
  const noopRows = rows.filter((x) => x.noop === true);
  eq(noopRows.length, 1, `两次 apply 应恰好留下 1 行 noop 台账（实际 ${noopRows.length} 行）`);
  eq(noopRows[0].expectedDeltaTokens, null,
    `文本分支的 noop 台账必须是 null（实际 ${JSON.stringify(noopRows[0].expectedDeltaTokens)}）——`
    + '写 0 会让 verify 走"预期无变化"分支，把"什么都没改"报成 ✅ 生效');
  eq(noopRows[0].changed, false, 'noop 台账必须记 changed:false');

  // 复原 fixture（第二次是 noop 没写盘，用第一次的备份还原）
  engine.restore(first.backupId);
  eq(fs.readFileSync(SOUL, 'utf8'), original, '文本分支用例必须把 fixture 复原');
});

// ══════════════ 独立复核 WP6-A2 补的断言（2026-11-02）══════════════
// D1/D2/D3/D4/D5/D6 六条缺陷全部逃过了当时的 198 条断言。下面这四条守住最危险的几个。

await atest('D1：apply 漏传 next 必须被拒绝，绝不许把文件写成空', async () => {
  /**
   * 曾经（CRITICAL）：`apply(id, { next = '' })` 的默认值让"漏参数"等于"写空内容"。
   * 实测把 32 字节的人设文件清成 0 字节，CLI 还打印「✅ 已写入」。
   *
   * 本断言同时守住两层：引擎层（undefined 直接抛）与"显式空串仍允许"（那是真实意图）。
   */
  const before = fs.readFileSync(SOUL, 'utf8');
  let threw = null;
  try {
    await engine.apply('personalization.soul', {});   // 不传 next
  } catch (e) {
    threw = e;
  }
  ok(threw, '不传 next 时必须抛错，而不是写空文件');
  eq(threw.code, 'INPUT_MISSING', `错误码应为 INPUT_MISSING，实际 ${threw.code}`);
  eq(fs.readFileSync(SOUL, 'utf8'), before, '被拒时不许改动文件');

  // 显式传空字符串是允许的（用户主动清空的真实意图）
  const cleared = await engine.apply('personalization.soul', { next: '' });
  ok(cleared, '显式传空字符串应被接受');
  eq(fs.readFileSync(SOUL, 'utf8'), '', '显式清空应真的清空');
  fs.writeFileSync(SOUL, before, 'utf8');   // 复原
});

await atest('D4：结构化把手的 noop 判定必须生效（同值重复 apply 不建新备份）', async () => {
  /**
   * 曾经：noop 判定只覆盖纯文本把手（10/18），value 型与 rule-op 型同值重复 apply
   * 仍然每次建备份 —— 计划里的验收判据「同内容两次备份数不变」不通过。
   *
   * 本断言直接数备份目录。
   */
  const { listBackups } = await import('./core/backup.mjs');
  const styleHandle = registryList().find((x) => x.id === 'personalization.tone-style');
  if (!styleHandle) return;   // fixture 没有该把手时跳过（不算失败）

  const st = await styleHandle.probe(engine.ctx ?? {});
  const sameValue = String(st.value ?? '');

  const n0 = listBackups(store).length;
  const r1 = await engine.apply('personalization.tone-style', { next: sameValue });
  const n1 = listBackups(store).length;
  const r2 = await engine.apply('personalization.tone-style', { next: sameValue });
  const n2 = listBackups(store).length;

  eq(r1.noop, true, '第一次同值 apply 应判为 noop');
  eq(r2.noop, true, '第二次同值 apply 也应判为 noop');
  eq(n1, n0, `noop 不许新增备份（实际 ${n0} → ${n1}）`);
  eq(n2, n0, `重复 noop 不许累积备份（实际 ${n0} → ${n2}）`);
});

await atest('D2（重写·三证）：restoreBaseline 写入失败必须留 status:"failed" 台账，且异常带 backupId', async () => {
  /**
   * ⚠️ 这条断言的前身是**空转**的（类 3 的"整条不可能失败"）：
   *   `ok(rows.length >= n0)` —— 同一份**只增**日志的前后计数比较，恒真。
   *   实测：把 `engine.mjs` 里成功+失败两条 `appendAudit` 全删（正是它宣称守住的
   *   "孤儿备份 + 审计零行"），自测仍 159/0 全绿。
   *
   * 现在真的把失败场景造出来：把目标文件设成**只读**（Windows: FILE_ATTRIBUTE_READONLY
   * → writeFileSync 抛 EPERM，已单独预检：`gates/WP9/injection-mechanisms.log`），
   * 再断言"**恰好新增一行** status:'failed'"。计数改为"失败行"而不是"总行数"。
   */
  // 先确保本版账本存在（账本里要有 personalization.soul 的快照）
  const led = await engine.baselineCapture();
  ok(led?.versionKey, '前提：必须能建立本版账本');

  // 把现状改成"与账本不同"，这样还原一定会尝试写盘
  fs.chmodSync(SOUL, 0o666);
  fs.writeFileSync(SOUL, `${ORIGINAL_SOUL}\n- WBC-READONLY-001\n`, 'utf8');
  fs.chmodSync(SOUL, 0o444);          // 只读 → 写入必失败

  const beforeContent = fs.readFileSync(SOUL, 'utf8');
  const failedRows = () => readAudit(store)
    .filter((r) => r.event === 'restore' && r.handle === 'personalization.soul' && r.status === 'failed');
  const n0 = failedRows().length;

  let threw = null;
  try {
    await engine.baselineRestore('personalization.soul');
  } catch (e) {
    threw = e;
  } finally {
    try { fs.chmodSync(SOUL, 0o666); } catch { /* 复原失败不影响断言 */ }
  }

  ok(threw, '只读目标上的还原必须失败（否则本用例的前提不成立，断言会空转）');
  const rows = failedRows();
  eq(rows.length, n0 + 1,
    `失败场景下审计必须**恰好**新增一行 status:"failed"（实际 ${n0} → ${rows.length}；`
    + `抛出 ${threw?.code}: ${String(threw?.message ?? '').slice(0, 160)}）`);
  const row = rows.at(-1);
  ok(row.error && row.error.code, '失败行必须带 error.code（不许只写一句"失败"）');
  ok(threw.backupId, '异常必须带 backupId —— 否则用户不知道"有一份备份可以回滚"');
  eq(row.backupId, threw.backupId, '台账里的 backupId 与异常里的必须是同一份备份');
  eq(fs.readFileSync(SOUL, 'utf8'), beforeContent, '被拒/失败时文件内容不许变');
  // 复原 fixture
  fs.writeFileSync(SOUL, ORIGINAL_SOUL, 'utf8');
});

await atest('D5：前端 doRestore 必须传 confirm（**剥掉注释后**仍出现在真代码里）', async () => {
  /**
   * 曾经：后端 /api/restore 加 confirm 后，前端 doRestore 没跟着传 →
   * 守护页「备份时间线 → 还原」按钮永久 400，而它是回到历史备份的唯一入口。
   * 8 条前端断言无一覆盖它。
   *
   * ⚠️ 半空转由来（独立复核 inj16）：原来的写法直接对源码正则，于是
   *     "删掉真调用里的 `confirm: true`、只在**注释**里写一句 `confirm: true`"
   *     就能骗过它（全绿）。注释不是证据 —— 现在先 `stripJsComments()` 再匹配。
   */
  const { fileURLToPath } = await import('node:url');
  const appPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'app.js');
  const raw = fs.readFileSync(appPath, 'utf8');
  const src = stripJsComments(raw);
  ok(src.length > 0 && stripJsComments('/* confirm: true */').trim() === '',
    '剥注释器自证：块注释里的内容必须被剥掉了');
  const m = /async function doRestore\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(src);
  ok(m, '找不到 doRestore 函数（剥注释后）');
  ok(/confirm:\s*true/.test(m[1]), 'doRestore 必须传 confirm: true，否则后端会拒绝（400）—— 写在注释里不算');
  ok(/dryRun:\s*true/.test(m[1]), 'doRestore 应先 dryRun 预演，把"将删除哪些文件"给用户看');
});

// ══════════════ WP9 · P1 止血 + 立信（2026-11-02）══════════════
// 每条修复都配一条**行为**断言（不是"源码里有这个词"），并各自做过三证：
//   ① 把修复改回缺陷态 → 红；② 正常态 → 绿；③ 把被测字段删掉 → 红。
// 三证的原始输出见 `.zhll/audit2/gates/WP9/`。

console.log('\n【WP9】P1 止血：F1 漏参数 / F2 还原留副本 / F6 写后台账 / F7 逐条容错 / F3 null 传播');

await atest('F1（HTTP 层）：apply 漏传 next → 非 200/INPUT_MISSING，SOUL.md 逐字节不变', async () => {
  /**
   * 致命缺陷的原样姿势（Lead 实测）：`POST /api/handle/personalization.soul/apply`
   * body `{}` → SOUL.md 31 B → 0 B，响应还是 `ok:true`。
   * 根因是 server.mjs 的 `body.next ?? ''` 把"没传"提前变成了"显式空串"，
   * 绕过了引擎那道 `next === undefined` 的硬防线。
   */
  const app = createConsoleServer({ configRoot: cfg, storeRoot: store });
  const { port } = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'X-WBC-Token': app.token, 'Content-Type': 'application/json' };
  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const before = fs.readFileSync(SOUL);
  try {
    // ① 空 body = 漏参数
    const r = await post('/api/handle/personalization.soul/apply', {});
    ok(r.status !== 200, `漏参数必须被拒（实际 HTTP ${r.status}）`);
    const j = await r.json();
    eq(j.ok, false, '响应不许是 ok:true');
    eq(j.error.code, 'INPUT_MISSING', `错误码应为 INPUT_MISSING，实际 ${j.error.code}`);
    eq(sha256(fs.readFileSync(SOUL)), sha256(before),
      '被拒时 SOUL.md 必须逐字节不变（曾经的缺陷：31 B → 0 B 且报 ok:true）');

    // ② `next: null` 与"没传"同义：JSON null 不是任何把手认识的写入值，
    //    而 `?? ''` 当年同样把它变成空串 —— 那是另一条"清空文件"的路
    const r2 = await post('/api/handle/personalization.soul/apply', { next: null });
    ok(r2.status !== 200, 'next:null 也必须被拒');
    eq((await r2.json()).error.code, 'INPUT_MISSING', 'null 的语义应与"没传"一致');
    eq(sha256(fs.readFileSync(SOUL)), sha256(before), 'null 被拒时文件不许变');

    // ③ 显式空串是**合法意图**，不许一起否掉（防"修过头"）
    const r3 = await post('/api/handle/personalization.soul/apply', { next: '' });
    eq(r3.status, 200, `显式 next:"" 必须放行（实际 ${r3.status}）`);
    eq(fs.readFileSync(SOUL, 'utf8'), '', '显式清空应真的清空——那是用户意图，不是漏参数');
  } finally {
    fs.writeFileSync(SOUL, before);   // 逐字节复原 fixture
    await app.close();
  }
});

await atest('F1（把手层）：工厂 apply 漏传 next 必须拒绝（三个整文件写入工厂一致）', async () => {
  /**
   * 引擎那道 `next === undefined` 的防线是对的，但它只在**引擎**这一层。
   * 五个把手工厂里有三个（identity-file / style-file / prompt-template）写着
   * `{ next = '' }` 默认值 —— 一旦有调用点绕过引擎（例如把 profile **对象**直接
   * 喂给 `applyProfile`，它不做 assertProfile），"漏参数"会再次变成"写空整个文件"。
   * 默认值本身就是缺陷，删掉并显式拒绝。
   */
  const cases = [
    ['identity-file', 'personalization.soul'],
    ['style-file', 'style.creative'],
    ['prompt-template', 'prompt.welcomemode-code'],
  ];
  for (const [label, id] of cases) {
    const h = registryList().find((x) => x.id === id);
    ok(h, `${label}：找不到把手 ${id}`);
    const st = await h.probe(engineB.ctx);
    const before = fs.existsSync(st.path) ? fs.readFileSync(st.path) : null;
    let threw = null;
    try { await h.apply(engineB.ctx, {}); } catch (e) { threw = e; }
    ok(threw, `${label}：漏传 next 必须抛错（不许把文件写成空）`);
    eq(threw.code, 'INPUT_MISSING', `${label}：错误码应为 INPUT_MISSING，实际 ${threw.code}`);
    const after = fs.existsSync(st.path) ? fs.readFileSync(st.path) : null;
    eq(after === null ? null : sha256(after), before === null ? null : sha256(before),
      `${label}：被拒时文件不许变`);
  }
});

await atest('F2：还原"备份时不存在"的条目之前，必须把当前内容留副本（可从 restore-pre 找回）', async () => {
  /**
   * 致命缺陷：`restoreBackup` 对"备份时本不存在"的条目直接 `fs.rmSync(absPath,{force:true})`，
   * **删前不留任何副本** —— 实测删除后全 store 递归搜不到被删内容的任何一个字节。
   * 现在删除/覆盖前先把当前字节落到 `state/restore-pre/<backupId>/<key 的 hash>.bin`。
   */
  const { createBackup } = await import('./core/backup.mjs');
  const crypto = await import('node:crypto');
  const target = path.join(fixtureRoot, 'restore-pre-target.txt');
  fs.rmSync(target, { force: true });

  const manifest = createBackup({
    storeRoot: store,
    reason: 'selftest restore-pre',
    entries: [{ key: 'selftest.restore-pre', absPath: target }],
  });
  eq(manifest.entries[0].existed, false, '前提：备份时目标不存在');

  // 备份之后用户才写了内容 —— 还原会把这份内容删掉
  const SECRET = '备份之后才写的、还原会删掉的内容 WBC-RESTORE-PRE-001\n';
  fs.writeFileSync(target, SECRET, 'utf8');

  const r = engine.restore(manifest.id);
  eq(fs.existsSync(target), false, '还原应删除"备份时不存在"的目标');
  ok(r.savedDir, `必须返回还原前副本目录（实际 ${JSON.stringify(r.savedDir)}）`);

  const preDir = path.join(store, 'state', 'restore-pre', manifest.id);
  ok(fs.existsSync(preDir), 'restore-pre 目录必须存在');
  const found = fs.readdirSync(preDir).filter((f) => {
    const p = path.join(preDir, f);
    return fs.statSync(p).isFile() && fs.readFileSync(p, 'utf8') === SECRET;
  });
  eq(found.length, 1, `被删内容必须能在 restore-pre 里逐字节找回（实际命中 ${found.length} 个文件）`);

  // 文件名 = key 的 sha256 前 16 位（与 verify/readback.mjs 同一算法，可按 key 复算）
  const expectName = `${crypto.createHash('sha256').update('selftest.restore-pre').digest('hex').slice(0, 16)}.bin`;
  eq(found[0], expectName, '副本文件名应为 key 的 sha256 前 16 位（与 readback 一致）');

  // index.json：只有 hash 名，人眼认不出是哪个文件，必须有可读映射
  const idx = JSON.parse(fs.readFileSync(path.join(preDir, 'index.json'), 'utf8'));
  ok(Array.isArray(idx.entries) && idx.entries.some((e) => e.key === 'selftest.restore-pre'),
    'index.json 必须记录 key → 文件 的映射');

  // 台账也要说出落点（用户得知道去哪找）
  const row = readAudit(store).filter((x) => x.event === 'restore' && x.backupId === manifest.id).at(-1);
  eq(row.status, 'ok', '全成功时 status 应为 ok');
  eq(row.savedDir, tildify(preDir), '台账必须记下还原前副本落点');
});

await atest('F7：还原逐条目容错 —— 一条失败继续下一条，审计 status:"partial" 且 results 带 error', async () => {
  /**
   * 曾经的缺陷：`restoreBackup` 裸循环。第一条目已还原、第二条目 EISDIR 一抛就中断，
   * 后面的全不执行，`engine.restore` 的审计在写之后 → **restore 审计 0 行**
   * （半还原 + 零台账）。
   * 现在逐条目 try/catch，失败原样带回，整体按"部分成功"入账。
   */
  const { createBackup } = await import('./core/backup.mjs');
  const good = path.join(fixtureRoot, 'partial-good.txt');
  const dirTarget = path.join(fixtureRoot, 'partial-dir-target');
  fs.rmSync(good, { force: true });
  fs.rmSync(dirTarget, { recursive: true, force: true });

  const manifest = createBackup({
    storeRoot: store,
    reason: 'selftest restore partial',
    entries: [
      { key: 'selftest.partial-good', absPath: good },
      { key: 'selftest.partial-dir', absPath: dirTarget },
    ],
  });
  eq(manifest.entries.every((e) => e.existed === false), true, '前提：两个目标备份时都不存在');

  // 第一条：普通文件（应被删除）；第二条：**目录**（rmSync 报 ERR_FS_EISDIR → 该条失败）
  fs.writeFileSync(good, 'GOOD-BEFORE-RESTORE\n', 'utf8');
  ensureDir(dirTarget);
  fs.writeFileSync(path.join(dirTarget, 'keep.txt'), 'x', 'utf8');

  const r = engine.restore(manifest.id);
  eq(r.status, 'partial', `应判 partial（实际 ${r.status}）`);
  eq(r.partial, true, 'partial 字段应为 true');
  eq(r.ok, false, 'ok 字段应为 false（有失败就不是全成功）');

  const goodRes = r.results.find((x) => x.key === 'selftest.partial-good');
  eq(goodRes?.ok, true, '第一条必须成功 —— 证明没有在失败处中断');
  eq(fs.existsSync(good), false, '第一条必须真的被删除（不是"后面失败所以整体没做"）');

  const bad = r.results.find((x) => x.key === 'selftest.partial-dir');
  ok(bad && bad.ok === false, '失败条目必须 ok:false');
  ok(bad.error && bad.error.code, '失败条目必须带 error.code');
  ok(fs.existsSync(path.join(dirTarget, 'keep.txt')), '失败的条目不许被误删（目录还在）');

  // 台账：恰好新增一行 status:'partial'，且带失败明细
  const row = readAudit(store).filter((x) => x.event === 'restore' && x.backupId === manifest.id).at(-1);
  ok(row, '无论成败都必须有 restore 台账行（曾经是 0 行）');
  eq(row.status, 'partial', '台账 status 必须是 partial');
  eq(row.failed?.length, 1, '台账必须列出 1 条失败');
  eq(row.failed[0].key, 'selftest.partial-dir', '失败明细要点名是哪个条目');
});

await atest('F2（CLI 层）：restore 不给 --confirm → 非零退出且目标文件不变；给了才真的还原', async () => {
  /**
   * 缺陷：`/api/restore` 修好了（confirm + dryRun + 闸门），但 CLI `restore` 直调引擎：
   * 既不要 `--confirm`、也不过 `checkRestoreGate` —— 同一类写操作两套规矩，
   * 等于给闸门留了个后门。这里跑**真的子进程**（不是读源码）。
   */
  const { createBackup } = await import('./core/backup.mjs');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const target = path.join(fixtureRoot, 'cli-restore.txt');
  fs.rmSync(target, { force: true });
  fs.writeFileSync(target, 'ORIGINAL-BEFORE-BACKUP\n', 'utf8');

  const manifest = createBackup({
    storeRoot: store,
    reason: 'selftest cli restore',
    entries: [{ key: 'selftest.cli-restore', absPath: target }],
  });
  fs.writeFileSync(target, 'CHANGED-AFTER-BACKUP\n', 'utf8');

  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
  const run = (...extra) => spawnSync(process.execPath, [
    cli, 'restore', manifest.id, ...extra, '--root', cfg, '--store', store,
  ], { encoding: 'utf8', cwd: path.dirname(cli) });

  const refused = run();
  ok(refused.status !== 0, `不给 --confirm 必须非零退出（实际 ${refused.status}）`);
  ok(/--confirm/.test(`${refused.stdout ?? ''}${refused.stderr ?? ''}`),
    `必须给出可复制的完整命令，实际输出：${JSON.stringify((refused.stderr ?? '').slice(0, 200))}`);
  eq(fs.readFileSync(target, 'utf8'), 'CHANGED-AFTER-BACKUP\n', '被拒时目标文件一个字节都不许变');

  const done = run('--confirm');
  eq(done.status, 0, `给 --confirm 后应成功（stderr: ${(done.stderr ?? '').slice(0, 300)}）`);
  eq(fs.readFileSync(target, 'utf8'), 'ORIGINAL-BEFORE-BACKUP\n', '确认后应真的还原');
});

await atest('F6：写已落盘但台账写不成 → 异常带 backupId 且如实说"已完成、台账失败"', async () => {
  /**
   * 曾经：`appendAudit` 裸露在"文件已经写完"之后。`store/state` 不可写时——
   * 目标文件**已改**、调用方收到"失败"、`audit.jsonl` 零行、异常里**没有 backupId**。
   * 用户既不知道写已经发生，也不知道有一份备份可以还原。
   * 现在：抛可判定的 `AUDIT_WRITE_FAILED` + 异常带 `backupId` + 文案明说"已完成但台账失败"。
   *
   * 失败注入：把 `<store>/state` 占成一个**普通文件** → `ensureDir(state)` 必然 EEXIST
   * （已单独预检：`gates/WP9/injection-mechanisms.log`）。
   */
  const storeNoAudit = ensureDir(path.join(fixtureRoot, '_store-no-audit'));
  fs.rmSync(path.join(storeNoAudit, 'state'), { recursive: true, force: true });
  fs.writeFileSync(path.join(storeNoAudit, 'state'), 'occupied', 'utf8');
  const eNoAudit = createEngine({
    configRoot: cfg, storeRoot: storeNoAudit, sessionStartOf: startOf, appStateProbe: () => false,
  });

  const before = fs.readFileSync(SOUL, 'utf8');
  const NEW = `${before}\n- WBC-AUDIT-FAIL-001\n`;
  let threw = null;
  try {
    await eNoAudit.apply('personalization.soul', { next: NEW });
  } catch (e) {
    threw = e;
  }
  try {
    ok(threw, '台账写不成时必须抛错（不许静默成功）');
    eq(threw.code, 'AUDIT_WRITE_FAILED', `错误码应为 AUDIT_WRITE_FAILED，实际 ${threw.code}`);
    ok(threw.backupId, '异常必须带 backupId —— 用户要知道"写已经发生、有备份可退"');
    ok(threw.written === true, '异常必须标明"写已经发生"（written:true）');
    ok(/台账/.test(threw.message) && /(已完成|写入)/.test(threw.message),
      `文案必须如实说明"已完成但台账失败"，实际：${threw.message}`);
    eq(fs.readFileSync(SOUL, 'utf8'), NEW, '既然已经写了，就必须如实承认写了（不许假装没发生）');
  } finally {
    fs.writeFileSync(SOUL, before, 'utf8');              // 复原 fixture
    fs.rmSync(storeNoAudit, { recursive: true, force: true });
  }
});

await atest('F3（判据层）：expectedDelta 为 null 必须 undetermined；0 仍是合法的"预期无变化"', async () => {
  /**
   * 消费端缺陷（F3）：`token-delta` 的「预期无变化（|期望|≤噪声）」分支
   * 会把 `null`（= 估不出来）当成 0（= 确实零增量），于是"改动完全没进请求"
   * 也被判成 `effective`。
   */
  const { evaluateTokenDelta } = await import('./verify/token-delta.mjs');

  const nul = evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 1000, expectedDelta: null });
  eq(nul.verdict, 'undetermined', 'null（估不出）不是 0（预期无变化）——折成 0 会把"没进请求"报成生效');
  ok(/理论增量/.test(nul.reason), `理由必须点出缺理论增量：${nul.reason}`);

  // 第三证：把被测字段**删掉**（而不是传 null）同样必须判"判不了"
  const undef = evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 1000 });
  eq(undef.verdict, 'undetermined', '字段缺失必须与 null 同一个结论（不许静默按缺省放过）');

  // 反向：合法 0 的语义必须保留（不许把 null 与 0 一起否掉）
  const zero = evaluateTokenDelta({ baselineTokens: 1000, observedTokens: 1000, expectedDelta: 0 });
  eq(zero.verdict, 'effective', '确实零增量的改动仍应判生效（0 不能被当成 null）');
});

await atest('F3（档位链）：任一项估不出增量 → 台账 null + verifyProfile undetermined（真实 apply 路径）', async () => {
  /**
   * 曾经的缺陷（F3）：`applyProfile` 用 `?? 0` 求和 → `expectedDelta=0` →
   * 判据走「预期无变化 + 实测无变化 → effective」，**改动完全没进请求也报绿灯**。
   *
   * 这里走真实链路，不手改台账：档位里放一个头部通道把手（`prompt.welcomemode-*`），
   * 它的 preview 明确返回 `expectedDeltaTokens: null`（头部通道无法用 token 估增量）。
   */
  const engineC = createEngine({
    configRoot: cfg, storeRoot: store, sessionStartOf: startOf, appStateProbe: () => false,
  });
  fs.rmSync(tracesDir, { recursive: true, force: true });
  SESS.clear();

  const prof = {
    id: 'selftest-null-delta',
    name: '估不出增量的档位',
    values: { 'prompt.welcomemode-code': '<personal_files_safety>WP9 自测</personal_files_safety>\n' },
  };
  const applied = await engineC.applyProfile(prof, { confirm: true });
  eq(applied.expectedDeltaTokens, null,
    `档位里有把手估不出增量 → 合计必须是 null（实际 ${JSON.stringify(applied.expectedDeltaTokens)}）——`
    + '折成 0 会让 verify 走"预期无变化"分支把"没进请求"报成生效');

  const row = engineC.audit().filter((r) => r.event === 'apply-profile' && r.profile === prof.id).at(-1);
  ok(row, '应有 apply-profile 台账行');
  eq(row.expectedDeltaTokens, null, '台账里也必须记 null（不许折成 0）');

  // 造"改动后新建会话、Δ=0"的对照数据 —— 这正是缺陷会误判成 effective 的场景
  const at = Date.parse(row.at);
  SESS.set('901', at - 120000);
  writeTrace('901', 'base.jsonl', new Date(at - 115000).toISOString(), CHAT_MODEL, 1000);
  SESS.set('902', at + 5000);
  writeTrace('902', 'obs.jsonl', new Date(at + 10000).toISOString(), CHAT_MODEL, 1000);

  const v = await engineC.verifyProfile(prof.id);
  ok(v.evidence, `必须真的走完对照采集，不能是"取不到会话"的兜底：${JSON.stringify(v).slice(0, 200)}`);
  eq(v.verdict, 'undetermined', `估不出理论增量时必须说"判不了"，实际 ${v.verdict}：${v.reason}`);
  ok(/理论增量/.test(v.reason), `理由必须点出缺理论增量：${v.reason}`);

  /**
   * 正向对照：同样是 Δ0，但期望增量**真的是 0** → 必须仍能判 effective。
   * 这条对照证明"判据真的在区分 null 与 0"，而不是"永远 undetermined"的空转。
   */
  const { appendAudit } = await import('./core/audit.mjs');
  appendAudit(store, {
    event: 'apply-profile', profile: 'selftest-zero-delta', handles: [],
    expectedDeltaTokens: 0, status: 'ok',
  });
  const zeroRow = engineC.audit()
    .filter((r) => r.event === 'apply-profile' && r.profile === 'selftest-zero-delta').at(-1);
  const at0 = Date.parse(zeroRow.at);
  SESS.clear();
  fs.rmSync(tracesDir, { recursive: true, force: true });
  SESS.set('911', at0 - 120000);
  writeTrace('911', 'base.jsonl', new Date(at0 - 115000).toISOString(), CHAT_MODEL, 1000);
  SESS.set('912', at0 + 5000);
  writeTrace('912', 'obs.jsonl', new Date(at0 + 10000).toISOString(), CHAT_MODEL, 1000);

  const v0 = await engineC.verifyProfile('selftest-zero-delta');
  eq(v0.verdict, 'effective',
    `合法 0 的语义必须保留（确实零增量的改动仍判生效），实际 ${v0.verdict}：${v0.reason}`);

  fs.rmSync(tracesDir, { recursive: true, force: true });
  SESS.clear();
});

// ══════════════ WP10 · P2（上半）契约门禁 + 空转断言改造（2026-11-02）══════════════
// 本批消灭"源码字符串/词存在性"类空转断言；这里补的是其中最贵的一处判据层缺口。
console.log('\n【WP10】P2（上半）：断言去空转（后端）');

await atest('C2：applyProfile 多把手求和 —— 任一项估不出则整体 null（不是 0，也不是其余项之和）', async () => {
  /**
   * 缺口由来（brief C2）：WP9 把 `applyProfile` 的 `?? 0` 求和改成「任一项估不出即整体 null」，
   * 但只有 `F3（档位链）` 顺带覆盖到它 —— 那条用的是**单把手**档位，
   * "多把手求和的算术"这一层（`previews.reduce(...)`）没有独立断言钉住：
   * 单把手场景下"永远 null"和"正确实现"给出同一个答案，分辨不出来。
   * 这里用两个合成把手把两个方向都钉死：
   *   · 全部估得出（10 + 25）→ 必须真的求和；
   *   · 任一项估不出（+ null）→ 必须整体 null（不是 0，也不是其余项之和 35）。
   */
  const aFile = path.join(fixtureRoot, 'sum-a.txt');
  const bFile = path.join(fixtureRoot, 'sum-b.txt');
  const cFile = path.join(fixtureRoot, 'sum-c.txt');
  for (const [p, v] of [[aFile, 'A'], [bFile, 'B'], [cFile, 'C']]) fs.writeFileSync(p, v, 'utf8');

  const mkSumHandle = (id, file, delta) => ({
    id,
    title: `求和测试 ${id}`,
    target: id,
    resolveTarget: () => ({ key: id, path: file }),
    writeClass: 'user-data',
    channel: 'request-tail',
    privilege: 'none',
    upgradeBehavior: 'survives',
    verification: { strategy: 'token-delta', channel: 'request-tail', baseline: 'session-first', assertion: 'delta-tokens' },
    async probe() { return { exists: true, path: file, text: fs.readFileSync(file, 'utf8') }; },
    async preview() { return { expectedDeltaTokens: delta }; },
    async apply(ctx, { next }) { fs.writeFileSync(file, String(next), 'utf8'); return { changed: true }; },
  });
  register(mkSumHandle('test.sum-a', aFile, 10));
  register(mkSumHandle('test.sum-b', bFile, 25));
  register(mkSumHandle('test.sum-c', cFile, null));   // 估不出增量（如头部通道把手）

  const eSum = createEngine({ configRoot: cfg, storeRoot: store, appStateProbe: () => false });

  // 方向一：全部估得出 → 必须是**算术和**（把求和写成"永远 null"就会在这里红）
  const okProfile = await eSum.applyProfile({
    id: 'selftest-sum-ok', name: '全部估得出', values: { 'test.sum-a': 'A2', 'test.sum-b': 'B2' },
  }, { confirm: true });
  eq(okProfile.expectedDeltaTokens, 35,
    `两个估得出的把手必须求和（10 + 25 = 35），实际 ${JSON.stringify(okProfile.expectedDeltaTokens)}`);
  const okRow = readAudit(store).filter((r) => r.event === 'apply-profile' && r.profile === 'selftest-sum-ok').at(-1);
  eq(okRow.expectedDeltaTokens, 35, '台账里也必须是无损的算术和');

  // 方向二：任一项估不出 → 整体 null（折成 0 / 用其余项之和都会在这里红）
  const nullProfile = await eSum.applyProfile({
    id: 'selftest-sum-null', name: '含估不出的把手',
    values: { 'test.sum-a': 'A3', 'test.sum-b': 'B3', 'test.sum-c': 'C2' },
  }, { confirm: true });
  eq(nullProfile.expectedDeltaTokens, null,
    '任一项估不出增量 → 合力必须是 null（实际 '
    + `${JSON.stringify(nullProfile.expectedDeltaTokens)}）——折成 0 会让 verify 把"没进请求"报成生效，`
    + '取其余项之和则是**谎报一个能验证的期望值**');
  const nullRow = readAudit(store).filter((r) => r.event === 'apply-profile' && r.profile === 'selftest-sum-null').at(-1);
  eq(nullRow.expectedDeltaTokens, null, '台账里也必须是 null（不许只改返回值）');
});

// ══════════════ WP12 · P3a 收口：写路径原子化 / 报错说得清 / 畸形输入不留孤儿备份（2026-11-02）══════════════
// 三条残余是一件事：**写入**在三处极端情况下也要说得清 —— 写失败（R27）、盘满（R28）、输入畸形（R31）。
// 每条断言都做了三证：① 改回缺陷态 → 红；② 正常态 → 绿；③ 删掉被测守卫/调用 → 仍必须红。
// 三证原始输出见 `.zhll/audit2/gates/WP12/`。

console.log('\n【WP12】P3a 收口：R27 原子写 / R28 写失败文案 / R31 畸形 next 不留孤儿备份');

/**
 * 可注入的写失败：把 `fs.renameSync` **临时换成抛 ENOSPC**，跑完立刻还原。
 *
 * 为什么不是"造一个文件系统条件"：
 *   · 临时名现在是**唯一**的，以前"把 `<目标>.tmp` 占成目录"的注入法已失效；
 *   · 换成"把目标设为只读"会**在到达原子写之前**被 `style-file` / `prompt-template`
 *     的"当前进程不可写"前置检查拦下，报的是另一句话（实测），于是四条路径不落在同一步。
 * 直接对 syscall 打桩，四条路径**精确落在原子写那一步**，errno 也是真的 ENOSPC。
 * 它同时覆盖"rename 失败 → 临时文件必须被清掉"。
 *
 * 注意：只对**同进程**有效。`test/cli.test.mjs` 走的是真子进程，它另用文件系统注入（见该文件）。
 * @param {string} _absPath 仅为调用点可读性保留；本注入与目标无关
 */
let _origRenameSync = null;
function injectWriteFailure(_absPath) {
  if (_origRenameSync) throw new Error('写失败注入还没清除，不许叠加');
  _origRenameSync = fs.renameSync;
  fs.renameSync = () => {
    const e = new Error('ENOSPC: no space left on device, rename');
    e.code = 'ENOSPC';
    throw e;
  };
  return true;
}
function clearInjectedWriteFailure() {
  if (_origRenameSync) { fs.renameSync = _origRenameSync; _origRenameSync = null; }
}

/**
 * 清掉某个目标的**所有**临时兄弟（不论年龄）——只为 fixture 卫生，不参与被测逻辑。
 * 判定用的是被测模块自己导出的 `isTmpSiblingFor`，避免测试与实现各写一份正则而漂移。
 * @param {string} absPath
 */
async function clearTmpSiblings(absPath) {
  const { isTmpSiblingFor } = await import('./core/atomic-write.mjs');
  const dir = path.dirname(absPath);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!isTmpSiblingFor(absPath, n)) continue;
    try { fs.rmSync(path.join(dir, n), { force: true }); } catch { /* 忽略 */ }
  }
}

await atest('W1（R27）：原子写失败 → 目标字节一个都不动，且不留半截临时文件', async () => {
  /**
   * 缺陷态（Lead 实测）：裸 `fs.writeFileSync` 先截断再写，真 ENOSPC 下目标 **42 B → 0 B**，
   * 原内容在抛错之前就没了。原子写让"失败"变成"目标从未被打开过"。
   */
  const { writeFileAtomic, isTmpSiblingFor } = await import('./core/atomic-write.mjs');
  const target = path.join(fixtureRoot, 'wp12-atomic.txt');
  const ORIGINAL = 'X'.repeat(42);
  await clearTmpSiblings(target);
  fs.writeFileSync(target, ORIGINAL, 'utf8');
  const beforeSha = sha256(fs.readFileSync(target));

  const token = injectWriteFailure(target); // 打桩：rename 抛 ENOSPC
  let threw = null;
  try { writeFileAtomic(target, 'NEW-CONTENT'); } catch (e) { threw = e; }
  clearInjectedWriteFailure(token);

  ok(threw, '注入的写失败必须抛出，不许静默成功');
  eq(threw.code, 'ENOSPC',
    `注入的是 rename 抛 ENOSPC，必须原样透出来（实际 ${threw.code}）`);
  eq(fs.readFileSync(target, 'utf8'), ORIGINAL,
    '写失败后目标文件必须逐字节不变（裸 writeFileSync 会先截成 0 B —— 正是实测的 42 B → 0 B）');
  eq(sha256(fs.readFileSync(target)), beforeSha, 'sha256 也必须一致');
  eq(fs.readdirSync(path.dirname(target)).filter((n) => isTmpSiblingFor(target, n)).length, 0,
    '失败后不许把临时文件留在目标目录里 —— 那正是"半截文件"留在用户眼前的来源');

  // 第二半：rename 覆盖一个**已存在的目录**（另一条失败路径）→ 同样不许留残件
  const dirTarget = ensureDir(path.join(fixtureRoot, 'wp12-atomic-dir'));
  await clearTmpSiblings(dirTarget);
  let threw2 = null;
  try { writeFileAtomic(dirTarget, 'NEW'); } catch (e) { threw2 = e; }
  ok(threw2, 'rename 覆盖一个已存在的目录必须失败（本用例的前提）');
  eq(fs.readdirSync(path.dirname(dirTarget)).filter((n) => isTmpSiblingFor(dirTarget, n)).length, 0,
    'rename 失败后同样不许留残件');
});

await atest('W2（R27）：七处写出点全部走 writeFileAtomic（剥注释后，旧的裸写语句必须消失）', async () => {
  /**
   * 「一处实现，六处调用」的另一半：调用点必须**真的**换掉了。
   *
   * 这条**不查"源码里有没有这个词"**，而是双向钉：
   *   · 正向：每个文件里必须出现 `writeFileAtomic(`（删掉调用即红）；
   *   · 反向：每个文件里**原来的那句裸写必须一字不剩**（改回缺陷态即红）。
   * 后者是第三证要求的形状：把 `rename` 那步删掉、留在裸 `writeFileSync` 上 → 必须红。
   *
   * 第七处（`core/engine.mjs` 的 `restoreBaseline`）不在 brief 的六处名单里，
   * 但缺陷同型且是控制台「还原」按钮走的路径 —— 一并钉住，并单独标注。
   */
  const { fileURLToPath } = await import('node:url');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sites = [
    ['src/handles/identity-file.mjs', 'fs.writeFileSync(abs, next, \'utf8\')'],
    ['src/handles/json-field.mjs', 'fs.writeFileSync(abs, w.text, \'utf8\')'],
    ['src/handles/style-file.mjs', 'fs.writeFileSync(st.path, next, \'utf8\')'],
    ['src/handles/prompt-template.mjs', 'fs.writeFileSync(st.path, next, \'utf8\')'],
    ['src/handles/rules.mjs', 'fs.writeFileSync(cur.path, afterText, \'utf8\')'],
    ['src/core/backup.mjs', 'fs.writeFileSync(e.absPath, buf)'],
    ['src/core/engine.mjs', 'fs.writeFileSync(st.path, entry.content, \'utf8\')'],
  ];
  for (const [rel, oldStmt] of sites) {
    const src = stripJsComments(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
    ok(src.includes('writeFileAtomic('), `${rel}：写出点必须调用 writeFileAtomic（否则写失败会把目标截成 0 B）`);
    ok(!src.includes(oldStmt), `${rel}：旧的裸写语句还在（${oldStmt}）—— 改回缺陷态了`);
  }
});

await atest('W3（R27/R28）：真实把手写入失败 → 目标逐字节不变 + 文案说"写入未发生"并带 handle/backupId', async () => {
  const { WRITE_NOT_HAPPENED } = await import('./core/atomic-write.mjs');
  const e = createEngine({ configRoot: cfg, storeRoot: store, appStateProbe: () => false });
  const cases = [
    ['identity-file', 'personalization.soul', `${ORIGINAL_SOUL}\n- WBC-ATOMIC-001\n`, false],
    ['json-field', 'personalization.tone-style', 'creative', false],
    ['style-file', 'style.creative', '风格原子写测试内容。\n', true],
    ['prompt-template', 'prompt.welcomemode-code', '<personal_files_safety>WBC-ATOMIC-001</personal_files_safety>\n', true],
  ];
  for (const [label, id, next, confirm] of cases) {
    const h = registryList().find((x) => x.id === id);
    ok(h, `${label}：找不到把手 ${id}`);
    const st = await h.probe(engineB.ctx);
    const before = fs.readFileSync(st.path);
    const tmp = injectWriteFailure(st.path);
    let threw = null;
    try { await e.apply(id, { next, confirm }); } catch (err) { threw = err; }
    clearInjectedWriteFailure(tmp);

    ok(threw, `${label}：注入的写失败必须抛出`);
    ok(String(threw.message).includes(WRITE_NOT_HAPPENED),
      `${label}：失败文案必须敢说"${WRITE_NOT_HAPPENED}"（原子写之后这是事实），实际：${threw.message}`);
    ok(String(threw.message).includes(id), `${label}：失败文案必须带 handle id，实际：${threw.message}`);
    ok(threw.backupId && String(threw.message).includes(threw.backupId),
      `${label}：异常必须带 backupId 且文案里能看见（用户要能直接复制恢复命令）`);
    ok(String(threw.message).includes(path.basename(st.path)),
      `${label}：失败文案必须带目标路径，实际：${threw.message}`);
    eq(sha256(fs.readFileSync(st.path)), sha256(before),
      `${label}：写失败后目标必须逐字节不变（曾经的缺陷是"报失败、文件却已经被截断"）`);
    // 台账里记的也必须是翻译后的码与文案，否则用户从 audit 里读不出文件状态
    const row = readAudit(store).filter((r) => r.event === 'apply' && r.handle === id && r.status === 'failed').at(-1);
    ok(row, `${label}：写失败必须留 status:"failed" 台账`);
    ok(String(row.error?.message ?? '').includes(WRITE_NOT_HAPPENED),
      `${label}：台账失败行也必须说清文件状态，实际：${JSON.stringify(row.error)}`);
  }
});

await atest('W4（R28）：errno 映射层 —— ENOSPC→DISK_FULL + 状态声明；"不是写失败"不许蹭这句话', async () => {
  /**
   * 真 ENOSPC 由 Lead 的 VHD 台架跑（`.zhll/audit2/gates/lead/e4-enospc.mjs`）；
   * 这里把**映射层**单独钉住：同一个 errno 在两处（HTTP/CLI）必须给出同一句话。
   */
  const { mapWriteError, writeFailureError, WRITE_NOT_HAPPENED } = await import('./core/atomic-write.mjs');
  const ATTEMPTED = Symbol.for('wbc.atomicWrite.attempted');
  const target = path.join(fixtureRoot, 'wp12-map.txt');

  const enospc = mapWriteError(
    Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', path: target, [ATTEMPTED]: true }),
    { handle: 'personalization.soul', absPath: target, backupId: 'bk-wp12-001' },
  );
  eq(enospc.code, 'DISK_FULL', `ENOSPC 必须映射成稳定码 DISK_FULL，实际 ${enospc?.code}`);
  ok(enospc.message.includes(WRITE_NOT_HAPPENED), `ENOSPC 文案必须带状态声明，实际：${enospc.message}`);
  ok(enospc.message.includes('personalization.soul'), `必须带 handle id，实际：${enospc.message}`);
  ok(enospc.message.includes('bk-wp12-001'), `必须带 backupId，实际：${enospc.message}`);
  ok(enospc.message.includes(path.basename(target)), `必须带目标路径，实际：${enospc.message}`);

  // 异常形态：written 必须是 false（与"写已落盘但台账失败"的 written:true 相对）
  const err = writeFailureError(
    Object.assign(new Error('EISDIR: illegal operation on a directory'), { code: 'EISDIR', path: target, [ATTEMPTED]: true }),
    { handle: 'personalization.soul', absPath: target, backupId: 'bk-wp12-002' },
  );
  eq(err.written, false, '写失败异常必须标明"写没有发生"（written:false）');
  eq(err.backupId, 'bk-wp12-002', '异常必须带 backupId');
  eq(err.errno, 'EISDIR', '未归类的 errno 必须原样保留（不许吞掉真实原因）');
  ok(err.message.includes(WRITE_NOT_HAPPENED), '未归类 errno 也必须加**同一句**状态声明');

  // 反向（防"硬说"）：**不是**写尝试失败的读错误不许蹭这句话
  const readErr = Object.assign(new Error('ENOENT: no such file or directory, open'), { code: 'ENOENT', path: target });
  const mappedRead = mapWriteError(readErr, { absPath: target });
  ok(mappedRead, 'ENOENT 仍应给出可判定的码（不回归成 INTERNAL）');
  ok(!mappedRead.message.includes(WRITE_NOT_HAPPENED),
    `读失败不许说"写入未发生"—— 乱说状态声明就是另一种假装：${mappedRead.message}`);
});

await atest('W5（R31）：整文件把手收到 0/false/{}/[]/true → INPUT_INVALID，backups/ 条目数不变', async () => {
  const { listBackups } = await import('./core/backup.mjs');
  const e = createEngine({ configRoot: cfg, storeRoot: store, appStateProbe: () => false });
  const before = fs.readFileSync(SOUL);
  const n0 = listBackups(store).length;

  for (const v of [0, false, {}, [], true]) {
    const nBefore = listBackups(store).length;
    let threw = null;
    try { await e.apply('personalization.soul', { next: v }); } catch (err) { threw = err; }
    ok(threw, `next=${JSON.stringify(v)} 必须被拒（缺陷态：TypeError → code=INTERNAL）`);
    eq(threw.code, 'INPUT_INVALID',
      `next=${JSON.stringify(v)} 应回 INPUT_INVALID（内容提供了、形态不对），实际 ${threw?.code}`);
    eq(listBackups(store).length, nBefore,
      `next=${JSON.stringify(v)} 被拒时**不许**新增备份 —— 孤儿备份正是 R31 的第二个病`
      + `（曾经引擎在调 h.apply 之前就把备份建好了）`);
  }
  eq(listBackups(store).length, n0, '整轮下来 backups/ 条目数必须完全不变');
  eq(sha256(fs.readFileSync(SOUL)), sha256(before), '被拒时 SOUL.md 必须逐字节不变');

  // 反向（P1 不变式不许被"修过头"）：显式 `''` 仍是合法的"清空文件"
  const cleared = await e.apply('personalization.soul', { next: '' });
  eq(fs.readFileSync(SOUL, 'utf8'), '', '显式空串仍必须能清空文件 —— 那是用户意图，是故意的不便');
  eq(cleared.noop, undefined, '清空不是 noop（内容确实变了）');
  fs.writeFileSync(SOUL, before);   // 逐字节复原 fixture
});

await atest('W6（R31 · HTTP 腿）：畸形 next → 400 INPUT_INVALID 且不留孤儿备份；null/缺键仍 INPUT_MISSING', async () => {
  /**
   * 用户真正走的那一层也要钉住（AGENTS.md：同一条契约在 HTTP / 前端 / CLI 三层可能各有绕过路径）。
   * 缺陷态实测：`POST …/apply` body `{"next":0}` → HTTP 400 但 `code=INTERNAL` + 裸 TypeError，
   * 且 `backups/` 里多了一份孤儿备份。
   */
  const { listBackups } = await import('./core/backup.mjs');
  const { WRITE_NOT_HAPPENED } = await import('./core/atomic-write.mjs');
  const app = createConsoleServer({ configRoot: cfg, storeRoot: store });
  const { port } = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'X-WBC-Token': app.token, 'Content-Type': 'application/json' };
  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const before = fs.readFileSync(SOUL);
  try {
    for (const v of [0, false, {}, [], true]) {
      const n0 = listBackups(store).length;
      const r = await post('/api/handle/personalization.soul/apply', { next: v });
      eq(r.status, 400, `next=${JSON.stringify(v)} 必须 400，实际 ${r.status}`);
      const j = await r.json();
      eq(j.ok, false, '响应不许是 ok:true');
      eq(j.error.code, 'INPUT_INVALID', `next=${JSON.stringify(v)} 的错误码应为 INPUT_INVALID，实际 ${j.error.code}`);
      ok(!/INTERNAL/.test(j.error.code), '不许再回 INTERNAL');
      eq(listBackups(store).length, n0, `next=${JSON.stringify(v)} 被拒时不许留下孤儿备份`);
    }
    eq(sha256(fs.readFileSync(SOUL)), sha256(before), '整轮被拒后 SOUL.md 必须逐字节不变');

    // P1 不变式仍在：null / 缺键 → INPUT_MISSING
    eq((await (await post('/api/handle/personalization.soul/apply', { next: null })).json()).error.code,
      'INPUT_MISSING', 'null 仍按"没传"处理');
    eq((await (await post('/api/handle/personalization.soul/apply', {})).json()).error.code,
      'INPUT_MISSING', '缺键仍是 INPUT_MISSING');
    // 显式空串仍放行（不许"修过头"）
    eq((await post('/api/handle/personalization.soul/apply', { next: '' })).status, 200,
      '显式 next:"" 仍是合法清空');
    fs.writeFileSync(SOUL, before);

    // R28 的 HTTP 腿：注入写失败 → 400 + 文案说清文件状态 + 文件不变
    const tmp = injectWriteFailure(SOUL);
    const nFail = listBackups(store).length;
    let jf = null;
    try {
      jf = await (await post('/api/handle/personalization.soul/apply', { next: 'WBC-WP12-HTTP-FAIL\n' })).json();
    } finally { clearInjectedWriteFailure(tmp); }
    eq(jf.ok, false, '写失败不许回 ok:true');
    ok(String(jf.error.message).includes(WRITE_NOT_HAPPENED),
      `HTTP 腿的写失败文案也必须说清文件状态，实际：${jf.error?.message}`);
    ok(String(jf.error.message).includes('personalization.soul'), 'HTTP 腿文案必须带 handle id');
    eq(sha256(fs.readFileSync(SOUL)), sha256(before), '写失败后 SOUL.md 必须逐字节不变');
    eq(listBackups(store).length, nFail + 1,
      '写失败时备份是**该有的**（铁律 1：先备份后写），与"畸形输入不留孤儿备份"不是一回事');
  } finally {
    fs.writeFileSync(SOUL, before);
    await app.close();
  }
});

await atest('W7（R31 · 档位）：手搓档位里的畸形值在建备份之前被拒，backups/ 不变', async () => {
  /**
   * 档位对象可以是**手搓**的（`applyProfile` 不做 assertProfile，见 F1 断言的由来），
   * 所以畸形值这条入口在档位链上同样成立 —— 引擎在 `createBackup` 之前就该拒。
   */
  const { listBackups } = await import('./core/backup.mjs');
  const e = createEngine({ configRoot: cfg, storeRoot: store, appStateProbe: () => false });
  const before = fs.readFileSync(SOUL);
  const n0 = listBackups(store).length;
  let threw = null;
  try {
    await e.applyProfile({ id: 'wp12-bad-profile', name: '畸形档位', values: { 'personalization.soul': 0 } });
  } catch (err) { threw = err; }
  ok(threw, '手搓档位里的畸形值必须被拒');
  eq(threw.code, 'INPUT_INVALID', `错误码应为 INPUT_INVALID，实际 ${threw?.code}`);
  eq(listBackups(store).length, n0, '必须在建备份之前拒掉（否则档位链又造出一份孤儿备份）');
  eq(sha256(fs.readFileSync(SOUL)), sha256(before), 'SOUL.md 不许变');
});

await atest('W8（R27 · 还原写回）：还原时写回失败 → 目标不被打断成 0 B，条目错误说清文件状态', async () => {
  /**
   * 第七处写出点（`core/backup.mjs` 的 restore 写回）。缺陷态：裸 writeFileSync 先截断 ——
   * "还原"在半途失败会把用户**当前**的内容清成 0 字节，比不还原更糟。
   */
  const { createBackup } = await import('./core/backup.mjs');
  const { WRITE_NOT_HAPPENED } = await import('./core/atomic-write.mjs');
  const target = path.join(fixtureRoot, 'wp12-restore-target.txt');
  const ORIGINAL = 'RESTORE-ORIGINAL-42-BYTES-0123456789\n';
  const CURRENT = 'RESTORE-CURRENT-DRIFTED-CONTENT-ABCDEF\n';
  fs.rmSync(target, { force: true });
  await clearTmpSiblings(target);
  fs.writeFileSync(target, ORIGINAL, 'utf8');

  const manifest = createBackup({
    storeRoot: store, reason: 'wp12 restore atomic', entries: [{ key: 'wp12.restore', absPath: target }],
  });
  fs.writeFileSync(target, CURRENT, 'utf8');   // 备份后漂移 → 还原一定会写回

  const tmp = injectWriteFailure(target);
  let r = null;
  try { r = engine.restore(manifest.id); } finally { clearInjectedWriteFailure(tmp); }

  eq(fs.readFileSync(target, 'utf8'), CURRENT,
    '写回失败时目标必须是"还原前的原样"，绝不许是被截断的半截文件');
  const bad = r.results.find((x) => x.key === 'wp12.restore');
  eq(bad?.ok, false, '该条目必须记为失败');
  ok(String(bad.error?.message ?? '').includes(WRITE_NOT_HAPPENED),
    `条目错误必须说清文件状态，实际：${JSON.stringify(bad.error)}`);
  eq(r.status, 'failed', `整体 status 应为 failed（实际 ${r.status}）`);
  const row = readAudit(store).filter((x) => x.event === 'restore' && x.backupId === manifest.id).at(-1);
  eq(row.status, 'failed', '台账同样必须如实记 failed');
  ok(String(row.failed?.[0]?.message ?? '').includes(WRITE_NOT_HAPPENED), '台账失败明细里也要有状态声明');
});

await atest('W9（R28）：errno 映射**只有一份** —— HTTP 不再自带 ENOSPC 分支，CLI 也调同一个函数', async () => {
  /**
   * 曾经：`server.mjs` 独占一份 `DISK_FULL` 映射，CLI 什么都没有 ——
   * 同一个 ENOSPC，浏览器里是一句人话，命令行里是裸 `Error: ENOSPC …` + 栈。
   * 这条钉住"同一层只留一份"：删掉任一侧的调用/守卫即红。
   */
  const { fileURLToPath } = await import('node:url');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const server = stripJsComments(fs.readFileSync(path.join(repoRoot, 'src/server.mjs'), 'utf8'));
  const cli = stripJsComments(fs.readFileSync(path.join(repoRoot, 'src/cli.mjs'), 'utf8'));
  ok(server.includes('mapWriteError('), 'HTTP 腿必须调共享的 mapWriteError');
  ok(!server.includes('ENOSPC'),
    'HTTP 腿不许再自带 errno 分支（映射表只留一份，反例就是曾经那句 DISK_FULL）');
  ok(cli.includes('mapWriteError('), 'CLI 腿必须调共享的 mapWriteError（曾经它连一句话都没有）');
});

await atest('W10（R27）：临时文件写不进去（父目录不存在）→ 目标不动、不留残件、不顺手造目录', async () => {
  /**
   * 这一条与 W1 是**两条不同的失败路径**，别混为一谈：
   *   · W1 注入的是"tmp 写成功、**rename** 失败"（只读目标）；
   *   · W10 注入的是"**tmp 写就失败**"（父目录根本不存在）。
   * 真 ENOSPC 落在哪一支取决于盘满发生在哪一步，两条都得有断言。
   */
  const { writeFileAtomic } = await import('./core/atomic-write.mjs');
  const missingDir = path.join(fixtureRoot, 'wp12-no-such-dir');
  fs.rmSync(missingDir, { recursive: true, force: true });
  const target = path.join(missingDir, 'x.txt');
  let threw = null;
  try { writeFileAtomic(target, 'NEW'); } catch (e) { threw = e; }
  ok(threw, '父目录不存在时必须抛，不许静默成功');
  ok(!fs.existsSync(missingDir), '不存在的父目录不许被顺手造出来（写盘只负责写文件）');
});

await atest('W11（R27 · 并发冒烟）：多进程同写同一目标 → 终值永远是**一份完整内容**，绝不混合/半截', async () => {
  /**
   * 固定临时名（`<目标>.tmp`）时的真实危害：
   *   A 写 tmp 完整 → B 把 tmp 截断重写 → A 的 rename 搬走的是 **B 的临时文件**
   *   ⇒ 目标上是 B 的内容、而 A 报了成功（内容错配 + 假成功），B 再 rename 拿到 ENOENT。
   *
   * ⚠️ 这条只能当**冒烟**，不能当确定性守卫 —— 确定性守卫是 W13 的契约断言。原因：
   *   Windows 上两个进程同时 `rename` 到同一个目标时，可能有一个拿到**瞬时 EPERM**
   *   （目标在另一方的 rename 期间被占用）。实测：4 进程 × 60 次 × 200 KB，
   *   **唯一名方案下也仍有 2–3 个进程在某一轮拿到 EPERM**。那不是本缺陷，
   *   是平台行为：并发写同一目标，调用方本来就该重试。
   *   ⇒ 所以这里**不许**断言"无一失败"（那样正确实现也红，是本断言的第一版踩的坑）。
   *
   * 断言的是用户真正在意的不变量：**目标永远是一份完整内容**（不混合、不半截），
   * 失败也是**明确的系统错误**而不是假成功。内容错配是竞态，稳定断言不了，
   * 由 W13 从契约层（临时名唯一）确定性地钉住。
   */
  const { isTmpSiblingFor } = await import('./core/atomic-write.mjs');
  const target = path.join(fixtureRoot, 'wp12-race.txt');
  await clearTmpSiblings(target);
  fs.writeFileSync(target, 'INIT', 'utf8');

  const childFile = path.join(os.tmpdir(), `wbc-atomic-race-${process.pid}.mjs`);
  fs.writeFileSync(childFile, [
    `import { writeFileAtomic } from ${JSON.stringify(new URL('./core/atomic-write.mjs', import.meta.url).href)};`,
    'const [target, id, n, kb] = process.argv.slice(2);',
    // payload 必须**够大**：竞态窗口正比于"写临时文件"的耗时，十几字节的窗口太窄，
    // 连固定名都撞不出来（实测：8 KB 起才稳定复现）。200 KB 也不是虚构 ——
    // 风格正文 / 提示词模板本来就是这个量级。
    'const payload = "W".repeat(Number(kb) * 1024);',
    'for (let i = 0; i < Number(n); i += 1) writeFileAtomic(target, `${payload}WRITER-${id}-${i}`);',
    '',
  ].join('\n'), 'utf8');

  const WRITERS = 4;
  const ITERS = 60;
  const KB = 200;
  /**
   * ⚠️ 必须用**异步** `spawn` 并发起、再一起等：`spawnSync` 是**串行**的，
   * 四个子进程会一个跑完再跑下一个 —— 那样这条断言"看着在测并发，其实在测串行"，
   * 改成固定临时名也照样全绿（第一版就是这么空转的，被三证的①抓出来）。
   */
  const spawnAsync = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => resolve({ status: code, stderr: err }));
    p.on('error', (e) => resolve({ status: -1, stderr: String(e) }));
  });
  const runs = await Promise.all(
    Array.from({ length: WRITERS }, (_, id) => spawnAsync([childFile, target, String(id), String(ITERS), String(KB)])),
  );
  fs.rmSync(childFile, { force: true });

  const okRuns = runs.filter((r) => r.status === 0);
  const failed = runs.filter((r) => r.status !== 0);
  ok(okRuns.length >= 1, `至少要有一个写者成功，实际 ${okRuns.length}/${WRITERS}`);
  for (const r of failed) {
    ok(/EPERM|EACCES|ENOENT|EBUSY/.test(r.stderr),
      `失败必须是可识别的系统错误（并发下允许瞬时 EPERM），实际：${r.stderr.split('\n').slice(0, 2).join(' | ')}`);
  }
  const content = fs.readFileSync(target, 'utf8');
  ok(new RegExp(`^W{${KB * 1024}}WRITER-\\d+-\\d+$`).test(content),
    `终值必须是一份**完整**的单写者内容（混合/半截就是互踩），实际长度 ${content.length}、开头 ${content.slice(0, 20)}`);
  eq(fs.readdirSync(path.dirname(target)).filter((n) => isTmpSiblingFor(target, n)).length, 0,
    '并发写完之后不许留残件');
});

await atest('W12（R27 · 崩溃残件）：只清"旧的"，绝不动"刚写的"', async () => {
  /**
   * 唯一名的代价：崩溃残件不再被下次写覆盖，所以要主动清 —— 但清了"正在写的"就是新缺陷。
   * 这条钉的就是那个边界：超过 `STALE_TMP_MS` 的清掉，阈值以内的**一个都不许动**。
   */
  const { sweepStaleTmpFor } = await import('./core/atomic-write.mjs');
  const target = path.join(fixtureRoot, 'wp12-sweep.txt');
  await clearTmpSiblings(target);
  fs.writeFileSync(target, 'X', 'utf8');

  const oldTmp = `${target}.1111.deadbeef.tmp`;
  const freshTmp = `${target}.2222.cafebabe.tmp`;
  fs.writeFileSync(oldTmp, 'stale', 'utf8');
  fs.writeFileSync(freshTmp, 'in-flight', 'utf8');
  const twoHoursAgo = Date.now() / 1000 - 7200;
  fs.utimesSync(oldTmp, twoHoursAgo, twoHoursAgo);

  const removed = sweepStaleTmpFor(target);
  eq(removed.length, 1, `只应清掉 1 个（旧的），实际清了 ${removed.length} 个：${removed.join(',')}`);
  ok(!fs.existsSync(oldTmp), '超过阈值的残件必须被清掉（否则唯一名会在用户目录里攒垃圾）');
  ok(fs.existsSync(freshTmp), '阈值以内的**绝不许动** —— 那可能是另一个进程正在写的');
  await clearTmpSiblings(target);
});

await atest('W13（R27 · 临时名契约）：同一目标的两次取值必须不同、同目录、且能被模式认出来', async () => {
  /**
   * W11 是**行为**证据（真子进程撞车）；这条是**契约**证据（不依赖时序，永远可复现）。
   * 两条一起才完整：只留 W11 会因窗口概率而偶发漏判，只留这条会丢掉"真的不会互踩"的行为证明。
   */
  const { tmpPathFor, isTmpSiblingFor } = await import('./core/atomic-write.mjs');
  const target = path.join(fixtureRoot, 'wp13-contract.txt');
  const a = tmpPathFor(target);
  const b = tmpPathFor(target);
  ok(a !== b, `同一目标的两次临时名必须不同（固定名会让两个进程互踩），实际都是 ${path.basename(a)}`);
  eq(path.dirname(a), path.dirname(target),
    '临时文件必须与目标**同目录** —— 跨卷 rename 会退化成复制，原子性没了');
  ok(isTmpSiblingFor(target, path.basename(a)), `自己造的临时名必须能被 isTmpSiblingFor 认出：${path.basename(a)}`);
  ok(a.includes(`.${process.pid}.`), `临时名必须带 pid（进程间隔离），实际 ${path.basename(a)}`);
  ok(!isTmpSiblingFor(target, `${path.basename(target)}.tmp`),
    '旧的固定名 `<目标>.tmp` **不许**被认成合法临时名（否则清理会误删别人留下的东西）');
});

console.log('\n【R39】隔离一致性：--root 只换配置树，厂商面另有一棵树');

await atest('I1（R39）：厂商面的合法落点是**两棵树**，两棵都不在才算"逃逸"', async () => {
  /**
   * 这条钉的是判据本身。第一版写成"不在配置根下就算逃逸"——**错的**：
   * 7 个 `style-*.md` 按设计就住在独立的安装树里，而 3 个 `prompt.tpl` 住在配置树的插件缓存里。
   * 那条判据会把**正确隔离**也报成不一致（实测：给了 INSTALL_DIR 指向镜像，仍报 7 个不一致）。
   * 正确判据：落在**配置根**或**你指定的安装根**任意一棵里 = 隔离住了；两棵都不在 = 指向真实安装目录。
   */
  const { findVendorEscapes } = await import('./core/isolation.mjs');
  const cfgRoot = path.join(fixtureRoot, 'r39-cfg');
  const installRoot = path.join(fixtureRoot, 'r39-install');
  const realInstallStyle = 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\resources\\templates\\style';
  const handles = [
    // 落在**你指定的安装根**里 → 隔离住了
    { id: 'style.isolated', writeClass: 'vendor-file', anchorPath: path.join(installRoot, 'resources', 'app.asar.unpacked', 'resources', 'templates', 'style', 'style-isolated.md') },
    // 落在**真实安装目录**（两棵树都不在）→ 逃逸
    { id: 'style.escaped', writeClass: 'vendor-file', anchorPath: path.join(realInstallStyle, 'style-escaped.md') },
    // 落在**配置树**的插件缓存里 → 合法（prompt.tpl 按设计就住这儿）
    { id: 'prompt.in-config', writeClass: 'vendor-file', anchorPath: path.join(cfgRoot, 'plugins', 'cache', 'builtin', 'welcomemode-code', '5.9.3', 'prompt.tpl') },
    // 非厂商面 → 永远不参与
    { id: 'personalization.soul', writeClass: 'user-data', anchorPath: path.join(cfgRoot, 'user-x', 'SOUL.md') },
  ];

  // ① 给了**正确的**安装根：只有真机那个逃逸，隔离住的那个不算 —— 这条就是第一版会红的地方
  const withRoot = findVendorEscapes(handles, { configRoot: cfgRoot, installRoot });
  eq(withRoot.map((e) => e.id).join(','), 'style.escaped',
    `给了正确安装根时只该报真机那个，实际：${withRoot.map((e) => e.id).join(',') || '（无）'}`);
  eq(withRoot[0].reason, 'outside-both-roots', '给了安装根时的原因码');

  // ② 没给安装根：安装树里的两个都隔离不了；配置树里的 prompt 与非厂商面**都不该混进来**
  const noRoot = findVendorEscapes(handles, { configRoot: cfgRoot, installRoot: null });
  eq(noRoot.map((e) => e.id).sort().join(','), 'style.escaped,style.isolated',
    `没给安装根时安装树里的两个都该报，实际：${noRoot.map((e) => e.id).join(',') || '（无）'}`);
  ok(!noRoot.some((e) => e.id === 'prompt.in-config'),
    '配置树里的厂商面（prompt.tpl）**不该**被当成逃逸 —— 它本来就在配置树里');
  ok(!noRoot.some((e) => e.id === 'personalization.soul'), '非厂商面（user-data）永远不参与');
  ok(noRoot.every((e) => e.reason === 'no-install-root'), '没给安装根时的原因码');
});

await atest('I2（R39）：只在"你显式给了 --root"时才提示 —— 默认根下写真机是**正确**行为，不许当噪音', async () => {
  const { isolationWarning } = await import('./core/isolation.mjs');
  const escapes = [{ id: 'style.a', path: 'C:\\Program Files\\WorkBuddy\\x\\style-a.md', reason: 'no-install-root' }];

  eq(isolationWarning({ escapes, configRoot: 'C:\\cfg', installRoot: null, requestedRoot: null }), null,
    '没给 --root 时必须**一个字都不提示**（那时写真实安装目录是正确行为，提示会变噪音）');
  eq(isolationWarning({ escapes, configRoot: 'C:\\cfg', installRoot: null, requestedRoot: 'C:\\mirror' })?.length > 0, true,
    '给了 --root 且厂商面逃逸时必须有内容');
  eq(isolationWarning({ escapes: [], configRoot: 'C:\\cfg', installRoot: 'D:\\inst', requestedRoot: 'C:\\mirror' }), null,
    '给了 --root 但厂商面都被隔离住时，不该提示');
});

console.log('\n【R38/R40/R44】字段同物异名 · 改动清单完整性 · plan 预检不得假阳性');

await atest('J1（R38）：token 估算字段必须**同名** —— 哪个把手用了别的名字，就会打崩 CLI 默认输出', async () => {
  /**
   * 病根是**同物异名**：`rules.mjs` 曾经叫 `token`，其余把手叫 `tokens`，
   * 而 `cli.mjs` 的 probe 打印读 `state.tokens.tokens` ⇒ 三个 rules 把手的默认输出直接
   * `TypeError` 崩栈（`--json` 不崩，所以长期没被发现）。
   * 这条钉的是**类别**而不是那一个把手：任何把手都不许再用 `token` 这个名字。
   */
  const e = createEngine({ configRoot: cfg, storeRoot: store, appStateProbe: () => false });
  const bad = [];
  for (const h of registryList()) {
    /**
     * ⚠️ 这里调的是**把手自己的** `probe`，它直接返回 state 本身；
     * `engine.probe()` 才返回 `{handle, state}` 包装。第一版把这个搞混了，
     * 写成 `st.state` ⇒ 一直在检查一个空对象 ⇒ **断言恒绿**（三证①当场抓出）。
     */
    const s = await h.probe(e.ctx);
    if (s && typeof s === 'object' && 'token' in s) bad.push(h.id);
  }
  eq(bad.join(','), '', `这些把手的估算字段叫 token（应为 tokens）：${bad.join(',') || '（无）'}`);
});

await atest('J2（R38）：`probe rules.*` 默认输出必须 exit 0 且打出「估算 token」', async () => {
  // 行为断言：真起 CLI 子进程，走人真正会用的那条**默认输出**路径（`--json` 本来就不崩，不算数）
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [cli, 'probe', 'rules.file', '--root', cfg, '--store', store], {
    encoding: 'utf8', timeout: 30000,
  });
  const all = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  eq(r.status, 0, `probe rules.file 必须 exit 0，实际 ${r.status}：${all.slice(0, 200)}`);
  ok(/估算 token/.test(r.stdout ?? ''), `默认输出必须打出「估算 token」一栏：${(r.stdout ?? '').slice(0, 200)}`);
  ok(!/未预期的错误/.test(all), `不许再出现「未预期的错误」：${all.slice(0, 200)}`);
});

await atest('J3（R40）：`customized` 被翻动必须计进改动清单 —— 否则调用方少报一处真实改动', async () => {
  const { writeDomainRules } = await import('./core/rules.mjs');
  const mk = (customized) => JSON.stringify({
    sandbox: {
      orderedRules: {
        file: {
          ...(customized === undefined ? {} : { customized }),
          rules: [{ path: 'x', read: 'ask', write: 'ask', delete: 'ask' }],
        },
      },
    },
  }, null, 2);
  const newRules = [{ path: 'x', read: 'allow', write: 'ask', delete: 'ask' }];

  eq(writeDomainRules(mk(false), 'file', newRules).customizedFlipped, true,
    'customized 原本 false → 这次写真的会翻它，必须报 true');
  eq(writeDomainRules(mk(true), 'file', newRules).customizedFlipped, false,
    'customized 本来就是 true → 没翻，必须报 false');
  /**
   * 第三个用例必须走**定点替换**那一支：那里用正则只在"字段已存在"时改写，不会替它新增。
   * 所以要造一份**非规范格式**（紧凑 JSON）——否则会走 reserialize 分支，而那一支
   * 是通过 `{...dom, customized: true}` 展开写回的，等于**必然新增**这个键（那是真翻了，该报 true）。
   */
  const compactNoKey = JSON.stringify({ sandbox: { orderedRules: { file: { rules: [{ path: 'x', read: 'ask', write: 'ask', delete: 'ask' }] } } } });
  const targeted = writeDomainRules(compactNoKey, 'file', newRules);
  eq(targeted.mode, 'targeted', `这份紧凑 JSON 应走定点替换（实际 ${targeted.mode}）`);
  eq(targeted.customizedFlipped, false,
    '定点替换下目标里没有 customized 键 → 不会替它新增，必须报 false（不许虚报）');
  ok(typeof writeDomainRules(mk(false), 'file', newRules).text === 'string', '仍然要返回文本');
});

await atest('J4（R44①）：命中 0 条时 preview 必须报 willFail —— plan 不许比 apply 乐观', async () => {
  /**
   * ⚠️ 必须自带一份**独立 fixture**：本断言块在文件末尾，前面那些规则测试已经把共享 fixture
   * 的 `ask` 规则改成 `allow` 了（实测：拿共享 fixture 跑，"有命中"那条会 changed=0 而误红）。
   * 测试之间靠 fixture 传状态是最脆的耦合，这里直接自己造一份。
   */
  const h = registryList().find((x) => x.id === 'rules.file');
  const dir = ensureDir(path.join(fixtureRoot, 'j4-rules'));
  // 复制共享 fixture 的锚点结构（插件缓存 / 用户目录），只把 settings.json 换成自己的一份。
  // 不能只造一个空目录：引擎探测不到 WorkBuddy 版本会**硬拒绝猜测**（那是正确行为）。
  fs.cpSync(cfg, dir, { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), `${JSON.stringify({
    sandbox: {
      orderedRules: {
        file: { presetVersion: 4, customized: false, rules: [{ path: '~/.ssh/', read: 'ask', write: 'ask', delete: 'ask' }] },
        command: { presetVersion: 1, customized: false, rules: [] },
        network: { presetVersion: 1, customized: false, rules: [] },
      },
    },
  }, null, 2)}\n`, 'utf8');
  const e = createEngine({ configRoot: dir, storeRoot: store, appStateProbe: () => false });

  const yes = await h.preview(e.ctx, { next: { from: 'ask', to: 'allow', actions: ['read'] } });
  ok(yes.changed >= 1, `有命中时 changed 应 ≥1（实际 ${yes.changed}）`);
  eq(yes.willFail, null, '有命中时不该报 willFail');

  // 用一条必然匹配不到的 paths 过滤造"命中 0 条"
  const no = await h.preview(e.ctx, {
    next: { from: 'ask', to: 'allow', actions: ['read'], paths: ['C:\\__wbc_no_such_path__'] },
  });
  eq(no.changed, 0, `命中 0 条时 changed 应为 0（实际 ${no.changed}）`);
  eq(no.willFail?.code, 'NO_RULES_MATCHED',
    `命中 0 条时 preview 必须报出 apply 会拒绝（实际 ${JSON.stringify(no.willFail ?? null)}）`);
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
