#!/usr/bin/env node
/**
 * workbuddy-console CLI
 *
 * 快速上手（第一次用照这个顺序）：
 *   node src/cli.mjs doctor          ① 体检：锚点是否成立、把手是否可用
 *   node src/cli.mjs list            ② 看有哪些把手可管
 *   node src/cli.mjs serve           ③ 开控制台（比命令行顺手）
 *
 * 常用：
 *   node src/cli.mjs probe   <handleId>                看现状
 *   node src/cli.mjs plan    <handleId> --set <file>    预览差异与代价（不写盘）
 *   node src/cli.mjs apply   <handleId> --set <file>    写入（自动备份）
 *   node src/cli.mjs verify  <handleId>                 验证是否真生效
 *     --baseline <n> --observed <n> --expected <n>      手工给三个数字（不自动对照）
 *     --restarted                                       规则面专用：确认 WorkBuddy 已重启过
 *   node src/cli.mjs restore <backupId>                 还原（需 --confirm；--dry-run 预演）
 *
 * 专家档位（N 套人设一键切换）：
 *   node src/cli.mjs profiles / profile-save <名称> / profile-plan <id> / profile-apply <id> / profile-verify <id>
 *
 * 审批自动同意：
 *   node src/cli.mjs approval / approval-plan <档位> / approval-apply <档位> / approval-verify <档位>
 *   档位：off（原厂）/ relaxed（读写不问、删除仍确认）/ full（读写删都不问）
 *
 * 版本重放（升级后走一遍）：
 *   node src/cli.mjs bundle / drift / replay
 *
 * 全局参数：
 *   --root  <dir>   WorkBuddy 配置根（默认 ~/.workbuddy；可用 WORKBUDDY_CONFIG_DIR）
 *                   ⚠️ 它**只换配置那棵树**：厂商面（7 个 style.*）另有一棵安装树，
 *                      由 WORKBUDDY_CONSOLE_INSTALL_DIR 单独决定。只想隔离配置面就够；
 *                      要**整套**隔离，两者都要给，否则 style.* 仍写真实 Program Files（残余 R39）。
 *   --store <dir>   本工具数据目录（默认 ~/.workbuddy-console，可用 WORKBUDDY_CONSOLE_HOME）
 *   --version <v>   覆盖版本探测
 *   --json          机器可读输出
 *   --confirm       写操作的显式确认（厂商文件写入 / 还原）
 */

import process from 'node:process';
import fs from 'node:fs';
import { createEngine } from './core/engine.mjs';
import { configRoot as resolveConfigRoot, storeRoot as resolveStoreRoot, tildify } from './core/paths.mjs';
import { findVendorEscapes, isolationWarning, requestedInstallRoot } from './core/isolation.mjs';
import { registerAll } from './handles/index.mjs';
import { ConsoleError } from './core/errors.mjs';
import { mapWriteError } from './core/atomic-write.mjs';

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

/** 快速上手：从文件头注释里提取，去掉注释符号 */
function helpText() {
  const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
  const block = src.split('*/')[0];
  return block
    .replace(/^#![^\n]*\n/, '')
    .replace(/^\/\*\*\n?/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trimEnd();
}

/** @param {string[]} argv */
async function main(argv) {
  const f = parseArgs(argv);
  const cmd = f._[0];
  const json = f.json === true;

  const configRoot = resolveConfigRoot(typeof f.root === 'string' ? f.root : undefined);

  /**
   * 隔离警告（残余 R39）：`--root` 只换**配置**那棵树，厂商面（7 个 `style.*`）仍指向**真实安装目录**。
   *
   * 只在用户**显式给了 `--root`**（意图＝隔离）时才提示；默认根下写真实安装目录是正确行为，提示会变噪音。
   * 为什么必须说：这个不一致是**静默**的——厂商把手照样报 `writeAccess: true`，
   * 一次 `apply style.* --confirm` 就把真机 Program Files 里的文件改了，而用户以为在隔离环境里。
   */
  const isolationLines = (onlyHandleId) => {
    const installRoot = requestedInstallRoot();
    const all = findVendorEscapes(engine.doctor().handles, { configRoot, installRoot });
    const escapes = onlyHandleId ? all.filter((e) => e.id === onlyHandleId) : all;
    return isolationWarning({ escapes, configRoot, installRoot, requestedRoot: typeof f.root === 'string' ? f.root : null });
  };
  const storeRoot = resolveStoreRoot(typeof f.store === 'string' ? f.store : undefined);
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
      const iso = isolationLines(null);
      if (json) return out({ ...d, isolation: iso ? { ok: false, warnings: iso } : { ok: true } }, true);
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
      if (iso) { console.log(''); for (const l of iso) console.log(l); }
      console.log(`\n总判：${d.ok && !iso ? '✅ 全部通过' : (d.ok ? '❌ 锚点通过，但隔离不一致（见上）' : '❌ 有问题')}`);
      return process.exitCode = (d.ok && !iso) ? 0 : 1;
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
      { const iso = isolationLines(f._[1]); if (iso) { console.log(''); for (const l of iso) console.log(l); } }
      return undefined;
    }

    case 'apply': {
      const h = engine.doctor().handles.find((x) => x.id === f._[1]);
      /**
       * ⚠️ 必须**显式**要求 --set（独立复核 D1，CRITICAL）。
       *
       * 曾经的灾难：漏写 `--set` 时 `next` 是 undefined → engine 兜底成 '' →
       * 把手把整个文件**写成空**（实测 32 字节的人设文件 → 0 字节），
       * 而 CLI 还打印「✅ 已写入」。用户一条手滑命令就清空自己的人设，
       * 且工具用绿色告诉他"成功"。
       *
       * 纪律：破坏性动作宁可拒绝，不可猜测意图。`--set -` 表 stdin 是显式写法，正常放行。
       */
      if (f.set === undefined) {
        throw new ConsoleError(
          'INPUT_MISSING',
          `apply 必须指定写入内容：--set <文件>（或 --set - 从 stdin 读）。\n`
          + `  不指定就等于"写入空内容"—— 会清空 ${h?.title ?? f._[1]} 的整个文件。\n`
          + `  只想预览不写盘，用 plan 子命令。`,
          { handle: f._[1], hint: 'node src/cli.mjs plan <handle> --set <file>' },
        );
      }
      const next = readNextFor(f.set, h?.inputKind);
      // 写之前就把"这次会写到哪棵树"说清楚（残余 R39）；默认根下无内容、不打扰
      { const iso = isolationLines(f._[1]); if (iso) { console.log(''); for (const l of iso) console.log(l); console.log(''); } }
      const r = await engine.apply(f._[1], { next, confirm: f.confirm === true, reason: typeof f.reason === 'string' ? f.reason : undefined });
      if (json) return out(r, true);
      if (r.noop) {
        console.log(`＝ 无需改动 ${r.handle}：${r.note ?? '内容与现状一致'}`);
        return undefined;
      }
      console.log(`✅ 已写入 ${r.handle}`);
      console.log(`备份 ${r.backupId}（还原：node src/cli.mjs restore ${r.backupId}）`);
      for (const w of r.gate.warnings) console.log(`⚠️  ${w}`);
      console.log(`验证策略 ${r.verification.strategy} @ ${r.verification.channel} —— 用 verify 子命令判定生效`);
      return undefined;
    }

    case 'verify': {
      /** @type {{baselineTokens?:number, observedTokens?:number, expectedDelta?:number, restarted?:boolean}} */
      const args = {};
      if (f.baseline !== undefined) args.baselineTokens = Number(f.baseline);
      if (f.observed !== undefined) args.observedTokens = Number(f.observed);
      if (f.expected !== undefined) args.expectedDelta = Number(f.expected);
      // 规则面（readback-after-restart）必须知道"重启过了没"。曾经没有这个参数，
      // 于是规则把手永远停在 undetermined，还提示用户"带 restarted 参数"——而用户拿不到它。
      //
      // ⚠️ 必须接受三种写法：裸 `--restarted`（parseArgs 给 true）、
      // `--restarted=true` 与 `--restarted true`（parseArgs 给字符串 "true"）。
      // 曾经只判 `=== true`，后两种**静默失效**——输出与不带参数逐字相同，
      // 用户以为"重启过了但没生效"，实际是参数没被认出来（独立复核 [C13] 抓出）。
      if (f.restarted === true || f.restarted === 'true' || f.restarted === '1') args.restarted = true;
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
        console.log(`  已排除非聊天样本（标题生成 / 其它模型）：${r.evidence.excludedSamples ?? 0} 条`);
      }
      for (const w of (r.warnings ?? [])) console.log(`\n⚠️  ${w}`);
      if (r.hint) console.log(`\n${r.hint}`);
      return r.verdict === 'ineffective' ? (process.exitCode = 2) : undefined;
    }

    case 'restore': {
      const backupId = f._[1];
      const dryRun = f['dry-run'] === true;
      if (typeof backupId !== 'string' || !backupId.trim()) {
        console.error('❌ 缺少备份 id —— 先 `node src/cli.mjs backups` 看有哪些备份。');
        return process.exitCode = 1;
      }
      /**
       * ⚠️ CLI 也必须有同意闸门（F2）。
       *
       * 曾经：`/api/restore` 修好了（confirm + dryRun + `checkRestoreGate`），
       * 但 CLI 的 `restore` 直调 `engine.restore`：既不要 `--confirm`、也不过闸门。
       * 一条命令就能在 WorkBuddy 运行中覆盖/删除厂商文件，而且它对"备份时本不存在"
       * 的条目执行的是**删除**。同一类写操作两套规矩，等于给闸门留了个后门。
       */
      if (!dryRun && f.confirm !== true) {
        console.error(
          '❌ [CONFIRMATION_REQUIRED] 还原会覆盖甚至删除目标文件，需显式确认。\n'
          + `   预演（不写盘）：node src/cli.mjs restore ${backupId} --dry-run\n`
          + `   确认后执行：    node src/cli.mjs restore ${backupId} --confirm`,
        );
        return process.exitCode = 1;
      }
      // 与 HTTP 路径**同一道**闸门：还原是写操作，必须与 apply 过同一套规矩
      if (!dryRun) {
        const gateBlock = engine.checkRestoreGate(backupId);
        if (gateBlock.blocked) {
          console.error(`❌ [GATE_BLOCKED] ${gateBlock.reason}`);
          return process.exitCode = 1;
        }
      }

      const r = engine.restore(backupId, { dryRun });
      if (json) return out(r, true);
      console.log(`${r.dryRun ? '（预演）' : ''}备份 ${r.id}  创建于 ${r.createdAt}`);
      for (const x of r.results) {
        const mark = x.ok === false ? '✕' : x.action === 'noop' ? '＝' : x.action === 'restore' ? '↩' : x.action === 'delete' ? '✕' : '?';
        console.log(`  ${mark} ${x.absPath}  ${x.drift ? '(有漂移)' : ''}`
          + `${x.ok === false ? `  失败 [${x.error?.code ?? 'ERR'}] ${x.error?.message ?? ''}` : ''}`);
      }
      console.log(`\n共 ${r.changed.length} 项发生变化${r.failed?.length ? `，${r.failed.length} 项失败` : ''}`);
      // 还原前副本落点必须说出来，否则用户不知道"被删的东西去哪找回"
      if (r.savedDir) console.log(`还原前的当前内容已另存：${r.savedDir}`);
      /**
       * 部分/完全失败必须非零退出 —— 不许把"半还原"说成成功（与 replay/approval 同一纪律）。
       */
      if (r.status !== 'ok') {
        console.error(`\n❌ 还原${r.status === 'partial' ? '部分失败' : '失败'}（status=${r.status}）—— 见上面逐条明细`);
        process.exitCode = 1;
      }
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
        /**
         * `--store` 必须真的传下去。
         *
         * 曾经的缺陷：这里只传 root/port，`--store` 被解析了却丢掉，
         * 于是 `serve --store X` 实际用的是**默认**数据目录（`~/.workbuddy-console`），
         * 而帮助文案承诺它生效。隔离运行的语义因此是假的：
         * 审计、备份都落进了真实数据目录。
         *
         * （这条是排查"fixture 起服务污染真实 baselines/"时抓出来的：
         *   先是发现 baselinesDir 忽略 store，再顺着发现 store 根本没传进来。）
         */
        store: typeof f.store === 'string' ? f.store : undefined,
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

    // ── 版本重放 ──────────────────────────────────────────────
    case 'bundle': {
      const r = await engine.captureBundle();
      if (json) return out(r, true);
      const n = Object.keys(r.bundle.entries).length;
      console.log(`✅ 重放包已建立（WorkBuddy ${r.bundle.version}）`);
      console.log(`   收录 ${n} 项需要重放的定制：`);
      for (const [id, e] of Object.entries(r.bundle.entries)) {
        console.log(`     ${id.padEnd(30)} ${String(e.bytes).padStart(7)} B  ← ${e.capturedFrom}`);
      }
      if (r.bundle.skipped.length) {
        console.log(`\n   跳过 ${r.bundle.skipped.length} 项（不需要重放）：`);
        for (const s of r.bundle.skipped.slice(0, 10)) console.log(`     ${s.id.padEnd(30)} ${s.reason}`);
      }
      console.log(`\n   文件：${tildify(r.file)}`);
      return undefined;
    }

    case 'drift': {
      const d = await engine.checkDrift();
      if (json) return out(d, true);
      if (!d.ok) return console.log(`⚠️  ${d.reason}`);
      console.log(`重放包建于 ${d.bundleCreatedAt}（WorkBuddy ${d.bundleVersion}）`);
      console.log(`当前版本 ${d.currentVersion}${d.versionChanged ? '  ← 版本变了' : ''}\n`);
      const icon = { unchanged: '✅', 'vendor-restored': '⚠️ ', 'target-missing': '❌', 'anchor-missing': '❌', 'handle-missing': '·' };
      for (const r of d.results) {
        console.log(`${icon[r.kind] ?? '·'} ${String(r.id).padEnd(30)} ${r.kind}`);
        if (r.detail) console.log(`     ${r.detail}`);
        if (r.moved) console.log('     路径也变了（升级换了版本目录）');
      }
      console.log(`\n需要重放：${d.needReplay.length} 项${d.needReplay.length ? `（${d.needReplay.join(', ')}）` : ''}`);
      if (d.needReplay.length) console.log('重放：node src/cli.mjs replay --confirm');
      return undefined;
    }

    case 'replay': {
      const only = typeof f.only === 'string' ? f.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const r = await engine.replay({ only, confirm: f.confirm === true });
      if (json) return out(r, true);
      if (r.replayed.length === 0) return console.log(`没有需要重放的把手${r.note ? `（${r.note}）` : ''}`);
      const badge = r.failed === 0 ? '✅' : r.ok === 0 ? '❌' : '⚠️ ';
      console.log(`${badge} 重放结果：成功 ${r.ok} / 失败 ${r.failed}（共 ${r.replayed.length}）`);
      console.log(`   备份 ${r.backupId}（覆盖 ${r.files} 个文件，可整体还原）`);
      for (const x of r.replayed) {
        console.log(x.ok ? `   · ${x.handle}` : `   ❌ ${x.handle}  ${x.error}`);
      }
      if (r.partial) console.log('\n⚠️  部分成功 —— 有把手没灌回去，请按上面的错误逐个处理，不要当成完成。');
      if (r.failed > 0) process.exitCode = 2;
      if (r.skipped.length) {
        console.log(`\n   跳过 ${r.skipped.length} 项：`);
        for (const s of r.skipped) console.log(`     ${s.id}  ${s.reason}`);
      }
      return undefined;
    }

    // ── P3 · 审批自动同意 ──────────────────────────────────────
    case 'approval': {
      const s = await engine.approvalState();
      if (json) return out(s, true);
      console.log('可选档位：');
      for (const lv of s.levels) console.log(`  ${lv.id.padEnd(9)} ${lv.title}`);
      console.log('\n当前状态：');
      for (const p of s.prompts) {
        if (p.error) { console.log(`  ❌ ${p.handle}  ${p.error}`); continue; }
        const lv = p.level?.level ?? '?';
        console.log(`  提示词 ${p.handle.padEnd(26)} 档位=${lv}${p.hasBlock ? '' : '  ⚠️ 无安全段'}`);
      }
      if (s.rules?.ok) {
        const p = s.rules.pending;
        console.log(`  规则   共 ${s.rules.ruleCount} 条：read=ask ${p.readAsk} / write=ask ${p.writeAsk} / delete=ask ${p.deleteAsk}`);
      } else {
        console.log(`  ❌ 规则面不可读：${s.rules?.error ?? '未知'}`);
      }
      console.log('\n预览某个档位：node src/cli.mjs approval-plan relaxed');
      return undefined;
    }

    case 'approval-plan': {
      const p = await engine.planApproval(f._[1]);
      if (json) return out(p, true);
      console.log(`档位 ${p.level} · ${p.title}`);
      console.log(`${p.desc}\n`);
      for (const face of p.faces) {
        const badge = face.certainty === 'reliable' ? '✅ 可可靠验证'
          : face.certainty === 'uncertain' ? '⚠️  无法保证' : '· 不涉及';
        console.log(`── ${face.title}   ${badge}`);
        console.log(`   ${face.detail}`);
        if (face.samples?.length) {
          console.log(`   样例：${face.samples.join(' ')}${face.changed > face.samples.length ? ' …' : ''}`);
        }
        if (face.verify) console.log(`   验证：${face.verify}`);
        if (face.note) console.log(`   ${face.note}`);
        for (const w of (face.warnings ?? [])) console.log(`   ⚠️  ${w}`);
        console.log('');
      }
      console.log(`提示词目标：${p.promptPath ?? '(无)'}（版本 ${p.promptVersion ?? '-'}）`);
      console.log(`⚠️  ${p.gate.warning}`);
      return undefined;
    }

    case 'approval-apply': {
      const r = await engine.applyApproval(f._[1], { confirm: f.confirm === true });
      if (json) return out(r, true);
      // 无改动：applyApproval 会返回 files=0 且不带 backupId
      if (!r.changed && !r.backupId) {
        console.log(`✅ ${r.note ?? '无需改动（当前档位与目标一致）'}`);
        return undefined;
      }
      const badge = r.failed > 0 ? (r.ok > 0 ? '⚠️ ' : '❌') : '✅';
      console.log(`${badge} 已应用档位 ${r.level}（${r.title}）`);
      console.log(`   备份 ${r.backupId}（覆盖 ${r.files} 个文件，可整体还原）`);
      for (const d of r.done) {
        console.log(d.ok ? `   · ${d.face}` : `   ❌ ${d.face}  ${d.error}`);
      }
      console.log('\n⚠️  两个面都需要**重启 WorkBuddy** 才生效。');
      console.log(`   重启后验证：node src/cli.mjs approval-verify ${r.level}`);
      if (r.failed > 0) process.exitCode = 2;
      return undefined;
    }

    case 'approval-verify': {
      const r = await engine.verifyApproval(f._[1]);
      if (json) return out(r, true);
      console.log(`${VERDICT_BADGE[r.verdict] ?? r.verdict}   档位 ${r.level}`);
      console.log(r.reason);
      if (r.parts?.length) {
        console.log('\n逐面结论：');
        for (const p of r.parts) {
          const b = { effective: '✅ 生效', ineffective: '❌ 未生效', undetermined: '⚠️  无法判定' }[p.verdict] ?? p.verdict;
          console.log(`   ${p.face.padEnd(10)} ${b}`);
        }
      }
      if (r.caveat) console.log(`\n${r.caveat}`);
      return r.verdict === 'ineffective' ? (process.exitCode = 2) : undefined;
    }

    case 'audit': {
      const rows = engine.audit(f.limit !== undefined ? Number(f.limit) : 50);
      return out(json ? rows : rows.map((r) => `${r.at}  ${r.event.padEnd(8)} ${r.handle ?? r.backupId ?? ''}  ${r.verdict ?? ''} ${r.reason ?? ''}`).join('\n') || '（暂无记录）', false);
    }

    default:
      // 无参数或未知命令 → 打印快速上手（而不是只吐一句 usage）
      console.log(helpText());
      return process.exitCode = cmd ? 1 : 0;
  }
}

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof ConsoleError) {
    console.error(`❌ [${e.code}] ${e.message}`);
    if (Object.keys(e.detail ?? {}).length) console.error(`   ${JSON.stringify(e.detail)}`);
    process.exitCode = 1;
    return;
  }
  /**
   * R28：系统 errno **不许**以裸 `Error: ENOSPC …` + 栈的形式丢给用户 ——
   * 那既不说"文件现在是什么状态"，也不给恢复入口，而用户会默认"失败＝文件没变"。
   *
   * 映射表只有一份（`core/atomic-write.mjs` 的 `mapWriteError`），HTTP 与 CLI 共用；
   * 这里只兜住"没被引擎翻译过"的漏网 errno。
   */
  const mapped = mapWriteError(e, { absPath: typeof e?.path === 'string' && e.path ? e.path : undefined });
  if (mapped) {
    console.error(`❌ [${mapped.code}] ${mapped.message}`);
    console.error(`   ${mapped.hint}`);
    process.exitCode = 1;
    return;
  }
  console.error('❌ 未预期的错误：', e);
  process.exitCode = 1;
});
