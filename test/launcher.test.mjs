/**
 * 启动器自测 —— 零依赖，不起真实服务、不开窗口。
 *
 * 覆盖的是"改了会静默坏掉"的那些行为：
 *   · Node 版本门槛（低版本必须拒绝，而不是跑出奇怪的错）—— 判定是**行为**断言（R50）
 *   · `--store` / `--root` 是否真的透传（曾经 `--store` 是个假参数）
 *   · 单实例复用判据（在跑就复用，没在跑就起新的）—— 判据是**指纹**不是"回 200"（R46）
 *   · 关窗口 = 服务停（信号走 SIGHUP，行为验证）—— R48
 *   · `--no-reuse` 不许静默遗弃旧实例（R47）· 端口被占给人话（R49）· 参数有入口、写错硬报错（R51）
 *
 * ⚠️ 三类断言的分界（WP24 第 8 条审计后收紧）：
 *   · **行为断言**：起真子进程，只断言它打印/退出/副作用。
 *   · **【静态】断言**：只查源码；必须**剥注释**；且**只许用于跨文件数据判据或接线存在性**。
 *     **不许**用它来守"某个行为还在" —— 实测有三条这么写的断言把实现改成空转后**全绿**（R50），
 *     其中一条还**钉错了信号**（查 SIGINT/SIGTERM，而真实路径走 SIGHUP）。
 *   · 每条静态断言都要在注释里写明"为什么不能行为化"；写不出来，就说明它该行为化。
 *
 * 运行：node --test test/launcher.test.mjs
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WP11 改造说明（审计 07-assertions-frontend.md F8 / 类枚举 D）
 *
 * 原状：11 条断言**全部**是 `readFileSync` + 正则，不 import、不执行 `src/launch.mjs`，
 * 也**不剥注释**。后果（实测）：
 *   · `--store` 被改成 `store: undefined`（洞 B，正是该断言自称防住的历史缺陷）→ 全绿；
 *   · 把 `'unknown'` 分支删掉、字面量降级成注释（M18）→ 全绿；
 *   · `start-console.cmd` 里的注释也参与匹配。
 *
 * 现在分两类，边界写死：
 *   · **行为断言**（不带【静态】标记）：起**真子进程**跑 `src/launch.mjs` 或 `start-console.cmd`
 *     之外的真入口，只断言它打印了什么、退出了几位、有没有真的去探测/复用。
 *   · **【静态】断言**：只能查源码/文件的，一律先**剥注释**再匹配（`.cmd` 剥 REM，JS 剥 // 与 /* *\/），
 *     并在断言名里标明【静态】。每条都写清为什么不能行为化。
 * ══════════════════════════════════════════════════════════════════════════
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const LAUNCH = path.join(REPO, 'src', 'launch.mjs');
const CMD = path.join(REPO, 'start-console.cmd');

const readLaunch = () => fs.readFileSync(LAUNCH, 'utf8');

/* ══════════ 剥注释 ══════════ */

/** 去掉 JS 注释，只留可执行代码 —— 静态断言必须只看代码，否则"注释里写一遍"就能满足正则 */
function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
    .replace(/^[ \t]*\/\/.*$/gm, '');      // 整行注释
}

/** 去掉 .cmd 的注释行（批处理的注释语法与 JS 不同：REM / ::） */
function stripCmdComments(src) {
  return src
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:rem\b|::)/i.test(line))
    .join('\n');
}

const stripLaunch = () => stripJsComments(readLaunch());
const readCmd = () => fs.readFileSync(CMD, 'utf8');

/* ══════════ 行为断言的夹具：真子进程 / 假实例 / 临时 store ══════════ */

/** 临时 store 目录（含 state/ 子目录），用完必须删 */
function mkStore(tag = 'wbc-launch-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  return dir;
}

/** 写一份"上次启动留下的 URL 文件"（launch.mjs 的 probeExisting 就认这个格式） */
function writeConsoleUrl(store, url) {
  fs.writeFileSync(
    path.join(store, 'state', 'console-url.txt'),
    `# workbuddy-console · 启动于 (test)\n# 令牌随每次启动变化；本文件每次启动重写\n\n# 控制台\n${url}\n`,
    'utf8',
  );
}

/** 一个**锚点能解析**的最小 WorkBuddy 配置根 —— 空目录会被"拒绝猜测"顶回来 */
function mkConfigRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wbc-launch-cfg-'));
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user-1390000000-personal'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins', 'cache', 'workbuddy-builtin', 'welcomemode-code',
    '5.9.3-wb.launchtest.g0000.h0000'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'app-config.json'),
    JSON.stringify({ personalization: { toneStyle: 'efficient', customPrompt: '' } }, null, 2));
  fs.writeFileSync(path.join(root, 'settings.json'),
    JSON.stringify({ sandbox: { orderedRules: { file: { rules: [] } } } }, null, 2));
  fs.writeFileSync(path.join(root, 'user-1390000000-personal', 'SOUL.md'), '# 人设\n', 'utf8');
  return root;
}

/**
 * 一个**真的会应答**的假控制台。
 *
 * ⚠️ 它必须带上**指纹**（残余 R46）。曾经复用判据只是"那个端口上的 `/` 回 200"，
 * 于是任何外来 HTTP 服务都会被当成我们的控制台 —— 启动器打印「已经在跑」、
 * 把外来地址交给用户、exit 0、根本不起服务（独立审计 WP24 第 2(b) 条实测）。
 * 真控制台的特征是：不带令牌访问 `/api/overview` → **401** 且响应体是
 * `{error:{code:'UNAUTHORIZED'}}`。假控制台必须照这个来，否则测的是旧判据。
 *
 * @param {{ours?: boolean}} [opts] `ours:false` → 一个**外来**服务器（对什么都回 200）
 */
async function startFakeConsole({ ours = true } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    if (ours && req.url.startsWith('/api/overview')) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: '缺少或错误的会话令牌' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  return {
    hits,
    url: `http://127.0.0.1:${port}/?token=FAKE-TOKEN-abc123`,
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}

/**
 * 子进程环境：把测试运行器自己的隔离变量摘掉，并清掉 ELECTRON_RUN_AS_NODE。
 * 不清后者会让孩子"当 Node 跑、静默退出码 0"（AGENTS.md 记过的坑）。
 */
function childEnv(extra = {}) {
  const env = { ...process.env };
  delete env.WORKBUDDY_CONSOLE_HOME;
  delete env.WORKBUDDY_CONFIG_DIR;
  delete env.WORKBUDDY_BASELINES_DIR;
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, ...extra };
}

/**
 * 跑真启动器，收集 stdout+stderr。
 *
 * @param {string[]} args
 * @param {{env?:Record<string,string>, waitFor?:RegExp|null, timeoutMs?:number}} opts
 *   `waitFor` 命中即返回并**收掉**子进程 —— 用于"它已经开始常驻，我们只想看它打印了什么"。
 * @returns {Promise<{code:number|null, out:string, how:'exit'|'waitFor'|'timeout'|'error'}>}
 */
function runLaunch(args, { env = {}, waitFor = null, timeoutMs = 25000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LAUNCH, ...args], {
      cwd: REPO,
      env: childEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],   // stdin 关掉：askYes 走 isTTY=false 的分支，不会等输入
      windowsHide: true,
    });
    let out = '';
    let settled = false;
    const finish = (code, how) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // waitFor 命中时它还活着（是个常驻服务）—— 不收掉会把测试进程挂住
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(); } catch { /* 已退出 */ }
      }
      resolve({ code, out, how });
    };
    const timer = setTimeout(() => finish(null, 'timeout'), timeoutMs);
    const onData = (d) => {
      out += d;
      if (waitFor && waitFor.test(out)) finish(child.exitCode, 'waitFor');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => finish(code, 'exit'));
    child.on('error', (e) => { out += `\n[spawn-error] ${e.message}`; finish(-1, 'error'); });
  });
}

/** 断言里要报"打印了什么"时用：只挑跟数据目录有关的行，避免把整屏操作卡灌进失败信息 */
const dataDirLines = (out) => out.split('\n').filter((l) => l.includes('数据目录')).join(' | ');

/* ══════════ 双击入口（只能静态查：它是 cmd.exe 的输入，不是本进程能执行的东西） ══════════ */

test('【静态】双击入口存在，且不依赖工作目录（.cmd 剥 REM 注释后）', () => {
  /**
   * 为什么只能静态：被测对象是 `start-console.cmd`，它的执行环境是 cmd.exe 的
   * "双击"上下文（cwd = 桌面、窗口关掉就杀子进程）。在 `node --test` 里跑它既拿不到
   * 那个上下文，也会因为末尾的 `pause` 卡住。
   */
  assert.ok(fs.existsSync(CMD), 'start-console.cmd 必须存在（用户双击的就是它）');
  const src = stripCmdComments(readCmd());
  assert.match(src, /cd \/d "%~dp0"/i, '必须切到脚本所在目录 —— 双击时 cwd 是桌面，不切会找不到 src/');
  assert.match(src, /node "src\\launch\.mjs"/i, '必须前台运行 launch.mjs（窗口存活 = 服务存活）');
});

test('【静态】双击入口只含 ASCII（cmd.exe 会毁掉非 ASCII 批处理）——本条**不剥注释**', () => {
  /**
   * 这是实测踩过的坑：最初写中文名的 .cmd 且正文含中文，
   * cmd.exe 在 GBK 代码页下把中文提示解析成了命令，报
   * `'重新双击本文件即可。' is not recognized as an internal or external command`。
   * 中文提示一律交给 Node 输出（UTF-8 不受影响）。
   *
   * ⚠️ 本条**故意不剥注释**：cmd.exe 是逐字节读这个文件的，
   * REM 行里的非 ASCII 字节同样会把它读崩 —— 剥了注释再查，等于放过真实缺陷。
   */
  const buf = fs.readFileSync(CMD);
  const nonAscii = [...buf].filter((b) => b > 0x7f);
  assert.equal(nonAscii.length, 0, `start-console.cmd 不许含非 ASCII 字节（发现 ${nonAscii.length} 个）`);
});

test('【静态】双击入口检查 Node 与关键文件，缺了就明说（.cmd 剥 REM 注释后）', () => {
  // 只能静态：同上，两条分支都要"缺 node / 缺 src"才能触发，造这两个环境等于真去动系统
  const src = stripCmdComments(readCmd());
  assert.match(src, /where node/i, '必须检查 node 是否存在');
  assert.match(src, /if not exist "src\\launch\.mjs"/i, '必须检查 launch.mjs 是否存在');
  assert.match(src, /pause/i, '必须 pause，否则双击后窗口一闪而过看不到错');
});

/* ══════════ 启动器逻辑 · 静态腿 ══════════ */

test('【静态】Node 版本门槛是 20，且与 package.json engines 一致（剥注释后）', () => {
  /**
   * 为什么只能静态：门槛比的是 `process.versions.node` 的主版本号，测试进程改不了它；
   * 要行为化只能拿旧版 Node 再跑一遍，本仓库不允许装第二个 Node。
   * 但"跨文件一致"这件事本身是数据判据，静态查反而更硬。
   */
  const src = stripLaunch();
  const m = /MIN_NODE_MAJOR\s*=\s*(\d+)/.exec(src);
  assert.ok(m, '找不到 MIN_NODE_MAJOR（剥掉注释后仍必须有真声明）');
  const engines = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).engines?.node ?? '';
  assert.match(engines, new RegExp(`>=\\s*${m[1]}`),
    `MIN_NODE_MAJOR=${m[1]} 必须与 package.json engines（${engines}）一致`);
});

test('【静态】服务端 startConsole 必须接受 store 参数（service 侧剥注释后）', () => {
  /**
   * 为什么这条留在静态：它测的是"函数签名里有没有这个入参"。
   * 这个入参**真的被用起来**那件事，已由下面「--store 真的透传」那条行为断言
   * 端到端证明（起真子进程 → 看它打印的数据目录），不必在这里重复造一个服务。
   */
  const src = stripJsComments(fs.readFileSync(path.join(REPO, 'src', 'server.mjs'), 'utf8'));
  const sig = /export async function startConsole\(\{([^}]*)\}/.exec(src);
  assert.ok(sig, '找不到 startConsole 签名');
  assert.match(sig[1], /\bstore\b/, 'startConsole 的签名里必须有 store');
  assert.match(src, /resolveStoreRoot\(store\)/, '必须把 store 传给 resolveStoreRoot');
});

test('关窗口 = 服务停：**行为**验证停止路径（不是查源码里有没有那几个字符串）', async () => {
  /**
   * 这一条原来是纯静态匹配（查源码里有没有 `process.on('SIGINT'` / `'SIGTERM'` /
   * `await app.close()` / `process.exit(0)`）。独立审计 WP24 第 8 条做了变异实验：
   * 把 `shutdown()` 改成**空转**、只保留那四个字符串 → **13 pass / 0 fail**。
   * 更糟的是它**钉错了信号**：真窗口实测关窗口走的是 **SIGHUP**（`CTRL_CLOSE_EVENT`），
   * 而它只查 SIGINT/SIGTERM —— 守的信号不是那个信号。
   *
   * 现在改成行为断言：`--selftest-emit SIGHUP` 让启动器在服务起来后**自己触发**那个信号，
   * 我们看它有没有真的打出「✔ 已停止。」并退出 0。
   * 这条能红在两种缺陷上：① 删掉 SIGHUP 接线（没人监听 ⇒ 不会停）；
   * ② `shutdown()` 变成空转（同样不会打出「已停止」）。
   */
  const store = mkStore('wbc-launch-stop-');
  try {
    const r = await runLaunch(['--store', store, '--app-state', 'closed', '--no-open',
      '--selftest-emit', 'SIGHUP'], { timeoutMs: 15000 });
    assert.equal(r.code, 0,
      `收到 SIGHUP 后应当优雅停止并退出 0（实际 code=${r.code} how=${r.how}）：${r.out.slice(0, 500)}`);
    assert.match(r.out, /SELFTEST-LISTENERS:SIGHUP=true/,
      `必须真的注册了 SIGHUP（关窗口在 Windows 上走的就是它）：${r.out.slice(0, 500)}`);
    assert.match(r.out, /✔ 已停止。/,
      `收到信号后必须走完停止路径（shutdown 空转时这句话不会出现）：${r.out.slice(0, 500)}`);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('Node 版本门槛的**判定**必须真的生效（行为），常量与 engines 一致是另一条', async () => {
  /**
   * 原来是纯静态：只查 `MIN_NODE_MAJOR = 20` 这个**常量存在**、且与 package.json 的
   * `engines` 一致。独立审计 WP24 第 8 条把**整段判定删掉**（常量留着）→ 13 pass / 0 fail。
   * 这正是工程契约里点名的"常量定义了、没进判定"（残余 R8）。
   *
   * 修法：把判定抽成纯函数 `checkNodeVersion()`（`src/core/nodereq.mjs`），
   * 断言改成**真的去问它**。跨文件一致性（常量 vs engines）留在下面的静态断言里，
   * 那本来就是数据判据，静态查更硬。
   */
  const { checkNodeVersion } = await import('../src/core/nodereq.mjs');
  assert.equal(checkNodeVersion('18.20.4', 20).ok, false, '18 必须被拒');
  assert.equal(checkNodeVersion('20.0.0', 20).ok, true, '20.0.0 必须放行（边界）');
  assert.equal(checkNodeVersion('v20.11.1', 20).ok, true, '带 v 前缀的也要认');
  assert.equal(checkNodeVersion('22.3.0', 20).ok, true, '更高的必须放行');
  assert.equal(checkNodeVersion('', 20).ok, false, '空字符串 ⇒ 解析不出 ⇒ 必须**拒绝**（铁律 3：不猜）');
  assert.equal(checkNodeVersion('nonsense', 20).ok, false, '乱码 ⇒ 同样必须拒绝，不许当成满足');
  assert.equal(checkNodeVersion('20.11.1', 20).major, 20, '主版本号要真的解析出来');
  assert.equal(checkNodeVersion('nonsense', 20).major, null, '解析不出来时主版本号必须是 null（可判定的信号）');
});

test('【静态】版本门槛常量与 package.json engines 必须一致（跨文件数据判据）', () => {
  const src = stripLaunch();
  const m = /MIN_NODE_MAJOR\s*=\s*(\d+)/.exec(src);
  assert.ok(m, '找不到 MIN_NODE_MAJOR（剥掉注释后仍必须有真声明）');
  const engines = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).engines?.node ?? '';
  assert.match(engines, new RegExp(`>=\\s*${m[1]}`),
    `MIN_NODE_MAJOR=${m[1]} 必须与 package.json engines（${engines}）一致`);
});

test('启动失败时必须给可行动的提示（**行为**：真造一个写不进去的数据目录）', async () => {
  /**
   * 原来也是纯静态（查 `EPERM|EACCES` 与 `WORKBUDDY_CONSOLE_HOME` 两个字符串）。
   * WP24 的 M3 把提示整段关进 `if (false)` → 13 pass / 0 fail。
   *
   * 现在真造一次失败：把一个**普通文件**当路径前缀给 `--store`，
   * 于是 `store/state` 永远建不出来（ENOTDIR）—— 与实现无关的确定性失败。
   * 然后看它有没有说"数据目录写不进去"并给出 `WORKBUDDY_CONSOLE_HOME` 这条路。
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbc-launch-fail-'));
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, 'x', 'utf8');
  try {
    const r = await runLaunch(['--store', path.join(blocker, 'sub'), '--app-state', 'closed', '--no-open'],
      { timeoutMs: 12000 });
    assert.equal(r.code, 1, `启动失败必须 exit 1（实际 ${r.code}）：${r.out.slice(0, 400)}`);
    assert.match(r.out, /启动失败/, `必须明说启动失败：${r.out.slice(0, 400)}`);
    assert.match(r.out, /数据目录写不进去/,
      `必须指出是数据目录的问题（而不是只抛栈）：${r.out.slice(0, 400)}`);
    assert.match(r.out, /WORKBUDDY_CONSOLE_HOME/,
      `必须给一条可行动的出路：${r.out.slice(0, 400)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ══════════ 启动器逻辑 · 行为腿（真子进程） ══════════ */

test('--store / --root 真的透传给 startConsole（行为：传了就用，没传才回落到环境变量）', async () => {
  /**
   * 洞 B 的原状：`store: store !== resolveStoreRoot() ? store : undefined` 被改成
   * `store: undefined` 之后整轮全绿 —— 因为旧断言只查 `startConsole({…})` 里有没有
   * `store:` 这个**键名**，不查值。
   *
   * ⚠️ 三证第一版在这里踩过坑：最初断言的是启动器打印的「数据目录」那一行，
   * 结果 `store: undefined` 注入（C2-p1）**照样全绿** —— 因为那一行打印的是启动器自己的
   * `store` 变量（launch.mjs:120 算出来的），跟 `startConsole` 实际用了什么无关。
   * 这正是"在假证据上通过"。
   *
   * 现在只认**副作用**：`startConsole` 会把带令牌的 URL 文件写进它真正解析出来的 store。
   * 那个文件落在哪，才是 `--store` 有没有真的透传的证据。
   */
  const explicit = mkStore('wbc-launch-store-a-');
  const envStore = mkStore('wbc-launch-store-b-');
  const urlFileIn = (store) => path.join(store, 'state', 'console-url.txt');
  try {
    const a = await runLaunch(['--store', explicit, '--app-state', 'closed', '--no-open'], {
      env: { WORKBUDDY_CONSOLE_HOME: envStore },
      waitFor: /数据目录/,
    });
    assert.equal(a.how, 'waitFor', `应打印出「数据目录」这一行（实际 how=${a.how}）：${a.out.slice(0, 400)}`);
    assert.ok(fs.existsSync(urlFileIn(explicit)),
      `--store 传了就必须真的写进它：期望 ${urlFileIn(explicit)} 存在。`
      + `（启动器打印的「数据目录」是它自己的变量，不能当证据）实际打印：${dataDirLines(a.out)}`);
    assert.ok(!fs.existsSync(urlFileIn(envStore)),
      `--store 传了就不许再回落到环境变量那个目录：${urlFileIn(envStore)} 不该被创建`);

    const b = await runLaunch(['--app-state', 'closed', '--no-open'], {
      env: { WORKBUDDY_CONSOLE_HOME: envStore },
      waitFor: /数据目录/,
    });
    assert.equal(b.how, 'waitFor', `应打印出「数据目录」这一行（实际 how=${b.how}）：${b.out.slice(0, 400)}`);
    assert.ok(fs.existsSync(urlFileIn(envStore)),
      `没传 --store 时必须回落到 WORKBUDDY_CONSOLE_HOME：期望 ${urlFileIn(envStore)} 存在。`
      + `实际打印：${dataDirLines(b.out)}`);

    // ③ `--root` 同样必须真的透传。证据是 console 打印的「配置根」——
    //    那个值来自 startConsole 返回的 `describe()`（真走了一遍 resolveConfigRoot(root)），
    //    不是启动器自己的变量。注入 `root: undefined` 会让它回落成 ~/.workbuddy。
    //
    // ⚠️ 配置根必须是一份**锚点能解析**的最小 fixture：空目录会被"拒绝猜测"顶回来
    //    （`无法探测 WorkBuddy 版本`，这正是铁律 3），那条路走不到打印。
    const cfgDir = mkConfigRoot();
    const storeC = mkStore('wbc-launch-store-c-');   // 独立 store：别让①留下的 URL 文件把③带进复用分支
    try {
      const c = await runLaunch(['--store', storeC, '--root', cfgDir, '--app-state', 'closed', '--no-open'], {
        env: { WORKBUDDY_CONSOLE_HOME: envStore },
        waitFor: /配置根/,
      });
      assert.equal(c.how, 'waitFor', `应打印出「配置根」这一行（实际 how=${c.how}）：${c.out.slice(0, 400)}`);
      assert.ok(c.out.includes(path.basename(cfgDir)),
        `--root 传了就必须真的用它（期望 ${path.basename(cfgDir)}）；`
        + `实际打印：${c.out.split('\n').filter((l) => l.includes('配置根')).join(' | ')}`);
    } finally {
      fs.rmSync(cfgDir, { recursive: true, force: true });
      fs.rmSync(storeC, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(explicit, { recursive: true, force: true });
    fs.rmSync(envStore, { recursive: true, force: true });
  }
});

test('已在跑时复用实例，不发第二次启动（行为）', async () => {
  /**
   * 原状只查源码里 `probeExisting` / `signal:` / `no-reuse` 三个词出现过 ——
   * 三处都还在、但判据写坏了（比如永远 null）时它照样绿。
   *
   * 现在：真起一个会应答的假控制台 + 真写一份 URL 文件，跑真启动器，
   * 看它是否(a)说"已经在跑"、(b)没有打印"已启动"、(c)真的只探了一次。
   */
  const store = mkStore();
  const fake = await startFakeConsole();
  try {
    writeConsoleUrl(store, fake.url);
    const r = await runLaunch(['--store', store, '--app-state', 'closed', '--no-open'], { timeoutMs: 9000 });

    assert.equal(r.code, 0, `复用时应正常退出 0（实际 ${r.code}）：${r.out}`);
    assert.match(r.out, /已经在跑/, `必须报告"已经在跑"，而不是闷头起第二个：${r.out}`);
    assert.doesNotMatch(r.out, /控制台已启动/, `已经复用了就不许再起一个服务：${r.out}`);
    assert.equal(fake.hits.length, 1,
      `复用判据必须真的去探那个实例（"端口真的应答"而不是"文件在"），实际探测 ${fake.hits.length} 次`);
  } finally {
    await fake.close();
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('不打开浏览器不能被说成"打开失败"（行为）', async () => {
  /**
   * 曾经：`if (no-open !== true && openBrowser(url))` …… `else 打印失败`。
   * 用户传 --no-open 时走 else，输出「没能自动打开浏览器」—— 把自己的选择说成故障。
   *
   * 旧断言只做一次正则块匹配（`f['no-open'] === true) {…}`），验的是"分支还在"，
   * 不验"输出对不对"。现在读真启动器打印了什么。
   * 走复用路径（已经在跑）—— 那里也有一份同样的文案，两条路径都必须对。
   */
  const store = mkStore();
  const fake = await startFakeConsole();
  try {
    writeConsoleUrl(store, fake.url);
    const r = await runLaunch(['--store', store, '--app-state', 'closed', '--no-open'], { timeoutMs: 9000 });
    assert.equal(r.code, 0, `应正常退出 0（实际 ${r.code}）：${r.out}`);
    assert.doesNotMatch(r.out, /没能自动打开浏览器/,
      `用户明确要求 --no-open，绝不许把自己的选择说成"打开失败"：${r.out}`);
    assert.match(r.out, /未打开浏览器/, `应当明说"按你的要求没打开浏览器"：${r.out}`);
  } finally {
    await fake.close();
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('WorkBuddy 在跑时必须先劝阻，探测不到必须如实说"无法确认"（行为）', async () => {
  /**
   * 原状（M18）：把 `else if (state === 'unknown')` 整段删掉、`'unknown'` 写进注释，
   * 整轮仍全绿 —— 因为旧断言不剥注释。
   *
   * 现在两条腿都读真启动器的输出：
   *   ① `--app-state running`：必须先劝阻并**拒绝往下走**（stdin 非 TTY → askYes=false → exit 3）；
   *   ② `--app-state unknown`：必须如实说"无法确认"，不许当成没在运行。
   */
  // ① 在跑 → 劝阻 + 不肯启动
  const denyStore = mkStore('wbc-launch-deny-');
  try {
    const running = await runLaunch(['--app-state', 'running', '--no-open', '--store', denyStore]);
    assert.equal(running.code, 3, `探测到在跑时必须拒绝启动（期望 exit 3，实际 ${running.code}）：${running.out}`);
    assert.match(running.out, /WorkBuddy 正在运行/, `必须明说 WorkBuddy 在跑：${running.out}`);
    assert.match(running.out, /app-must-be-closed/,
      `必须说清"规则/模板会被闸门拒绝"这一类后果：${running.out}`);
    assert.match(running.out, /已退出/, '拒绝之后必须说"已退出"，不能静默返回：' + running.out);
  } finally {
    fs.rmSync(denyStore, { recursive: true, force: true });
  }

  // ② 探测不到 → 如实降级（不猜"没在运行"）
  const store = mkStore();
  const unknown = await runLaunch(['--app-state', 'unknown', '--no-open', '--store', store], {
    waitFor: /无法确认 WorkBuddy 是否在运行/,
  });
  try {
    assert.equal(unknown.how, 'waitFor',
      `探测不到时必须明确说"无法确认"，实际输出：${unknown.out.slice(0, 400)}`);
    assert.match(unknown.out, /请自行确认已退出/,
      `降级文案必须把"该由人来确认"这件事说清楚：${unknown.out}`);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('真实探测返回布尔 true 时必须走引导分支（R29 回归，行为）', async () => {
  /**
   * 为什么这条必须存在（残余 R29）：
   * `isWorkBuddyRunning()` 返回 **true / false / 'unknown'**（布尔 + 一个字符串），
   * 而旧代码判的是 `state === 'running'` —— 拿布尔比字符串，**真实路径上永不为真**，
   * 那段引导从来没打印过。只有显式传 `--app-state running`（字符串）才走得到，
   * 所以自测是绿的、真实双击入口失效。
   *
   * 上一批（WP11）在本文件里写过「默认分支只能静态断言，它读本机进程表」——**那个让步正是
   * 缺陷的藏身处**：静态只查"默认值是不是 isWorkBuddyRunning() 的返回值"，
   * 查不到"返回值类型与比较方式不匹配"。
   *
   * 现在 `--app-state` 允许直接注入探测器的**返回值类型**（布尔），于是这条能真行为化。
   */
  const store = mkStore('wbc-launch-bool-');
  try {
    const r = await runLaunch(['--app-state', 'true', '--no-open', '--store', store]);
    assert.equal(r.code, 3,
      `真实探测为 true（布尔）时必须拒绝启动（期望 exit 3，实际 ${r.code}）：${r.out}`);
    assert.match(r.out, /WorkBuddy 正在运行/, `必须明说在跑：${r.out}`);
    // 用户 2026-11-02 定版的四步顺序必须原文出现（不是"劝你别写"，而是"按这个顺序做"）
    assert.match(r.out, /自己退出 WorkBuddy/, `必须说清第 3 步"自己退出"：${r.out}`);
    assert.match(r.out, /再启动 WorkBuddy/, `必须说清第 4 步"再启动"：${r.out}`);
    assert.match(r.out, /新建一个会话/, `必须说清"新建会话才生效"：${r.out}`);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('R46：外来 HTTP 服务占着旧端口时，**不许**被当成"我们的控制台"（行为）', async () => {
  /**
   * 独立审计 WP24 第 2(b) 条：复用判据原来只看"那个端口上的 `/` 回 200"。
   * 让一个**外来**服务器占住陈旧 `console-url.txt` 里的端口后，启动器会
   * 打印「✔ 控制台已经在跑，直接打开它」、把**外来地址**交给用户、exit 0、**根本不起服务**
   * （外来服务器日志里确实收到了一次 `GET /`）。
   *
   * 现在判据是**指纹**：不带令牌访问 `/api/overview` 必须是 401 且响应体形如
   * `{error:{code:'UNAUTHORIZED'}}`。外来服务器（对什么都回 200）必须被识破，
   * 启动器要**自己起一个**。
   */
  const store = mkStore('wbc-launch-r46-');
  const foreign = await startFakeConsole({ ours: false });
  try {
    writeConsoleUrl(store, foreign.url);
    const r = await runLaunch(['--store', store, '--app-state', 'closed', '--no-open'],
      { waitFor: /控制台已启动/, timeoutMs: 15000 });
    assert.equal(r.how, 'waitFor',
      `外来服务占着端口时必须自己起一个，不许宣称"已经在跑"：${r.out.slice(0, 400)}`);
    assert.doesNotMatch(r.out, /已经在跑/,
      `外来服务器绝不能被认成我们的控制台：${r.out.slice(0, 400)}`);
  } finally {
    await foreign.close();
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('R47：`--no-reuse` 遇到已在跑的实例，必须**拒绝**并说清后果（非交互默认保守）', async () => {
  /**
   * 独立审计 WP24 第 3 条：`--no-reuse` 会起第二个实例并**覆盖** `console-url.txt`，
   * 旧实例还活着、API 还好用，但**没有任何入口指向它** —— 留下一个孤儿。
   * 本工程在审计之前就已经手工停掉过**两个真实孤儿**（一个 4 小时、一个 24 小时）。
   *
   * 现在：非交互（测试里 stdin 是 ignore）拿不到确认 ⇒ **拒绝**，退出码 4，且绝不能已经起了第二个。
   */
  const store = mkStore('wbc-launch-r47-');
  const fake = await startFakeConsole();
  try {
    writeConsoleUrl(store, fake.url);
    const r = await runLaunch(['--store', store, '--app-state', 'closed', '--no-open', '--no-reuse'],
      { timeoutMs: 12000 });
    assert.equal(r.code, 4,
      `--no-reuse 遇到在跑的实例、又拿不到确认时必须拒绝（期望 exit 4，实际 ${r.code}）：${r.out.slice(0, 400)}`);
    assert.match(r.out, /已经有一个控制台在跑/, `必须告诉用户旧的还在：${r.out.slice(0, 400)}`);
    assert.match(r.out, /失去入口/, `必须说清"旧实例会怎样"：${r.out.slice(0, 400)}`);
    assert.doesNotMatch(r.out, /控制台已启动/, '拒绝时**绝不许**已经起了第二个服务');
    assert.equal(fake.hits.length, 1, `应当只探测一次，实际 ${fake.hits.length} 次`);
  } finally {
    await fake.close();
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('R49：端口被占时必须给人话，而不是把裸 EADDRINUSE 丢给用户（行为）', async () => {
  /**
   * 独立审计 WP24 第 6 条：`--port` 被占时只回裸 `EADDRINUSE` + exit 1，没有任何可行动的提示。
   * 现在必须说清"端口被占"，并给出换端口的办法。
   */
  const store = mkStore('wbc-launch-r49-');
  const squatter = await startFakeConsole();
  const busyPort = new URL(squatter.url).port;
  try {
    const r = await runLaunch(['--store', store, '--app-state', 'closed', '--no-open', '--port', busyPort],
      { timeoutMs: 12000 });
    assert.equal(r.code, 1, `端口被占时应 exit 1（实际 ${r.code}）：${r.out.slice(0, 400)}`);
    assert.match(r.out, /端口被占用/, `必须明说端口被占：${r.out.slice(0, 400)}`);
    assert.match(r.out, /--port 8080/, `必须给出换端口的办法：${r.out.slice(0, 400)}`);
    assert.doesNotMatch(r.out, /^❌ 启动失败：listen EADDRINUSE/m,
      `不许把裸 errno 当作唯一解释：${r.out.slice(0, 400)}`);
  } finally {
    await squatter.close();
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('R51：`--help` 必须列全部参数与退出码；未知参数必须硬报错（行为）', async () => {
  /**
   * 独立审计 WP24 第 7 条：`--help` 只打印操作卡，**8 个参数一个都不出现**（README 也没有）；
   * 且拼错的参数被**静默忽略** —— 实测 `--stroe X` 无任何抱怨、静默回落到默认 store，
   * 用户以为改到了数据目录，其实没有。
   */
  const help = await runLaunch(['--help'], { timeoutMs: 10000 });
  assert.equal(help.code, 0, `--help 应 exit 0（实际 ${help.code}）：${help.out.slice(0, 300)}`);
  for (const flag of ['--port', '--store', '--root', '--no-open', '--no-reuse', '--yes', '--app-state', '--help']) {
    assert.ok(help.out.includes(flag), `--help 必须列出 ${flag}：${help.out.slice(0, 600)}`);
  }
  assert.match(help.out, /退出码/, `--help 必须给出退出码含义（WP24 第 6 条：全仓库没有文档）：${help.out.slice(0, 600)}`);

  const bad = await runLaunch(['--stroe', 'X'], { timeoutMs: 10000 });
  assert.equal(bad.code, 2, `未知参数必须 exit 2（实际 ${bad.code}）：${bad.out.slice(0, 300)}`);
  assert.match(bad.out, /未知参数：--stroe/, `必须点名那个参数：${bad.out.slice(0, 300)}`);
  assert.match(bad.out, /--store/, `必须给出"你是不是想写 --store"：${bad.out.slice(0, 300)}`);
});

test('【静态】默认状态必须来自真实进程探测，不许猜（剥注释后）', () => {
  /**
   * 为什么这一条只能静态：默认分支调的是 `isWorkBuddyRunning()`，它读的是**本机进程表**。
   * 断言"输出与真实探测结果一致"看着像行为断言，实际上是**机器相关的**：
   * 在 WorkBuddy 没开的机器上，"写死成没在运行"和"真的探测到没在运行"输出完全一样，
   * 这条断言抓不住最危险的那个方向（永远当没在运行 → 闸门静默失效）。
   * 所以这里退到接线层：默认值必须**是那个函数的返回值**，不许任何常量。
   *
   * ⚠️ 但"只能静态"这个让步本身曾经漏掉过缺陷（R29：返回值是布尔、比较却用字符串）。
   * 现在那条缺陷由上面「真实探测返回布尔 true」那条**行为断言**覆盖，本条只管接线。
   */
  const src = stripLaunch();
  const m = /flag === 'auto'[\s\S]{0,60}\?\s*(\w+\(\))/.exec(src);
  assert.ok(m, '找不到"默认状态"的取值处');
  assert.equal(m[1], 'isWorkBuddyRunning()',
    `默认状态必须直接来自进程探测（实际取的是 ${m[1]}）——猜一个值会让闸门在真在跑时静默失效`);
});

