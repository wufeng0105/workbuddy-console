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
  eq(p.baselineSession.startSource, 'first-request', '无目录时间时应标注为次优信号');
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

await atest('基线与观测模型不同 → 告警（模型不同则静态前缀不同）', async () => {
  const { autoCapture } = await import('./verify/auto-capture.mjs');
  fs.rmSync(tracesDir, { recursive: true, force: true });
  SESS.clear();
  SESS.set('111', applyAtMs - 120000);
  SESS.set('222', applyAtMs + 5000);
  writeTrace('111', 'r1.jsonl', new Date(applyAtMs - 115000).toISOString(), CHAT_MODEL, 1000);
  writeTrace('222', 'r1.jsonl', new Date(applyAtMs + 10000).toISOString(), 'other-model', 1000 + EXP);
  const cap = autoCapture({ configRoot: cfg, applyAtMs, expectedDelta: EXP, sessionStartOf: startOf });
  ok(cap.warnings.some((w) => /模型不同/.test(w)), `应给出模型不同告警：${JSON.stringify(cap.warnings)}`);
});

// ══════════════ P1a：个性化五项 ══════════════
console.log('\n【8】P1a · 个性化五项（SOUL / USER / IDENTITY / toneStyle / customPrompt）');

// 造一个"安装目录"fixture：style 七档
const installRoot = ensureDir(path.join(fixtureRoot, 'install'));
const styleDir = ensureDir(path.join(installRoot, 'resources', 'app.asar.unpacked', 'resources', 'templates', 'style'));
const STYLE_TEXT = {
  efficient: '高效务实：先答案后背景，列表优先。',
  creative: `天马行空：${'想象力叙事流，把解题当冒险，用比喻设景，适度 emoji。'.repeat(8)}`,
};
for (const [id, text] of Object.entries(STYLE_TEXT)) {
  fs.writeFileSync(path.join(styleDir, `style-${id}.md`), text, 'utf8');
}
process.env.WORKBUDDY_CONSOLE_INSTALL_DIR = installRoot;

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
  ok(pl.preview.injectedChars === STYLE_TEXT.creative.length, '注入字符数应等于 style 文件长度');
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
