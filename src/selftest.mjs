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
  ok(html.includes('workbuddy-console'), '首页内容不符');
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

  const rs = await (await post('/api/restore', { backupId: ap.data.backupId })).json();
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
  eq(pl.preview.changed, 3, `应命中 3 条，实际 ${pl.preview.changed}`);
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
  eq(rulesApply.changed, 3, '应改 3 条');
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
  eq(ap.changed, 1, '只应改 1 条');
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
