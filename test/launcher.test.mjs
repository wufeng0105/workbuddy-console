/**
 * 启动器自测 —— 零依赖，不起真实服务、不开窗口。
 *
 * 覆盖的是"改了会静默坏掉"的那些行为：
 *   · Node 版本门槛（低版本必须拒绝，而不是跑出奇怪的错）
 *   · `--store` / `--root` 是否真的透传（曾经 `--store` 是个假参数）
 *   · 单实例复用判据（在跑就复用，没在跑就起新的）
 *   · 关窗口 = 服务停（shutdown 是否真的监听信号）
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

/** 一个**真的会应答**的假控制台：复用判据是"端口真的应答"，不是"文件在" */
async function startFakeConsole() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
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

test('【静态】关窗口 = 服务停：必须监听 SIGINT / SIGTERM 并真的 close（剥注释后）', () => {
  /**
   * 为什么只能静态：Windows 上 `child.kill('SIGINT')` 是**无条件终止**
   * （POSIX 信号不存在，libuv 直接 TerminateProcess），孩子的
   * `process.on('SIGINT', shutdown)` 根本不会跑 —— 于是"行为化"会得到一个
   * 与实现无关的结论。真信号只能由控制台窗口的 Ctrl+C 产生，测试进程发不出来。
   * 所以这里退一步钉住"三条接线都在"，并用剥注释挡住"注释里写一遍就算过"。
   */
  const src = stripLaunch();
  assert.match(src, /process\.on\('SIGINT'/, '必须处理 Ctrl+C');
  assert.match(src, /process\.on\('SIGTERM'/, '必须处理 terminate');
  assert.match(src, /await app\.close\(\)/, 'shutdown 必须真的关掉 http server');
  assert.match(src, /process\.exit\(0\)/, 'shutdown 必须真的退出进程');
});

test('【静态】启动失败时给可行动的提示，而不是只抛栈（剥注释后）', () => {
  /**
   * 为什么只能静态：要触发这条分支得让 `startConsole` 真失败（权限被拒 / 数据目录写不进）。
   * 造这个环境需要改 ACL 或占住目录，代价与风险都超出"零依赖自测"，
   * 而且失败原因在不同机器上不一定是 EPERM/EACCES，行为断言会变成碰运气。
   */
  const src = stripLaunch();
  assert.match(src, /EPERM\|EACCES/, '必须识别权限错误并给出提示（数据目录写不进去是实测踩过的坑）');
  assert.match(src, /WORKBUDDY_CONSOLE_HOME/, '必须告诉用户可以改数据目录');
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

