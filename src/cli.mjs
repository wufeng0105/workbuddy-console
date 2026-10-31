#!/usr/bin/env node
/**
 * workbuddy-console CLI
 * ---------------------------------------------------------------
 * 用法：
 *   node src/cli.mjs doctor                体检：锚点是否成立 + 把手契约是否满足
 *   node src/cli.mjs list                  列出把手
 *   node src/cli.mjs probe   <handleId>
 *   node src/cli.mjs plan    <handleId> --set <file|->
 *   node src/cli.mjs apply   <handleId> --set <file|-> [--confirm] [--reason <s>]
 *   node src/cli.mjs verify  <handleId> [--baseline N --observed N --expected N]
 *   node src/cli.mjs restore <backupId> [--dry-run]
 *   node src/cli.mjs backups
 *   node src/cli.mjs audit [--limit N]
 *   node src/cli.mjs traces [--limit N]     列出 trace 里的 generation 记录（诊断 token-delta 数据源）
 *   node src/cli.mjs serve [--port N]       启动本地控制台（仅 127.0.0.1）
 *
 * 专家档位（多把手事务）：
 *   node src/cli.mjs profiles                列出档位
 *   node src/cli.mjs profile-save <名称> [--id <id>]   采集**当前实际状态**为档位
 *   node src/cli.mjs profile-plan   <id>     预览切换（逐把手差异 + 合计期望增量）
 *   node src/cli.mjs profile-apply  <id> [--confirm]
 *   node src/cli.mjs profile-verify <id>
 *   node src/cli.mjs profile-rm     <id>
 *
 * 全局参数：
 *   --root  <dir>   WorkBuddy 配置根（默认 ~/.workbuddy；可用 WORKBUDDY_CONFIG_DIR）
 *   --store <dir>   本工具数据目录（默认 ~/.workbuddy-console）
 *   --version <v>   覆盖版本探测
 *   --json          机器可读输出
 */

import process from 'node:process';
import fs from 'node:fs';
import { createEngine } from './core/engine.mjs';
import { configRoot as resolveConfigRoot, storeRoot as resolveStoreRoot, tildify } from './core/paths.mjs';
import { registerAll } from './handles/index.mjs';
import { ConsoleError } from './core/errors.mjs';

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const f = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) { f[body.slice(0, eq)] = body.slice(eq + 1); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { f[body] = next; i += 1; } else { f[body] = true; }
    } else f._.push(a);
  }
  return f;
}

/** @param {string} src */
function readNext(src) {
  if (src === '-') return fs.readFileSync(0, 'utf8');
  if (!fs.existsSync(src)) throw new ConsoleError('INPUT_MISSING', `找不到输入文件：${src}`, { src });
  return fs.readFileSync(src, 'utf8');
}

/**
 * 按把手的 inputKind 准备 next 值。
 * - `rule-op`：结构化操作，必须解析成对象
 * - 其余：纯文本
 * @param {string} src
 * @param {'text'|'rule-op'} [inputKind]
 */
function readNextFor(src, inputKind) {
  const raw = readNext(src);
  if (inputKind !== 'rule-op') return raw;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new ConsoleError(
      'INVALID_VALUE',
      `该把手需要结构化操作（JSON），例如 {"from":"ask","to":"allow","actions":["write"]}；`
      + `解析失败：${e.message}`,
      { src, rawPreview: raw.slice(0, 200) },
    );
  }
  return obj;
}

/** @param {any} v @param {boolean} json */
function out(v, json) {
  if (json) { console.log(JSON.stringify(v, null, 2)); return; }
  console.log(v);
}

const VERDICT_BADGE = { effective: '✅ 生效', ineffective: '❌ 未生效', undetermined: '⚠️  无法判定' };

/** @param {string[]} argv */
async function main(argv) {
  const f = parseArgs(argv);
  const cmd = f._[0];
  const json = f.json === true;

  const configRoot = resolveConfigRoot(typeof f.root === 'string' ? f.root : undefined);
  const storeRoot = resolveStoreRoot();
  registerAll();

  const engine = createEngine({
    configRoot,
    storeRoot,
    version: typeof f.version === 'string' ? f.version : undefined,
    actor: 'cli',
  });

  switch (cmd) {
    case 'doctor': {
      const d = engine.doctor();
      if (json) return out(d, true);
      console.log(`WorkBuddy ${d.version}   （锚点表 ${tildify(d.tableFile)}）`);
      console.log(`配置根 ${d.configRoot}\n数据目录 ${d.storeRoot}\n`);
      console.log('锚点：');
      for (const a of d.anchors) console.log(`  ${a.ok ? '✅' : '❌'} ${a.key.padEnd(24)} ${a.ok ? a.path : `${a.error} ${a.message}`}`);
      console.log('\n把手：');
      for (const h of d.handles) {
        console.log(`  ${h.anchorOk ? '✅' : '❌'} ${h.id}  [${h.writeClass}/${h.privilege}/${h.channel}/${h.upgradeBehavior}]`);
        console.log(`      锚点 ${h.anchorPath ?? h.error}`);
        console.log(`      验证 ${h.verification.strategy} @ ${h.verification.channel}`);
      }
      console.log(`\n总判：${d.ok ? '✅ 全部通过' : '❌ 有问题'}`);
      return process.exitCode = d.ok ? 0 : 1;
    }

    case 'list': {
      const rows = engine.doctor().handles;
      if (json) return out(rows, true);
      for (const h of rows) console.log(`${h.id.padEnd(26)} ${h.title}  [${h.writeClass}] 验证=${h.verification.strategy}`);
      return undefined;
    }

    case 'probe': {
      const r = await engine.probe(f._[1]);
      if (json) return out(r, true);
      console.log(`${r.handle.title}  (${r.handle.id})`);
      console.log(`路径   ${tildify(r.state.path)}`);
      console.log(`存在   ${r.state.exists ? '是' : '否'}`);
      console.log(`字节   ${r.state.bytes}   估算 token ${r.state.tokens.tokens}`);
      console.log(`sha256 ${r.state.sha256 ?? '(无)'}`);
      return undefined;
    }

    case 'plan': {
      const h = engine.doctor().handles.find((x) => x.id === f._[1]);
      const next = f.set !== undefined ? readNextFor(f.set, h?.inputKind) : undefined;
      const p = await engine.plan(f._[1], { next });
      if (json) return out({ ...p, preview: { ...p.preview, diff: undefined } }, true);
      console.log(`${p.handle.title}  →  ${p.anchor.path}`);
      const pv = p.preview;
      if (pv.valueAfter !== undefined) {
        // JSON 字段型把手：比"整个文件字节数"没有意义，要展示**取值**变化
        console.log(`取值  ${JSON.stringify(pv.valueBefore)}  →  ${JSON.stringify(pv.valueAfter)}`);
        if (pv.injectedChars != null) console.log(`真正注入请求的内容：${pv.injectedChars} 字符`);
        if (pv.expectedDeltaTokens != null) {
          console.log(`修正  ${pv.expectedDeltaTokens >= 0 ? '+' : ''}${pv.expectedDeltaTokens} tokens（估算）`);
        }
      } else if (pv.op) {
        // 规则矩阵型把手：展示结构化操作与命中数
        const a = pv.op.actions.join('/');
        console.log(`操作  ${a} = ${pv.op.from}  →  ${pv.op.to}${pv.op.paths ? `（限 ${pv.op.paths.length} 个路径）` : ''}`);
        console.log(`命中  ${pv.changed} 条规则`);
      } else {
        console.log(`现在 ${p.current.bytes} B / 约 ${p.current.tokens} tokens   →   改后 ${Buffer.byteLength(String(next ?? ''), 'utf8')} B`);
        console.log(`修正 ${pv.cost.delta >= 0 ? '+' : ''}${pv.cost.delta} tokens（估算）`);
      }
      console.log(`\n${pv.diffText}\n`);
      if (!pv.op) console.log(`缓存代价：${pv.cost.cacheNote}`);
      for (const w of (p.preview.warnings ?? [])) console.log(`⚠️  ${w}`);
      for (const w of p.gate.warnings) console.log(`⚠️  ${w}`);
      if (p.needsConfirm) console.log('⚠️  这是厂商文件写入，必须显式 --confirm');
      return undefined;
    }

    case 'apply': {
      const h = engine.doctor().handles.find((x) => x.id === f._[1]);
      const next = f.set !== undefined ? readNextFor(f.set, h?.inputKind) : undefined;
      const r = await engine.apply(f._[1], { next, confirm: f.confirm === true, reason: typeof f.reason === 'string' ? f.reason : undefined });
      if (json) return out(r, true);
      console.log(`✅ 已写入 ${r.handle}`);
      console.log(`备份 ${r.backupId}（还原：node src/cli.mjs restore ${r.backupId}）`);
      for (const w of r.gate.warnings) console.log(`⚠️  ${w}`);
      console.log(`验证策略 ${r.verification.strategy} @ ${r.verification.channel} —— 用 verify 子命令判定生效`);
      return undefined;
    }

    case 'verify': {
      /** @type {{baselineTokens?:number, observedTokens?:number, expectedDelta?:number}} */
      const args = {};
      if (f.baseline !== undefined) args.baselineTokens = Number(f.baseline);
      if (f.observed !== undefined) args.observedTokens = Number(f.observed);
      if (f.expected !== undefined) args.expectedDelta = Number(f.expected);
      const r = await engine.verify(f._[1], args);
      if (json) return out(r, true);
      console.log(`${VERDICT_BADGE[r.verdict] ?? r.verdict}   ${r.handle ?? f._[1]}`);
      console.log(r.reason);
      if (r.evidence) {
        const b = r.evidence.baseline;
        const o = r.evidence.observed;
        const d = o.promptTokens - b.promptTokens;
        console.log('\n对照证据（自动从 trace 采集）：');
        console.log(`  基线  ${b.at}  worker=${b.worker}  ${b.promptTokens} tokens  [${b.model}]`);
        console.log(`  观测  ${o.at}  worker=${o.worker}  ${o.promptTokens} tokens  [${o.model}]`);
        console.log(`  实测增量  ${d >= 0 ? '+' : ''}${d} tokens`);
        console.log(`  已排除非聊天请求（标题生成等）：${r.evidence.excludedNonChat} 条`);
      }
      for (const w of (r.warnings ?? [])) console.log(`\n⚠️  ${w}`);
      if (r.hint) console.log(`\n${r.hint}`);
      return r.verdict === 'ineffective' ? (process.exitCode = 2) : undefined;
    }

    case 'restore': {
      const r = engine.restore(f._[1], { dryRun: f['dry-run'] === true });
      if (json) return out(r, true);
      console.log(`${r.dryRun ? '（预演）' : ''}备份 ${r.id}  创建于 ${r.createdAt}`);
      for (const x of r.results) {
        console.log(`  ${x.action === 'noop' ? '＝' : x.action === 'restore' ? '↩' : '✕'} ${x.absPath}  ${x.drift ? '(有漂移)' : ''}`);
      }
      console.log(`\n共 ${r.changed.length} 项发生变化`);
      return undefined;
    }

    case 'backups': {
      const rows = engine.backups();
      if (json) return out(rows, true);
      if (rows.length === 0) return console.log('（暂无备份）');
      for (const b of rows) console.log(`${b.id}  ${b.createdAt}  ${b.entries} 项  ${b.reason}`);
      return undefined;
    }

    case 'serve': {
      const { startConsole } = await import('./server.mjs');
      const s = await startConsole({
        root: typeof f.root === 'string' ? f.root : undefined,
        port: f.port !== undefined ? Number(f.port) : 0,
      });
      console.log('workbuddy-console 已启动');
      console.log(`  WorkBuddy ${s.version}    配置根 ${s.configRoot}`);
      console.log(`  数据目录 ${s.storeRoot}`);
      console.log(`\n  控制台  ${s.url}\n`);
      console.log(`  URL 也落了一份：${s.urlFile}`);
      console.log('  仅监听 127.0.0.1；令牌随本次启动生成。Ctrl+C 退出。');
      return undefined; // http server 维持事件循环
    }

    case 'traces': {
      const { readGenerations } = await import('./core/trace.mjs');
      const recs = readGenerations(configRoot, { limitFiles: f.limit !== undefined ? Number(f.limit) : 80 });
      if (json) return out(recs, true);
      if (recs.length === 0) return console.log('（没有读到 generation 记录 —— trace 目录可能为空或结构已变）');
      const chat = recs.filter((r) => r.isChat).length;
      console.log(`共 ${recs.length} 条 generation（聊天 ${chat} / 非聊天 ${recs.length - chat}）\n`);
      console.log('时间                          worker   模型                   prompt  cached  finish');
      for (const r of recs.slice(-25)) {
        console.log(
          `${String(r.at).padEnd(29)} ${String(r.worker).padEnd(8)} ${String(r.model ?? '-').padEnd(21)} `
          + `${String(r.promptTokens).padStart(6)} ${String(r.cachedTokens ?? '-').padStart(7)}  ${r.finishReason ?? '-'}`
          + `${r.isChat ? '' : '   ← 非聊天，已排除'}`,
        );
      }
      return undefined;
    }

    // ── 专家档位 ──────────────────────────────────────────────
    case 'profiles': {
      const rows = engine.profiles();
      if (json) return out(rows, true);
      if (rows.length === 0) return console.log('（暂无档位。用 profile-save <名称> 把当前状态存为一档）');
      console.log('id                        名称                 覆盖  创建时间');
      for (const p of rows) {
        console.log(`${p.id.padEnd(25)} ${String(p.name).padEnd(20)} ${String(p.covers.length).padStart(3)}  ${p.createdAt ?? ''}`);
      }
      return undefined;
    }

    case 'profile-save': {
      const name = f._[1];
      if (!name) throw new ConsoleError('USAGE', '用法：profile-save <名称> [--id <id>]');
      const p = await engine.captureProfile({ name, id: typeof f.id === 'string' ? f.id : undefined });
      if (json) return out(p, true);
      console.log(`✅ 已采集档位 ${p.id}（${p.name}）`);
      for (const [k, v] of Object.entries(p.values)) {
        console.log(`   ${String(k).padEnd(32)} ${String(v).length} 字符`);
      }
      console.log('\n切换：node src/cli.mjs profile-apply ' + p.id);
      return undefined;
    }

    case 'profile-plan': {
      const pl = await engine.planProfile(f._[1]);
      if (json) return out(pl, true);
      console.log(`档位 ${pl.profile.id}（${pl.profile.name}）  →  合计修正 ${pl.expectedDeltaTokens >= 0 ? '+' : ''}${pl.expectedDeltaTokens} tokens（估算）\n`);
      for (const it of pl.items) {
        const d = it.expectedDeltaTokens;
        console.log(`── ${it.title}  [${it.writeClass}]  ${d == null ? '（无法预估增量）' : `${d >= 0 ? '+' : ''}${d} tokens`}`);
        console.log(`   ${it.anchor}`);
        console.log(String(it.diffText).split('\n').slice(0, 8).map((l) => `   ${l}`).join('\n'));
        for (const w of it.warnings) console.log(`   ⚠️  ${w}`);
        for (const w of it.gate.warnings) console.log(`   ⚠️  ${w}`);
        console.log('');
      }
      if (pl.needsConfirm) console.log('⚠️  含厂商文件把手，apply 需 --confirm');
      return undefined;
    }

    case 'profile-apply': {
      const r = await engine.applyProfile(f._[1], { confirm: f.confirm === true });
      if (json) return out(r, true);
      console.log(`✅ 已切换到档位 ${r.profile}`);
      console.log(`   备份 ${r.backupId}（一次事务覆盖 ${r.files} 个文件；还原：node src/cli.mjs restore ${r.backupId}）`);
      console.log(`   期望增量合计 ${r.expectedDeltaTokens >= 0 ? '+' : ''}${r.expectedDeltaTokens} tokens`);
      for (const w of r.written) console.log(`   · ${w.handle}${w.writeMode ? ` (${w.writeMode})` : ''}`);
      console.log('\n生效验证：在 WorkBuddy 新建会话并发一条消息，然后：');
      console.log(`   node src/cli.mjs profile-verify ${r.profile}`);
      return undefined;
    }

    case 'profile-verify': {
      const r = await engine.verifyProfile(f._[1]);
      if (json) return out(r, true);
      console.log(`${VERDICT_BADGE[r.verdict] ?? r.verdict}   档位 ${r.profile ?? f._[1]}`);
      console.log(r.reason);
      if (r.evidence) {
        const b = r.evidence.baseline;
        const o = r.evidence.observed;
        console.log('\n对照证据（自动从 trace 采集）：');
        console.log(`  基线  ${b.at}  worker=${b.worker}  ${b.promptTokens} tokens  [${b.model}]`);
        console.log(`  观测  ${o.at}  worker=${o.worker}  ${o.promptTokens} tokens  [${o.model}]`);
        console.log(`  实测增量  ${o.promptTokens - b.promptTokens >= 0 ? '+' : ''}${o.promptTokens - b.promptTokens} tokens`);
      }
      for (const w of (r.warnings ?? [])) console.log(`\n⚠️  ${w}`);
      return r.verdict === 'ineffective' ? (process.exitCode = 2) : undefined;
    }

    case 'profile-rm': {
      const r = engine.removeProfile(f._[1]);
      return out(json ? r : `✅ 已删除档位 ${r.id}`, false);
    }

    case 'audit': {
      const rows = engine.audit(f.limit !== undefined ? Number(f.limit) : 50);
      return out(json ? rows : rows.map((r) => `${r.at}  ${r.event.padEnd(8)} ${r.handle ?? r.backupId ?? ''}  ${r.verdict ?? ''} ${r.reason ?? ''}`).join('\n') || '（暂无记录）', false);
    }

    default:
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
      return process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof ConsoleError) {
    console.error(`❌ [${e.code}] ${e.message}`);
    if (Object.keys(e.detail ?? {}).length) console.error(`   ${JSON.stringify(e.detail)}`);
    process.exitCode = 1;
  } else {
    console.error('❌ 未预期的错误：', e);
    process.exitCode = 1;
  }
});
