#!/usr/bin/env node
/**
 * 一键启动器 —— 双击「启动控制台.cmd」时跑的就是它。
 *
 * 为什么需要它（三件"手敲命令一定会错"的事）：
 *   1. 令牌每次启动都变 → 由它解析 URL 并开浏览器，你不必手抄（手抄过一次，全 401）
 *   2. 容易忘了先退 WorkBuddy → 它先探测进程，**运行中默认拒绝启动**（见 docs/framework.md 闸门层）
 *   3. 不知道改完要不要重启 → 它按把手类别打印生效点（规则/模板要重启；身份/配置/风格新建会话即可）
 *
 * 生命周期：这个进程就是服务本身。窗口不关 = 服务一直在；关窗口 = 服务停。
 *
 * 自测用参数：
 *   --port <n>          固定端口（默认 0 = 随机，避免撞端口）
 *   --no-open           不自动打开浏览器
 *   --app-state <s>     auto|running|closed|true|false|unknown —— 覆盖进程探测（只为自测注入；
 *                       取值允许直接写探测器的返回值布尔，用来覆盖"真实路径"分支）
 *   --yes               跳过"WorkBuddy 在跑"的确认
 *   --no-reuse          忽略已存在的实例，强制新起一个
 */

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { startConsole } from './server.mjs';
import { storeRoot as resolveStoreRoot, tildify } from './core/paths.mjs';
import { isWorkBuddyRunning } from './core/appstate.mjs';

const MIN_NODE_MAJOR = 20;

/* ── 颜色：只在真终端里用，重定向到文件时不吐 ANSI ───────────── */
const TTY = process.stdout.isTTY === true;
const c = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = c('31'); const green = c('32'); const yellow = c('33');
const dim = c('2'); const bold = c('1');

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const f = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) { f[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { f[body] = next; i += 1; } else { f[body] = true; }
  }
  return f;
}

const CARD = `
${bold('操作卡（这套工具是一次性的：改完就走）')}

  ${bold('1')}  ${dim('改')}      浏览器里点开要改的那张卡 → 编辑 → 点「应用」
              ${dim('看到绿色「已写入 … 备份 …」才算成功；红条是失败，原文照读，不要猜')}

  ${bold('2')}  ${dim('生效点')}  ${yellow('要重启 WorkBuddy')}：行为规则、提示词模板
             ${green('新建会话即可')}：人设 / 称呼 / 名字、回复风格、指令、风格内容

  ${bold('3')}  ${dim('收尾')}   关掉本窗口（服务停） → 再启动 WorkBuddy

  ${bold('4')}  ${dim('反悔')}   重开本窗口 → 对应卡片点「还原」→ 回到本版最初设置

  ${dim('—')}  ${dim('注意：工具只能证明「内容写进去了」，不能证明「模型因此改变了行为」。')}
      ${dim('      没生效和没写进去是两回事，报错原文要看清楚再动手。')}
`;

/** @param {string} url */
function openBrowser(url) {
  try {
    const child = process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * 已有实例？—— 双击两次不该起两个服务（两个服务两个令牌，必然拧着用）。
 * 判据不是"文件在"，而是"那个端口真的还应答"，避免拿死链糊弄人。
 * @param {string} store
 */
async function probeExisting(store) {
  const f = path.join(store, 'state', 'console-url.txt');
  if (!fs.existsSync(f)) return null;
  const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(fs.readFileSync(f, 'utf8'));
  if (!m) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${m[1]}/`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) return m[0];
  } catch { /* 没在跑 —— 继续起新的 */ }
  return null;
}

/** @param {string} question */
function askYes(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => { rl.close(); resolve(ans.trim().toLowerCase() === 'c'); });
  });
}

async function main() {
  const f = parseArgs(process.argv.slice(2));
  if (f.help === true) { console.log(CARD); return 0; }

  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    console.error(red(`❌ Node 版本过低：需要 >= ${MIN_NODE_MAJOR}，当前 ${process.versions.node}`));
    console.error('   装一个 LTS：https://nodejs.org/ （本项目零依赖，不需要 npm install）');
    return 2;
  }

  const store = resolveStoreRoot(typeof f.store === 'string' ? f.store : undefined);

  /* ── 前置：WorkBuddy 是不是还开着 ────────────────────────────
   * ⚠️ 这里曾经有一个坑（残余 R29）：`isWorkBuddyRunning()` 返回的是
   * `true|false|'unknown'`（布尔 + 一个字符串），而这里当时拿它去比字符串 `'running'`
   * ⇒ 真实双击路径上**永不为真**，那段引导从来没打印过；只有显式传
   * `--app-state running` 才走得到，所以自测是绿的而真实入口失效。
   * 现在先把"探测值"归一成两个布尔 + 一个 unknown，再分支。
   * 注：`--app-state` 的 `auto` 以前也会漏进"都不匹配"，一并修掉。
   */
  const flag = typeof f['app-state'] === 'string' ? f['app-state'] : 'auto';
  const probe = flag === 'auto'
    ? isWorkBuddyRunning()
    // 注入值允许直接写探测器的**返回值类型**（布尔）。原因：真实探测只返回 true/false/'unknown'，
    // 而旧代码拿它比字符串 'running'，只在"注入字符串"时才走得通 —— 那种测试**永远测不出真缺陷**。
    // 所以这里允许 `--app-state true|false|unknown` 直接模拟真实返回值。
    : (flag === 'running' || flag === 'true' ? true
      : flag === 'closed' || flag === 'false' ? false
        : 'unknown');
  const running = probe === true;
  const undetectable = probe === 'unknown';

  if (running && f.yes !== true) {
    console.log('');
    console.log(yellow('⚠  WorkBuddy 正在运行。按这个顺序做，改动才会真的生效：'));
    console.log('');
    console.log(`   ${'1'}）在本控制台里把要改的改完，逐项点「${'应用'}」`);
    console.log(`   ${'2'}）${yellow('行为规则 / 提示词模板')}这两类会被直接拒绝 —— 闸门 ${'app-must-be-closed'}`);
    console.log('        要求 WorkBuddy 已退出；其余（身份 / 配置值 / 风格内容）现在就能写');
    console.log(`   ${'3'}）全部应用完成后，${yellow('自己退出 WorkBuddy')}`);
    console.log(dim('        注意：退出时应用自己也可能回写这批配置。回到本控制台再看一眼，确认内容还在'));
    console.log(`   ${'4'}）再启动 WorkBuddy，并${yellow('新建一个会话')} —— 改动在那时才生效`);
    console.log('');
    console.log(dim('   （提前退出也无妨：退出 WorkBuddy 后重新双击本脚本，顺序一样。）'));
    const go = await askYes('  → 直接回车退出；输入 c 继续：');
    if (!go) { console.log('\n已退出。'); return 3; }
    console.log(yellow('   继续 —— 规则与模板的写入会被拒绝，这是设计如此，不是故障。\n'));
  } else if (undetectable) {
    console.log(yellow('⚠  无法确认 WorkBuddy 是否在运行（进程探测不可用）—— 请自行确认已退出。\n'));
  }

  /* ── 单实例：已经在跑就只开浏览器，不再起第二个 ─────────────── */
  if (f['no-reuse'] !== true) {
    const existing = await probeExisting(store);
    if (existing) {
      console.log(green('✔ 控制台已经在跑，直接打开它（没有起第二个服务）。'));
      console.log(`  ${existing}`);
      // 注意别把"用户主动要求不打开"说成"打开失败了"（曾经这么错过，会误导排障）
      if (f['no-open'] === true) {
        console.log(dim('  （--no-open：未打开浏览器）'));
      } else if (openBrowser(existing)) {
        console.log(dim('  已交给默认浏览器。'));
      } else {
        console.log(yellow('  ⚠ 没能自动打开浏览器 —— 手动复制上面这行。'));
      }
      console.log(dim(`\n  要停掉它：关掉那个正在运行的控制台窗口。`));
      return 0;
    }
  }

  /* ── 起服务 ───────────────────────────────────────────────── */
  let app;
  try {
    app = await startConsole({
      port: f.port !== undefined ? Number(f.port) : 0,
      root: typeof f.root === 'string' ? f.root : undefined,
      // `--store` 与 CLI 同义；不传则走 WORKBUDDY_CONSOLE_HOME / 默认目录
      store: store !== resolveStoreRoot() ? store : undefined,
    });
  } catch (e) {
    console.error(red(`❌ 启动失败：${e?.message ?? e}`));
    if (/EPERM|EACCES/.test(String(e?.message))) {
      console.error(dim(`   数据目录写不进去：${store}`));
      console.error(dim('   检查该目录是否存在/是否被安全软件锁住，或设置 WORKBUDDY_CONSOLE_HOME 指到别处。'));
    }
    return 1;
  }
  const { url, port, urlFile, version, configRoot } = app;

  console.log('');
  console.log(`${green('✔')} WorkBuddy ${bold(version)} 控制台已启动`);
  console.log(`  配置根   ${configRoot}`);
  console.log(`  数据目录 ${tildify(String(store))}`);
  console.log(`  仅监听   127.0.0.1:${port}（不对外开放）`);
  console.log('');
  console.log(`  ${bold(url)}`);
  console.log(dim(`  同一份 URL 落在 ${urlFile}（令牌每次启动都变，别收藏旧的）`));

  if (f['no-open'] !== true) {
    if (openBrowser(url)) console.log(dim('\n  已用默认浏览器打开。'));
    else console.log(yellow('\n  ⚠ 没能自动打开浏览器 —— 请手动复制上面那行 URL。'));
  }

  console.log(CARD);
  console.log(dim('  停止服务：直接关掉本窗口（或按 Ctrl+C）\n'));

  /* ── 常驻 ─────────────────────────────────────────────────── */
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log(green('\n✔ 已停止。'));
    try { await app.close(); } catch { /* 关闭失败不影响退出 */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 父窗口被关掉 / stdin 断开也要停（否则会留下无人认领的后台服务）
  process.stdin.on('end', () => { shutdown(); });
  return new Promise(() => { /* http server 维持事件循环 */ });
}

main().then((code) => { if (typeof code === 'number') process.exitCode = code; }).catch((e) => {
  console.error(red(`❌ 未预期的错误：${e?.stack ?? e}`));
  process.exitCode = 1;
});