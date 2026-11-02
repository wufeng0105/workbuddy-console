#!/usr/bin/env node
/**
 * 一键启动器 —— 双击「start-console.cmd」时跑的就是它。
 *
 * 为什么需要它（三件"手敲命令一定会错"的事）：
 *   1. 令牌每次启动都变 → 由它解析 URL 并开浏览器，你不必手抄（手抄过一次，全 401）
 *   2. 容易忘了先退 WorkBuddy → 它先探测进程，**运行中默认拒绝启动**（见 docs/framework.md 闸门层）
 *   3. 不知道改完要不要重启 → 它按把手类别打印生效点（规则/模板要重启；身份/配置/风格新建会话即可）
 *
 * **生命周期**：这个进程就是服务本身。窗口不关 = 服务一直在；关窗口 = 服务停。
 *
 * 关窗口到底走哪条路（残余 R48，独立审计 WP24 用真控制台窗口实测过）：
 *   点右上角 X → Windows 发 `CTRL_CLOSE_EVENT` → **Node 把它映射成 SIGHUP**（不是 SIGINT/SIGTERM）。
 *   所以必须监听 SIGHUP，否则进程被默认处置直接杀掉、`shutdown()` 一次都跑不到。
 *   按 Ctrl+C 走的是 SIGINT，那是另一条路。
 *
 * 关于"stdin 断开也要停"：**这句话是错的，代码已删**（残余 R48）。
 *   双击场景下 stdin 是控制台，控制台被关时进程先被 SIGHUP 杀掉，stdin 永远不会"结束"；
 *   而如果真去 `resume()` 它、好让 `end` 能触发，`<nul` 启动时 stdin 立刻 EOF ⇒ 控制台一启动就自杀。
 *   留着它只会让下一个人以为这条路被守住了。
 *
 * 参数（`--help` 里也列）：见下方 `FLAGS` —— **那是唯一来源**，未知参数会硬报错。
 * 退出码：见下方 `EXIT`（也打在 `--help` 里）。
 */

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { startConsole } from './server.mjs';
import { storeRoot as resolveStoreRoot, tildify } from './core/paths.mjs';
import { isWorkBuddyRunning } from './core/appstate.mjs';
import { checkNodeVersion } from './core/nodereq.mjs';

const MIN_NODE_MAJOR = 20;

/**
 * 退出码（**唯一来源**：`--help` 打的就是这张表）。
 *
 * 为什么要写明：独立审计（WP24 第 6 条）指出 `0/1/2/3` 的含义**全仓库没有任何一处文档**，
 * 于是用户/脚本看到 `exit 1` 只能猜。
 */
const EXIT = {
  ok: 0,
  startFail: 1,
  usage: 2,
  declined: 3,
  refuseOrphan: 4,
};

/** 退出码说明（打给用户看） */
const EXIT_TABLE = [
  ['0', '正常（包含"已有实例，直接打开它"这条路）'],
  ['1', '服务起不来（端口被占、数据目录写不进去…）'],
  ['2', '用不了：参数写错、Node 版本过低'],
  ['3', '你在提示处选择了退出（没有起服务）'],
  ['4', '拒绝遗弃旧实例（--no-reuse 遇到已在跑的实例，未确认）'],
];

/**
 * 参数表 —— **唯一来源**：`--help` 从它生成；未知参数、缺值、值域全都拿它校验。
 *
 * ⚠️ 之前这张表不存在：8 个参数**一个都没在 `--help` 里出现**（README 也没有），
 * 而拼错的参数被**静默忽略** —— 实测 `--stroe X` 没有任何抱怨，静默回落到默认 store（残余 R51）。
 *
 * `bool: true` = 开关（不带值）；带 `arg` = 必须有值。`values` = 允许取值集合。
 * 这三样是**校验的依据**，不是注释：独立复核（WP25）实测，只做"未知参数报错"而不做这三样时，
 * `--store`（不给值）、`--store ""`、`--port`（不给值）、`--port abc`、`--app-state NONSENSE`
 * 全都还能**静默**走偏 —— 其中 `--port` 不给值甚至会 `Number(true) = 1` 去监听 1 号端口并常驻。
 */
const FLAGS = {
  port: { arg: '<n>', desc: '固定端口（默认 0 = 随机，不会撞端口）' },
  store: { arg: '<dir>', desc: '数据目录（默认 %USERPROFILE%\\.workbuddy-console；也可用 WORKBUDDY_CONSOLE_HOME）' },
  root: { arg: '<dir>', desc: 'WorkBuddy 配置根（默认 ~/.workbuddy）' },
  'no-open': { bool: true, desc: '不自动打开浏览器' },
  'no-reuse': { bool: true, desc: '忽略已在跑的实例、强制新起一个（会让旧实例失去入口，需确认）' },
  yes: { bool: true, desc: '跳过确认（"WorkBuddy 在跑" / "遗弃旧实例"）' },
  'app-state': {
    arg: '<s>',
    desc: 'auto|running|closed|true|false|unknown —— 覆盖进程探测（自测注入）',
    values: ['auto', 'running', 'closed', 'true', 'false', 'unknown'],
  },
  'selftest-emit': { arg: '<sig>', desc: '自测注入：服务起来后自己触发这个信号（只**触发**，不负责注册监听）' },
  'selftest-report-listeners': { bool: true, desc: '自测注入：报告本进程注册了哪些信号监听，然后退出（**只报告**，不注册任何东西）' },
  help: { bool: true, desc: '看这份说明' },
};

/** 需要关注的信号（停止路径 + 自测报告用；**唯一来源**） */
const LIFECYCLE_SIGNALS = ['SIGINT', 'SIGHUP', 'SIGTERM'];

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

/**
 * 把参数校验做全（残余 R51 的第二半，由独立复核 WP25 实测补出来的）：
 * 1. **未知参数** → 报错（含"你是不是想写 X"）
 * 2. **需要值的参数没给值** → 报错（`--store` / `--store ""` / `--port` 后面什么都没有）
 * 3. **开关给了值** → 只接受 `--yes=true|false` 这种显式布尔，其余报错
 * 4. **值域** → `--port` 必须 0–65535 的整数；`--app-state` 必须在允许集合里
 *
 * 为什么必须做全：只做第 1 条时，`--port` 不给值会 `Number(true) === 1`，
 * 于是启动器真的去监听 **1 号端口**并常驻；`--store ""` 会静默回落默认目录。
 * 这些都不是"报错不友好"，而是**用户以为改了、实际没改**。
 *
 * @param {Record<string, string|boolean>} f 会被就地规范化（`--yes=true` → `true`）
 * @returns {string[]} 错误消息（空数组 = 通过）
 */
function validateArgs(f) {
  const errors = [];
  for (const [name, meta] of Object.entries(FLAGS)) {
    if (!(name in f)) continue;
    const v = f[name];
    if (meta.bool) {
      if (v === true) continue;
      if (v === 'true') { f[name] = true; continue; }
      if (v === 'false') { f[name] = false; continue; }
      errors.push(`--${name} 是开关，不带值；收到 "${v}"`);
      continue;
    }
    if (v === true || (typeof v === 'string' && v.trim() === '')) {
      errors.push(`--${name} ${meta.arg} 需要一个值（没给）`);
      continue;
    }
    if (meta.values && !meta.values.includes(String(v))) {
      errors.push(`--${name} 只能是 ${meta.values.join(' / ')}，收到 "${v}"`);
      continue;
    }
    if (name === 'port') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        errors.push(`--port 必须是 0–65535 的整数，收到 "${v}"`);
      }
    }
  }
  return errors;
}

/** 编辑距离，只为给拼错的参数一个"你是不是想写…" */function editDistance(a, b) {
  const m = a.length; const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** @param {string} name @returns {string|null} 最接近的已知参数（够近才给） */
function suggestFlag(name) {
  let best = null; let bestD = Infinity;
  for (const known of Object.keys(FLAGS)) {
    // 相邻换位（store ↔ stroe）在编辑距离里算 2 步，但人眼里就是"打错了"。
    // 所以除了标准编辑距离，再单独试一次"把 name 的相邻两位换回来"。
    const swaps = [name];
    for (let i = 0; i + 1 < name.length; i += 1) {
      const a = name.slice(0, i) + name[i + 1] + name[i] + name.slice(i + 2);
      swaps.push(a);
    }
    const d = Math.min(...swaps.map((s) => editDistance(s, known)));
    if (d < bestD) { bestD = d; best = known; }
  }
  // 阈值：短参数容 1 步，长参数容 2 步。再远就不是"打错"，不该乱猜。
  const limit = name.length >= 4 ? 2 : 1;
  return bestD <= limit ? best : null;
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

/** `--help` 的正文：操作卡 + 参数表 + 退出码表（三张表都在这里，别处不许另写一份） */
function helpText() {
  const lines = [CARD, bold('参数')];
  for (const [name, meta] of Object.entries(FLAGS)) {
    const left = `  --${name}${meta.arg ? ` ${meta.arg}` : ''}`;
    lines.push(`${left.padEnd(26)}${dim(meta.desc)}`);
  }
  lines.push('', bold('退出码'));
  for (const [code, desc] of EXIT_TABLE) lines.push(`  ${code}   ${dim(desc)}`);
  return `${lines.join('\n')}\n`;
}

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
 * 那个地址上跑的**是不是我们的控制台**？入口文件还靠得住吗？
 *
 * ⚠️ 判据曾经只是"那个端口上的 `/` 回 200"（残余 R46，独立审计 WP24 第 2(b) 条）：
 * 让一个**外来 HTTP 服务**占住陈旧 `console-url.txt` 里的端口后，启动器会打印
 * 「✔ 控制台已经在跑」、把**那个外来地址**交给用户、**exit 0、根本不起服务**。
 *
 * 现在的判据是三段，缺一不可（后两段是独立复核 WP25 逼出来的）：
 *   ① 不带令牌 `/api/overview` → **401**，且响应体是 `{error:{code:'UNAUTHORIZED'}}`；
 *      （WP25 实测：只查状态码、不查响应体时，一个"回 401 + 别的 JSON"的外来服务就会被误认）
 *   ② **带上文件里那个令牌**再请求 → 必须 **200**；
 *      （否则"控制台在跑、但入口文件里的令牌已经对不上"——那时把地址交给用户也是白给）
 *   ③ 文件**存在但解析不出来** → 不能当作"没有实例"（那正是孤儿的新产线：文件一坏就起第二个、
 *      覆盖入口、旧实例还活着却没人知道 —— WP25 第 2 条）。
 *
 * @param {string} store
 * @returns {Promise<{status:'none'|'live'|'dead'|'unverifiable', url?:string, tokenOk?:boolean, why?:string}>}
 */
async function probeExisting(store) {
  const f = path.join(store, 'state', 'console-url.txt');
  if (!fs.existsSync(f)) return { status: 'none' };
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) { return { status: 'unverifiable', why: `读不出来：${e?.code ?? e}` }; }
  const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(text);
  // 文件在、但里面没有一行是我们认得的地址 ⇒ **不知道**有没有实例在跑，不能当成"没有"
  if (!m) return { status: 'unverifiable', why: '文件里找不到 127.0.0.1:<端口>/?token=… 这一行' };

  const base = `http://127.0.0.1:${m[1]}`;
  try {
    // ① 是我们的控制台吗
    const r = await fetch(`${base}/api/overview`, { signal: AbortSignal.timeout(1500) });
    if (r.status !== 401) return { status: 'dead' };
    const body = await r.json().catch(() => null);
    if (body?.error?.code !== 'UNAUTHORIZED') return { status: 'dead' };

    // ② 文件里那个令牌还对得上吗
    const authed = await fetch(`${base}/api/overview?token=${m[2]}`, { signal: AbortSignal.timeout(1500) });
    return { status: 'live', url: m[0], tokenOk: authed.status === 200 };
  } catch {
    // 没在跑 —— 重启一个是对的
    return { status: 'dead' };
  }
}

/** @param {string} question */
function askYes(question) {
  // 非交互（重定向 / 自测 / 管道）时一律当作"没有确认" —— 默认保守，不替用户做危险决定
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => { rl.close(); resolve(ans.trim().toLowerCase() === 'c'); });
  });
}

async function main() {
  const f = parseArgs(process.argv.slice(2));

  /* ── 参数校验：未知参数**硬报错**（残余 R51）────────────────── */
  const unknown = Object.keys(f).filter((k) => !(k in FLAGS));
  if (unknown.length) {
    for (const k of unknown) {
      const s = suggestFlag(k);
      console.error(red(`❌ 未知参数：--${k}`) + (s ? yellow(`　你是不是想写 --${s}？`) : ''));
    }
    console.error(dim('   --help 看全部参数。'));
    return EXIT.usage;
  }

  /* ── 参数校验第二半：缺值 / 开关带值 / 值域（WP25 实测出来的静默走偏）── */
  const argErrors = validateArgs(f);
  if (argErrors.length) {
    for (const msg of argErrors) console.error(red(`❌ ${msg}`));
    console.error(dim('   --help 看全部参数。'));
    return EXIT.usage;
  }

  if (f.help === true) { console.log(helpText()); return EXIT.ok; }

  /* ── Node 版本（判定走可被断言的那个纯函数，见 core/nodereq.mjs）── */
  const nodeCheck = checkNodeVersion(process.versions.node, MIN_NODE_MAJOR);
  if (!nodeCheck.ok) {
    const why = nodeCheck.major === null ? '（版本号解析不出来）' : '';
    console.error(red(`❌ Node 版本过低：需要 >= ${MIN_NODE_MAJOR}，当前 ${process.versions.node}${why}`));
    console.error('   装一个 LTS：https://nodejs.org/ （本项目零依赖，不需要 npm install）');
    return EXIT.usage;
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
    if (!go) { console.log('\n已退出。'); return EXIT.declined; }
    console.log(yellow('   继续 —— 规则与模板的写入会被拒绝，这是设计如此，不是故障。\n'));
  } else if (undetectable) {
    console.log(yellow('⚠  无法确认 WorkBuddy 是否在运行（进程探测不可用）—— 请自行确认已退出。\n'));
  }

  /* ── 单实例：已经在跑就只开浏览器，不再起第二个 ─────────────── */
  const existing = await probeExisting(store);

  /**
   * 入口文件**存在但认不出**（坏掉 / 被别的程序改写）：不能当作"没有实例"。
   *
   * 这正是孤儿的新产线（独立复核 WP25 第 2 条）：把 `console-url.txt` 写坏，
   * 再启动就会**静默**起第二个、覆盖入口，而旧实例还活着、API 仍 200 —— 没人知道它在。
   * 闸门原来只看"文件里那个地址还活不活"，而输入本身坏了时就等于没有闸门。
   * 处置：**明说"不知道"并要确认**（非交互 ⇒ 拒绝，退出码 4），不替用户做危险决定。
   */
  if (existing.status === 'unverifiable' && f.yes !== true) {
    console.log('');
    console.log(yellow('⚠  入口文件存在，但内容认不出来：'));
    console.log(dim(`  ${path.join(store, 'state', 'console-url.txt')}`));
    console.log(dim(`  原因：${existing.why}`));
    console.log('');
    console.log('  这意味着**无法确认**现在有没有实例在跑。直接起一个新的，');
    console.log('  可能会把旧的那个变成孤儿（它还活着、还占着端口，但入口被覆盖）。');
    console.log(dim('  不确定的话：先看看有没有控制台窗口开着，把它关掉再来。'));
    console.log('');
    const go = await askYes('  → 直接回车退出（先去确认）；输入 c 仍然起一个新的：');
    if (!go) {
      console.log('\n已退出 —— 没有起服务。');
      return EXIT.refuseOrphan;
    }
    console.log(yellow('   仍要起新的 —— 如果旧实例还在，它将被遗弃。\n'));
  }

  if (f['no-reuse'] !== true && existing.status === 'live') {
    if (existing.tokenOk === false) {
      /**
       * 是我们的控制台，但入口文件里的**令牌对不上**（文件被旧的一次运行留下的）。
       * 这种情况**不许**再起第二个（那是孤儿），也**不许**把这份没用的地址交给用户 ——
       * 如实说清楚，让他去那个窗口里复制新地址。WP25 探过这条：只验状态码会把这种情况漏过去。
       */
      console.log(yellow('⚠  控制台在跑，但入口文件里的令牌已经对不上了（那份地址打开会全是 401）。'));
      console.log(dim('  去那个正在运行的控制台窗口里复制地址（每次启动令牌都会变）。'));
      console.log(dim('\n  要停掉它：关掉那个窗口。'));
      return EXIT.ok;
    }
    console.log(green('✔ 控制台已经在跑，直接打开它（没有起第二个服务）。'));
    console.log(`  ${existing.url}`);
    // 注意别把"用户主动要求不打开"说成"打开失败了"（曾经这么错过，会误导排障）
    if (f['no-open'] === true) {
      console.log(dim('  （--no-open：未打开浏览器）'));
    } else if (openBrowser(existing.url)) {
      console.log(dim('  已交给默认浏览器。'));
    } else {
      console.log(yellow('  ⚠ 没能自动打开浏览器 —— 手动复制上面这行。'));
    }
    console.log(dim('\n  要停掉它：关掉那个正在运行的控制台窗口。'));
    return EXIT.ok;
  }

  /**
   * `--no-reuse` + 已有实例 ⇒ **必须显式告知并要求确认**（残余 R47）。
   *
   * 为什么不能静默：新实例会**覆盖** `state/console-url.txt`，旧实例还活着、API 还好用，
   * 但**没有任何入口指向它**了 —— 于是留下一个占着端口的孤儿。
   * 这不是假设：独立审计复现了孤儿（旧实例仍 200、入口被覆盖），
   * 而本工程在审计之前就已经手工停掉过**两个真实孤儿**（一个 4 小时、一个 24 小时仍跑着旧代码）。
   *
   * 默认保守：非交互（重定向 / 自测 / 管道）拿不到确认 ⇒ **拒绝**，不起第二个。
   */
  if (f['no-reuse'] === true && existing.status === 'live') {
    console.log('');
    console.log(yellow('⚠  已经有一个控制台在跑：'));
    console.log(`  ${existing.url}`);
    console.log('');
    console.log('  --no-reuse 会**再起一个**，并让上面那个失去入口：');
    console.log(dim('  它还活着、还占着端口、API 也还能用，但地址文件里只剩新地址了。'));
    console.log(dim('  要停掉旧的：去关它那个窗口（或先按 Ctrl+C）。'));
    console.log('');
    if (f.yes !== true) {
      const go = await askYes('  → 直接回车退出（保留旧实例）；输入 c 仍要另起一个：');
      if (!go) {
        console.log('\n已退出 —— 没有起第二个，旧的那个仍在跑。');
        return EXIT.refuseOrphan;
      }
    }
    console.log(yellow('   另起一个 —— 旧实例将被遗弃。\n'));
  }

  /* ── 起服务 ───────────────────────────────────────────────── */
  const wantPort = f.port !== undefined ? Number(f.port) : 0;
  let started;
  try {
    started = await startConsole({
      port: wantPort,
      root: typeof f.root === 'string' ? f.root : undefined,
      // `--store` 与 CLI 同义；不传则走 WORKBUDDY_CONSOLE_HOME / 默认目录
      store: store !== resolveStoreRoot() ? store : undefined,
    });
  } catch (e) {
    const msg = String(e?.message ?? e);
    /* 端口被占：要说人话（残余 R49）。原来只回裸 EADDRINUSE + exit 1，用户只能猜。 */
    if (/EADDRINUSE/.test(msg)) {
      console.error(red(`❌ 端口被占用：${wantPort}`));
      console.error(dim('   要么关掉占着它的程序，要么换一个端口：--port 8080'));
      console.error(dim('   （不传 --port 时用的是随机端口，正常不会撞）'));
      console.error(dim(`   看谁占着：netstat -ano | findstr :${wantPort}`));
      return EXIT.startFail;
    }
    console.error(red(`❌ 启动失败：${msg}`));
    if (/EPERM|EACCES|ENOTDIR|EEXIST/.test(msg)) {
      console.error(dim(`   数据目录写不进去：${store}`));
      console.error(dim('   检查该目录是否存在/是否被安全软件锁住，或设置 WORKBUDDY_CONSOLE_HOME 指到别处。'));
    }
    return EXIT.startFail;
  }
  const { url, port, urlFile, version, configRoot } = started;

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
  /** 真的关掉那个 http server —— 注意是 `started.app`，不是 `started` 本身 */
  const closeServer = async () => {
    try {
      await started.app.close();
      return true;
    } catch (e) {
      // 关不掉不影响退出（进程马上就要没了），但**不许再静默**：说一句，异步写盘好让它落下去。
      process.stderr.write(`（关服务时出错：${e?.message ?? e}）\n`);
      return false;
    }
  };
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log(green('\n✔ 已停止。'));
    await closeServer();
    process.exit(EXIT.ok);
  };
  process.on('SIGINT', shutdown);   // Ctrl+C
  /**
   * ⚠️ **必须有这一条**：关控制台窗口（点 X）在 Windows 上走的是
   * `CTRL_CLOSE_EVENT` → Node 映射成 **SIGHUP**（残余 R48，真窗口实测）。
   * 少了它，进程会被默认处置直接杀掉 —— 服务确实会停，但 `shutdown()` 一次都跑不到，
   * 也不会有任何机会做收尾。
   */
  process.on('SIGHUP', shutdown);
  process.on('SIGTERM', shutdown);
  // 这里**故意不再有** `process.stdin.on('end', …)`：那是一段永远不会触发的死代码，
  // 详见文件头注释（控制台被关时进程先被杀；而 resume() 会让 `<nul` 一启动就自杀）。

  /**
   * 自测注入之一：**只报告**本进程注册了哪些信号监听，然后退出。
   *
   * 为什么必须有它（独立复核 WP25 的关键发现）：原来只有 `--selftest-emit`，
   * 而那条断言既验"注册了"又验"停得掉"，两者是**同一个开关**触发的 ——
   * 于是把 `process.on('SIGHUP', …)` 挪进 `if (selftest-emit)` 分支里（真实路径等于没接线），
   * 断言**照样 19/19 全绿**，而同副本的真窗口实验立刻退化成 `^C` + 没有「✔ 已停止。」
   * （也就是说：断言钉的是自己的监听器数组，不是操作系统的投递）。
   *
   * 现在两个开关各管一件事：
   *   · `--selftest-report-listeners`（这里）：**不带任何别的注入**跑，报告真实路径上注册了什么；
   *   · `--selftest-emit <sig>`（下面）：只负责**触发**，不负责注册。
   * 断言两条都要过 ⇒ "只在自测分支里接线"这种变异一定会红。
   */
  if (f['selftest-report-listeners'] === true) {
    for (const sig of LIFECYCLE_SIGNALS) {
      process.stdout.write(`SELFTEST-LISTENERS:${sig}=${process.listenerCount(sig) > 0}\n`);
    }
    /**
     * 顺带把"关得掉吗"也报出来（残余 R53）：这里必须用 `started.app.close()`。
     * 之前 `shutdown()` 里写的是 `app.close()` —— 而 `app` 是 `startConsole` 的**返回对象**，
     * 上面根本没有 `close` 方法 ⇒ 每次都是 `TypeError`，被 `catch {}` 吞掉，
     * 于是"优雅关掉 server"**从来没执行过**，端口一直是靠 `process.exit()` 才释放的。
     * 那条断言当时只验"打印了已停止 + 退出码 0"，验不出这个。
     */
    const closedOk = await closeServer();
    process.stdout.write(`SELFTEST-CLOSED=${closedOk}\n`);
    process.exit(closedOk ? EXIT.ok : EXIT.startFail);
  }

  /**
   * 自测注入之二：服务起来后自己**触发**一个信号，好让断言能行为地验证停止路径。
   *
   * 为什么需要它：更早版本的断言是纯字符串匹配（只查源码里有没有 `process.on('SIGINT'`），
   * 独立审计（WP24 的 M1）把 `shutdown()` 改成空转、只留那四个字符串 → 13 条断言**全绿**。
   * 现在：`--selftest-emit SIGHUP` → 看进程有没有真的打出「✔ 已停止。」并退出 0。
   */
  if (typeof f['selftest-emit'] === 'string') {
    const sig = f['selftest-emit'];
    process.stdout.write('\x00SELFTEST-READY\x00\n');
    setTimeout(() => {
      process.stdout.write(`\x00SELFTEST-EMIT:${sig}=${process.listenerCount(sig) > 0}\x00\n`);
      process.emit(sig);
    }, 120);
  }
  return new Promise(() => { /* http server 维持事件循环 */ });
}

main().then((code) => { if (typeof code === 'number') process.exitCode = code; }).catch((e) => {
  console.error(red(`❌ 未预期的错误：${e?.stack ?? e}`));
  process.exitCode = 1;
});
