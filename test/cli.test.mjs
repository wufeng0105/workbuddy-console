/**
 * CLI 层断言（零依赖，`node --test`）。
 *
 * 为什么要单独一个文件：`src/selftest.mjs` 从不**执行** CLI 的 apply 路径
 * （它只用正则看 `cli.mjs` 的 serve 分支），而 `test/frontend.test.mjs` 只看 `web/app.js`
 * —— CLI 的**输出**这一面落在两套断言的接缝上，谁都不碰。
 *
 * 缺口由来（独立复核 reg01，`AGENTS.md` 自述"已修（无断言，靠 code review）"）：
 *   `src/cli.mjs` 的 apply noop 分支 `if (r.noop) { … return }` 改成恒假条件
 *   「`if (!r.changed === false)`」→ 自测 159/0 全绿，而用户在 noop 时会看到
 *   「✅ 已写入 personalization.soul / 备份 null」——**把"什么都没做"报成成功**，
 *   还给出一个不存在的备份 id。这正是本工具存在的理由（不许假装成功）在自己代码里失守。
 *
 * 本文件跑**真子进程**（不是读源码、不是字符串匹配）：同一段内容 apply 两次，
 * 第二次的输出必须说"无需改动"，且**任何**输出里都不许出现「备份 null」。
 *
 * 纪律：fixture 全在 `os.tmpdir()` 下（`mkdtemp`），并显式给子进程隔离
 * `WORKBUDDY_CONSOLE_HOME` / `WORKBUDDY_BASELINES_DIR` —— 不碰真实 `~/.workbuddy-console`
 * 与项目 `baselines/`。
 *
 * 运行：node --test test/cli.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const SOUL_TEXT = '# 人设\n\n- 称呼我：CLI 测试\n';
const NEXT_TEXT = `${SOUL_TEXT}- 追加：WBC-CLI-NOOP-001\n`;

/**
 * 造一个最小 WorkBuddy 配置 fixture（合成内容，不含真实用户文本）。
 * 锚点表要求的形态：`user-*-personal/`、`app/app-config.json`、
 * `plugins/cache/workbuddy-builtin/<plugin>/<版本>-wb.<build>/`、`settings.json`。
 */
function mkFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wbc-cli-test-'));
  const cfg = path.join(root, 'cfg');
  const store = path.join(root, 'store');
  const soul = path.join(cfg, 'user-1390000000-personal', 'SOUL.md');
  fs.mkdirSync(path.join(cfg, 'app'), { recursive: true });
  fs.mkdirSync(path.join(cfg, 'user-1390000000-personal'), { recursive: true });
  fs.mkdirSync(path.join(cfg, 'plugins', 'cache', 'workbuddy-builtin', 'welcomemode-code',
    '5.9.3-wb.clitest.g0000.h0000'), { recursive: true });
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'app', 'app-config.json'),
    JSON.stringify({ personalization: { toneStyle: 'efficient', customPrompt: '' } }, null, 2));
  fs.writeFileSync(path.join(cfg, 'settings.json'),
    JSON.stringify({ sandbox: { orderedRules: { file: { rules: [] } } } }, null, 2));
  fs.writeFileSync(soul, SOUL_TEXT, 'utf8');
  const nextFile = path.join(root, 'next.md');
  fs.writeFileSync(nextFile, NEXT_TEXT, 'utf8');
  return { root, cfg, store, soul, nextFile };
}

/** @param {string[]} args @param {Record<string,string>} env */
function runCli(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: path.dirname(CLI),
    env: { ...process.env, ...env },
    timeout: 120000,
  });
}

/** apply 的固定参数（同一内容反复用） */
function applyArgs(f, extra = []) {
  return ['apply', 'personalization.soul', '--set', f.nextFile, '--root', f.cfg, '--store', f.store, ...extra];
}

test('CLI apply：同一内容两次 → 第二次报"无需改动"，任何输出都不许出现「备份 null」', () => {
  const f = mkFixture();
  const env = {
    WORKBUDDY_CONSOLE_HOME: path.join(f.root, 'home'),
    WORKBUDDY_BASELINES_DIR: path.join(f.root, 'baselines'),
  };
  try {
    // 第一次：内容确实变了 → 真写入 + 真备份
    const first = runCli(applyArgs(f), env);
    const out1 = `${first.stdout ?? ''}${first.stderr ?? ''}`;
    assert.equal(first.status, 0, `第一次 apply 应成功（exit=${first.status}）：${out1}`);
    assert.match(out1, /已写入/, `第一次应报"已写入"：${out1}`);
    assert.doesNotMatch(out1, /备份 null/,
      `第一次是真写入，不许出现「备份 null」：${out1}`);
    assert.equal(fs.readFileSync(f.soul, 'utf8'), NEXT_TEXT, '第一次必须真的写进去');

    // 第二次：内容与现状一致 → noop 分支，必须说"无需改动"，且不许打印「备份 null」
    const second = runCli(applyArgs(f), env);
    const out2 = `${second.stdout ?? ''}${second.stderr ?? ''}`;
    assert.equal(second.status, 0, `noop 不该是非零退出（exit=${second.status}）：${out2}`);
    assert.doesNotMatch(out2, /备份 null/,
      'noop 时 backupId 是 null —— 打印「备份 null」就是把"什么都没做"报成成功（reg01 原状）：'
      + out2);
    assert.match(out2, /无需改动|未改动/,
      `第二次必须明确告诉用户"未做任何改动"：${out2}`);
    assert.doesNotMatch(out2, /✅ 已写入/, `noop 时不许打印"已写入"：${out2}`);

    assert.equal(fs.readFileSync(f.soul, 'utf8'), NEXT_TEXT, 'noop 不许改动文件');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('CLI apply --json：noop 的机器可读输出必须 noop:true / backupId:null / contentChanged:false', () => {
  const f = mkFixture();
  const env = {
    WORKBUDDY_CONSOLE_HOME: path.join(f.root, 'home'),
    WORKBUDDY_BASELINES_DIR: path.join(f.root, 'baselines'),
  };
  try {
    const first = runCli(applyArgs(f, ['--json']), env);
    assert.equal(first.status, 0, `第一次 apply --json 应成功：${first.stderr ?? ''}`);
    const j1 = JSON.parse(first.stdout);
    assert.ok(j1.backupId, '第一次应给出真实备份 id');
    assert.notEqual(j1.noop, true, '第一次不是 noop');

    const second = runCli(applyArgs(f, ['--json']), env);
    assert.equal(second.status, 0, `noop apply --json 应成功：${second.stderr ?? ''}`);
    const j2 = JSON.parse(second.stdout);
    assert.equal(j2.noop, true, `第二次必须报 noop:true（实际 ${JSON.stringify(j2.noop)}）`);
    assert.equal(j2.backupId, null, 'noop 时 backupId 必须是 null（脚本据此判断"没写"）');
    assert.equal(j2.contentChanged, false, 'noop 时 contentChanged 必须是 false');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
