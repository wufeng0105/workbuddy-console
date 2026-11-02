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
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const LAUNCH = path.join(REPO, 'src', 'launch.mjs');
const CMD = path.join(REPO, 'start-console.cmd');

const readLaunch = () => fs.readFileSync(LAUNCH, 'utf8');

/* ══════════ 双击入口 ══════════ */

test('双击入口存在，且不依赖工作目录', () => {
  assert.ok(fs.existsSync(CMD), 'start-console.cmd 必须存在（用户双击的就是它）');
  const src = fs.readFileSync(CMD, 'utf8');
  assert.match(src, /cd \/d "%~dp0"/i, '必须切到脚本所在目录 —— 双击时 cwd 是桌面，不切会找不到 src/');
  assert.match(src, /node "src\\launch\.mjs"/i, '必须前台运行 launch.mjs（窗口存活 = 服务存活）');
});

test('双击入口只含 ASCII（cmd.exe 会毁掉非 ASCII 批处理）', () => {
  /**
   * 这是实测踩过的坑：最初写中文名的 .cmd 且正文含中文，
   * cmd.exe 在 GBK 代码页下把中文提示解析成了命令，报
   * `'重新双击本文件即可。' is not recognized as an internal or external command`。
   * 中文提示一律交给 Node 输出（UTF-8 不受影响）。
   */
  const buf = fs.readFileSync(CMD);
  const nonAscii = [...buf].filter((b) => b > 0x7f);
  assert.equal(nonAscii.length, 0, `start-console.cmd 不许含非 ASCII 字节（发现 ${nonAscii.length} 个）`);
});

test('双击入口检查 Node 与关键文件，缺了就明说', () => {
  const src = fs.readFileSync(CMD, 'utf8');
  assert.match(src, /where node/i, '必须检查 node 是否存在');
  assert.match(src, /if not exist "src\\launch\.mjs"/i, '必须检查 launch.mjs 是否存在');
  assert.match(src, /pause/i, '必须 pause，否则双击后窗口一闪而过看不到错');
});

/* ══════════ 启动器逻辑 ══════════ */

test('Node 版本门槛存在且是 20（与 package.json engines 一致）', () => {
  const src = readLaunch();
  const m = /MIN_NODE_MAJOR\s*=\s*(\d+)/.exec(src);
  assert.ok(m, '找不到 MIN_NODE_MAJOR');
  const engines = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).engines?.node ?? '';
  assert.match(engines, new RegExp(`>=\\s*${m[1]}`), `MIN_NODE_MAJOR=${m[1]} 必须与 package.json engines（${engines}）一致`);
});

test('--store / --root 必须真的透传给 startConsole（曾经 --store 是假参数）', () => {
  const src = readLaunch();
  const call = /startConsole\(\{([\s\S]*?)\}\)/.exec(src);
  assert.ok(call, '找不到 startConsole 调用');
  assert.match(call[1], /root:/, '必须传 root');
  assert.match(call[1], /store:/, '必须传 store（曾经帮助里承诺、代码里忽略）');
});

test('服务端 startConsole 必须接受 store 参数', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'server.mjs'), 'utf8');
  const sig = /export async function startConsole\(\{([^}]*)\}/.exec(src);
  assert.ok(sig, '找不到 startConsole 签名');
  assert.match(sig[1], /\bstore\b/, 'startConsole 的签名里必须有 store');
  assert.match(src, /resolveStoreRoot\(store\)/, '必须把 store 传给 resolveStoreRoot');
});

test('关窗口 = 服务停：必须监听 SIGINT / SIGTERM 并真的 close', () => {
  const src = readLaunch();
  assert.match(src, /process\.on\('SIGINT'/, '必须处理 Ctrl+C');
  assert.match(src, /process\.on\('SIGTERM'/, '必须处理 terminate');
  assert.match(src, /await app\.close\(\)/, 'shutdown 必须真的关掉 http server');
  assert.match(src, /process\.exit\(0\)/, 'shutdown 必须真的退出进程');
});

test('已在跑时复用而不是起第二个（否则两个令牌必然拧着用）', () => {
  const src = readLaunch();
  assert.match(src, /probeExisting/, '必须有"探测已有实例"的逻辑');
  assert.match(src, /AbortSignal\.timeout|signal:/, '探测必须有超时，不能卡在死链接上');
  assert.match(src, /no-reuse/, '必须留一个跳过复用的开关（排障用）');
});

test('WorkBuddy 在跑时必须先劝阻，且说清两类后果', () => {
  const src = readLaunch();
  assert.match(src, /app-must-be-closed|闸门/, '必须说明规则/模板会被闸门拒绝');
  assert.match(src, /isWorkBuddyRunning/, '必须真的探测进程，不能猜');
  assert.match(src, /'unknown'/, '探测不到要如实说"无法确认"，不许当成没运行');
});

test('启动失败时给可行动的提示，而不是只抛栈', () => {
  const src = readLaunch();
  assert.match(src, /EPERM\|EACCES/, '必须识别权限错误并给出提示（数据目录写不进去是实测踩过的坑）');
  assert.match(src, /WORKBUDDY_CONSOLE_HOME/, '必须告诉用户可以改数据目录');
});

test('不打开浏览器不能被说成"打开失败"', () => {
  /**
   * 曾经：`if (no-open !== true && openBrowser(url))` …… `else 打印失败`。
   * 用户传 --no-open 时走 else，输出「没能自动打开浏览器」——
   * 把自己的选择说成故障，排障时会被误导。
   */
  const src = readLaunch();
  const block = /f\['no-open'\] === true\) \{[\s\S]{0,160}?\}/.exec(src);
  assert.ok(block, '看不出对 --no-open 有单独分支');
  assert.match(block[0], /no-open/, '--no-open 必须有独立分支，不能落进"失败"文案');
});
