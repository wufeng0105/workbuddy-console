#!/usr/bin/env node
/**
 * 契约门禁 —— **真断言**（残余 R9 / F16）。
 *
 * 为什么需要本文件：原来的 `check:contracts` 是
 *   node -e "import('./src/core/contracts.mjs').then(m=>console.log(...))"
 * 它只**打印条数**，`process.exitCode` 永远是 0 —— 把 `HANDLE_STEPS` 清空、
 * 把 `VERIFY_STRATEGIES` 删光，门禁照样「绿」。一条不可能失败的门禁不是门禁。
 *
 * 本文件把「框架契约」翻译成会失败的断言（任一不满足 → exit 1 并打印是哪条）：
 *   ① HANDLE_STEPS 恰好 6 项，名字与顺序与 `docs/framework.md`「把手的六步」一致
 *   ② VERIFY_STRATEGIES 里每个策略要么**有实现**、要么被**显式标注未实现**（不许默默放行）
 *   ③ 注册表里每个把手都过 `assertHandle`（且 ALL_HANDLES 真的都注册上了）
 *   ④ 每个把手声明的 `verification.strategy` 必须是**有实现**的策略
 *   ⑤ `DRIFT_KINDS` 与 `replay.detectDrift` **实际产出**的漂移 kind 双向对账
 *      （排除 `unchanged` / `handle-missing` 两个非漂移分类）：产出 ⊄ 常量 → 红；
 *      常量里有 kind 没有生产者 → 必须被**显式标注**（残余 R7），忘标 → 红；标注过期 → 红。
 *
 * ⑤ 为什么也走「显式标注」：残余 R7（`value-changed` / `mode-dependent` 常量里有、全库没有生产者）
 * 是**已知未兑现**项，登记在 `DOC-OUTLINE.md` R7、修复排在 P5/WP13；本文件不允许改
 * `contracts.mjs` / `replay.mjs`。若照字面写「两侧差集必须空」，门禁会长期常红 —— 那等于把门禁
 * 变成噪声。所以把「无生产者」这一侧显式冻结成标注：**它仍然会让新缺陷变红**（新 kind 没生产者
 * 且没标注 → 红；谁补了生产者却忘了删标注 → 红），只是不替 P5 提前修 R7。
 *
 * 为什么 ⑤ 不读源码正则：本项目踩过两次「常量与实际产出不同源」的坑（残余 R7）。
 * 读源码正则只能证明「字面量写在那里」，证明不了「真的产得出来」。这里**真跑一遍**
 * `buildBundle` + `detectDrift`，把 5 种 kind 都造出来，再对账。
 *
 * 零依赖、纯 ESM、不写仓库内任何文件（临时目录用完即删）。
 * 运行：npm run check:contracts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 未被实现的验证策略 —— **显式标注**，不是放行。
 *
 * 残余 R2：`render-log`（渲染日志，辅助策略）只有声明、没有实现文件。
 * 正确形态是「3 个有实现 + 1 个显式标未实现」：标在这里，谁新增了实现就必须把它删掉
 * （下面会检查标注是否过期），谁新增了未实现策略而忘了标注，门禁会红。
 *
 * @type {Map<string,string>}
 */
const UNIMPLEMENTED_STRATEGIES = new Map([
  ['render-log', '渲染日志辅助策略尚无实现文件（docs/verification.md 的三种有实现策略不含它）：声明它的把手不允许上线。'],
]);

/** 常量里声明、但**没有任何生产者**的漂移 kind —— 显式冻结残余 R7，不是放行。
 *
 * 证据：`docs/framework.md` 状态契约那节自己写着「常量里的 `value-changed` / `mode-dependent`
 * 全库没有生产者」；登记在 `DOC-OUTLINE.md` 残余 R7，修复排在 P5/WP13。
 * 标注不是豁免：谁给它们补上生产者，就必须同时删掉这里的标注（下面检查「标注过期」）。
 *
 * @type {Map<string,string>}
 */
const UNPRODUCED_DRIFT_KINDS = new Map([
  ['value-changed', '常量声明「值已变（被外部改动，如 toneStyle）」，但 detectDrift 只产 vendor-restored，全库无生产者（残余 R7 → P5/WP13：补生产者或删声明）。'],
  ['mode-dependent', '常量声明「模式相关失效（如 IDENTITY.md 专家模式不注入）」，目前只在文档与把手标注里体现，无漂移生产者（残余 R7 → P5/WP13）。'],
]);

const failures = [];
/** @param {string} id @param {() => (string|void|Promise<string|void>)} fn */
async function check(id, fn) {
  try {
    const note = await fn();
    console.log(`  ✅ ${id}${note ? `  —— ${note}` : ''}`);
  } catch (e) {
    failures.push({ id, message: e?.message ?? String(e) });
    console.log(`  ❌ ${id}\n       ${e?.message ?? e}`);
  }
}

/** @param {any} cond @param {string} msg */
function ok(cond, msg) { if (!cond) throw new Error(msg); }

const contracts = await import(new URL('../src/core/contracts.mjs', import.meta.url));
const { HANDLE_STEPS, DRIFT_KINDS, VERIFY_STRATEGIES, assertHandle } = contracts;
const indexMod = await import(new URL('../src/handles/index.mjs', import.meta.url));
const registry = await import(new URL('../src/core/registry.mjs', import.meta.url));
const replay = await import(new URL('../src/core/replay.mjs', import.meta.url));

console.log(`\n契约门禁（真断言）  ${path.join(ROOT, 'scripts', 'check-contracts.mjs')}\n`);

// ── 前置：实现清单（扫 src/verify/*.mjs 的 *Strategy.id，**导入真实模块**，不读源码文本）──
const verifyDir = path.join(ROOT, 'src', 'verify');
const implemented = new Set();
const implFiles = new Map();
for (const f of fs.readdirSync(verifyDir).filter((x) => x.endsWith('.mjs'))) {
  const mod = await import(pathToFileURL(path.join(verifyDir, f)).href);
  for (const [name, v] of Object.entries(mod)) {
    if (!/Strategy$/.test(name) || !v || typeof v !== 'object' || typeof v.id !== 'string') continue;
    if (!implemented.has(v.id)) implFiles.set(v.id, `src/verify/${f}`);
    implemented.add(v.id);
  }
}

// ── ① 六步：恰好 6 项，名字与顺序与 docs/framework.md 一致 ──
await check('① HANDLE_STEPS 恰好 6 项且与 docs/framework.md「把手的六步」同名同序', () => {
  ok(Array.isArray(HANDLE_STEPS), 'HANDLE_STEPS 不是数组');
  ok(HANDLE_STEPS.length === 6, `HANDLE_STEPS 必须恰好 6 项，实际 ${HANDLE_STEPS.length} 项：${JSON.stringify(HANDLE_STEPS)}`);

  const fw = fs.readFileSync(new URL('../docs/framework.md', import.meta.url), 'utf8');
  const start = fw.indexOf('### 把手契约（六步）');
  ok(start >= 0, 'docs/framework.md 找不到「### 把手契约（六步）」小节 —— 文档改了名就要同步本门禁');
  const rest = fw.slice(start + 1);
  const endRel = rest.indexOf('\n### ');
  const block = endRel >= 0 ? rest.slice(0, endRel) : rest;
  const docSteps = [...block.matchAll(/^\s*(\d+)\.\s+([a-z][a-zA-Z]*)\(\)/gm)]
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => m[2]);
  ok(docSteps.length === 6,
    `docs/framework.md 的六步应解析出 6 条，实际 ${docSteps.length} 条：${JSON.stringify(docSteps)}（文档格式变了就要同步本门禁）`);
  const want = docSteps.join(',');
  const got = HANDLE_STEPS.join(',');
  ok(got === want,
    `HANDLE_STEPS 与 docs/framework.md 不一致：\n         代码 ${JSON.stringify(HANDLE_STEPS)}\n         文档 ${JSON.stringify(docSteps)}`);
  return 'probe → preview → backup → apply → verify → restore（代码与文档同源）';
});

// ── ② 策略：有实现，或被显式标注未实现 ──
await check('② VERIFY_STRATEGIES 每个策略要么有实现文件、要么被显式标注未实现', () => {
  ok(Array.isArray(VERIFY_STRATEGIES) && VERIFY_STRATEGIES.length > 0, 'VERIFY_STRATEGIES 为空/非法');
  ok(implemented.size >= 3,
    `src/verify/ 下只扫到 ${implemented.size} 个有实现的策略（应 ≥3）—— 扫描失效会让本门禁整体放行，必须先修`);
  const unaccounted = VERIFY_STRATEGIES.filter((s) => !implemented.has(s) && !UNIMPLEMENTED_STRATEGIES.has(s));
  ok(unaccounted.length === 0,
    `这些策略既无实现、也未显式标注未实现（不许默默放行）：${unaccounted.join(', ')}\n`
    + `         有实现的：${[...implemented].join(', ')}\n`
    + `         显式标未实现：${[...UNIMPLEMENTED_STRATEGIES.keys()].join(', ') || '(无)'}`);
  const stale = [...UNIMPLEMENTED_STRATEGIES.keys()].filter((s) => implemented.has(s));
  ok(stale.length === 0, `这些策略已被实现，但仍在「未实现」标注里（标注过期 = 谎报）：${stale.join(', ')}`);
  const orphanImpl = [...implemented].filter((s) => !VERIFY_STRATEGIES.includes(s));
  ok(orphanImpl.length === 0, `这些策略有实现，却不在 VERIFY_STRATEGIES 里（常量漏登记）：${orphanImpl.join(', ')}`);
  const unimplemented = VERIFY_STRATEGIES.filter((s) => UNIMPLEMENTED_STRATEGIES.has(s));
  return `${implemented.size} 个有实现（${[...implemented].join(', ')}）+ ${unimplemented.length} 个显式标未实现（${unimplemented.join(', ') || '无'}）`;
});

// ── ③ 注册表：每个把手都过 assertHandle，且 ALL_HANDLES 都真的注册上了 ──
await check('③ 注册表里每个把手都通过 assertHandle 契约校验', () => {
  indexMod.registerAll();
  const listed = registry.list();
  ok(listed.length > 0, '注册表为空 —— registerAll() 没注册任何把手');
  for (const h of listed) {
    try { assertHandle(h); } catch (e) { throw new Error(`把手 ${h?.id ?? '(无 id)'} 过不了 assertHandle：${e.message}`); }
  }
  const ids = new Set(listed.map((h) => h.id));
  const unregistered = indexMod.ALL_HANDLES.filter((h) => !ids.has(h.id)).map((h) => h.id);
  ok(unregistered.length === 0, `ALL_HANDLES 里有把手没进注册表：${unregistered.join(', ')}`);
  return `${listed.length} 个把手全部通过（ALL_HANDLES 与注册表一致）`;
});

// ── ④ 把手声明的策略必须是有实现的 ──
await check('④ 每个把手声明的 verification.strategy 都是有实现的策略', () => {
  const bad = registry.list()
    .filter((h) => !implemented.has(h.verification?.strategy))
    .map((h) => `${h.id} → ${h.verification?.strategy}`
      + `${UNIMPLEMENTED_STRATEGIES.has(h.verification?.strategy) ? '（显式标未实现，不允许上线）' : '（没有实现）'}`);
  ok(bad.length === 0, `这些把手声明了跑不出结论的策略：\n         ${bad.join('\n         ')}`);
  const counts = new Map();
  for (const h of registry.list()) counts.set(h.verification.strategy, (counts.get(h.verification.strategy) ?? 0) + 1);
  return [...counts].map(([s, n]) => `${s}×${n}`).join(' · ');
});

// ── ⑤ DRIFT_KINDS 与 replay 实际产出双向对账（真跑 detectDrift，不读源码）──
await check('⑤ DRIFT_KINDS 与 replay.detectDrift 实际产出的漂移 kind 双向对账', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbc-check-contracts-'));
  try {
    const storeRoot = path.join(tmp, 'store');
    fs.mkdirSync(storeRoot, { recursive: true });
    const pAnchor = path.join(tmp, 'anchor.txt');
    const pMissing = path.join(tmp, 'missing.txt');
    const pChanged = path.join(tmp, 'changed.txt');
    const pSame = path.join(tmp, 'same.txt');
    const pExtra = path.join(tmp, 'extra.txt');
    fs.writeFileSync(pAnchor, 'anchor', 'utf8');
    fs.writeFileSync(pMissing, 'missing', 'utf8');
    fs.writeFileSync(pChanged, 'v1', 'utf8');
    fs.writeFileSync(pSame, 'same', 'utf8');
    fs.writeFileSync(pExtra, 'extra', 'utf8');

    /** 造一个最小把手：只实现 buildBundle/detectDrift 需要的 probe。
     *  getText(): 字符串 = 存在；undefined = 目标不存在；null = 探针抛错（锚点失效）。 */
    const mk = (id, p, getText) => ({
      id,
      target: id,
      upgradeBehavior: 'invalidated',
      async probe() {
        const st = getText();
        if (st === null) throw new Error('锚点失效（门禁夹具）');
        return {
          exists: st !== undefined,
          text: st ?? '',
          bytes: Buffer.byteLength(st ?? '', 'utf8'),
          path: p,
        };
      },
    });

    let anchorDeep = false;
    let gone = false;
    let changed = 'v1';
    const handles = [
      mk('contracts.anchor', pAnchor, () => (anchorDeep ? null : 'anchor')),
      mk('contracts.gone', pMissing, () => (gone ? undefined : 'missing')),
      mk('contracts.changed', pChanged, () => changed),
      mk('contracts.same', pSame, () => 'same'),
      mk('contracts.extra', pExtra, () => 'extra'),
    ];

    const ctx = { version: '9.9.9' };
    const built = await replay.buildBundle({ storeRoot, handles, ctx });
    ok(Object.keys(built.bundle.entries).length === handles.length,
      `前提：5 个 invalidated 把手都该进重放包，实际 ${Object.keys(built.bundle.entries).length} 个`);

    // 升级之后：一个探针失效、一个目标消失、一个内容被厂商还原；extra 从当前版本消失
    anchorDeep = true;
    gone = true;
    changed = 'v2（厂商还原）';
    const drift = await replay.detectDrift({
      storeRoot, handles: handles.filter((h) => h.id !== 'contracts.extra'), ctx,
    });
    ok(drift.ok === true, `detectDrift 应成功，实际 ${drift.reason}`);

    const produced = new Set(drift.results.map((r) => r.kind));
    const expectedProducers = ['anchor-missing', 'target-missing', 'vendor-restored', 'unchanged', 'handle-missing'];
    const notProduced = expectedProducers.filter((k) => !produced.has(k));
    ok(notProduced.length === 0,
      `replay 不再产出这些 kind（生产者被删/被改名）：${notProduced.join(', ')}；实际产出 ${JSON.stringify([...produced])}`);

    // unchanged / handle-missing 是「无需动作」的结果，不属于漂移分类
    const ignore = new Set(['unchanged', 'handle-missing']);
    const realProduced = new Set([...produced].filter((k) => !ignore.has(k)));
    const frozen = new Set(DRIFT_KINDS);
    const producedNotFrozen = [...realProduced].filter((k) => !frozen.has(k));
    ok(producedNotFrozen.length === 0,
      `这些漂移 kind 真的产出了、却没进 DRIFT_KINDS：${producedNotFrozen.join(', ')}（状态契约：分类常量必须与实际产出同源）`);
    // 反方向：常量里的 kind 必须有生产者，或**被显式标注为无生产者**（残余 R7），不许默默放行
    const frozenNotProduced = [...frozen].filter((k) => !realProduced.has(k));
    const unannotated = frozenNotProduced.filter((k) => !UNPRODUCED_DRIFT_KINDS.has(k));
    ok(unannotated.length === 0,
      `DRIFT_KINDS 里这些 kind 没有任何生产者、也没被显式标注（常量在说谎）：${unannotated.join(', ')}\n`
      + `         已显式标注无生产者：${[...UNPRODUCED_DRIFT_KINDS.keys()].join(', ') || '(无)'}`);
    const staleAnnotation = [...UNPRODUCED_DRIFT_KINDS.keys()].filter((k) => realProduced.has(k) || !frozen.has(k));
    ok(staleAnnotation.length === 0,
      `这些 kind 已有生产者（或已不在 DRIFT_KINDS 里），但仍躺在「无生产者」标注里（标注过期 = 谎报）：${staleAnnotation.join(', ')}`);
    const note = frozenNotProduced.length === 0
      ? `产出 ${realProduced.size} 类 ↔ DRIFT_KINDS ${DRIFT_KINDS.length} 类，双向差集均为空`
      : `产出 ${realProduced.size} 类 ⊆ DRIFT_KINDS ${DRIFT_KINDS.length} 类；`
        + `另有 ${frozenNotProduced.length} 类已显式标注无生产者（残余 R7）：${frozenNotProduced.join(', ')}`;
    return note;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 汇总 ──
console.log('');
if (failures.length > 0) {
  console.log(`❌ 契约门禁不通过：${failures.length} 条`);
  for (const f of failures) console.log(`   · ${f.id}`);
  process.exitCode = 1;
} else {
  console.log(`✅ 契约门禁全部通过（${HANDLE_STEPS.length} 步 / ${VERIFY_STRATEGIES.length} 策略 / ${DRIFT_KINDS.length} 漂移分类）`);
}
