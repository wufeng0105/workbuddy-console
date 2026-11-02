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

/**
 * 注入一次**可复现的写失败**：把目标文件设为**只读**。
 *
 * 换姿势的原因：临时名现在是唯一的（`<目标>.<pid>.<8位随机>.tmp`），
 * 以前"把 `<目标>.tmp` 占成一个目录"的注入法已经失效。
 * 只读目标让 `rename` 覆盖报 `EPERM`（Windows 实测），目标字节保持原样 ——
 * 与真 ENOSPC 落在**同一支**（tmp 写成功之后那一步）。
 * 「tmp 写就失败」是另一支，由 `src/selftest.mjs` 的 W10 覆盖。
 * @param {string} absPath
 */
function injectWriteFailure(absPath) {
  fs.chmodSync(absPath, 0o444);
  return absPath;
}
/** @param {string} absPath */
function clearInjectedWriteFailure(absPath) {
  try { fs.chmodSync(absPath, 0o666); } catch { /* 文件可能已被删 */ }
}

test('CLI apply：写盘失败 → 非零退出，文案说清"写入未发生"并给 backupId/恢复命令，文件逐字节不变', () => {
  /**
   * R27/R28 的用户面。缺陷态（Lead 实测）：
   *   ① 裸 `fs.writeFileSync` 先截断再写 → 真 ENOSPC 下 SOUL.md 42 B → 0 B；
   *   ② CLI 只打裸 `Error: ENOSPC …` + 栈（含本机绝对路径），**不说文件现在是什么状态**、
   *      不给 backupId、不给恢复命令 —— 用户会以为"失败＝文件没变"，而事实相反。
   */
  const f = mkFixture();
  const env = {
    WORKBUDDY_CONSOLE_HOME: path.join(f.root, 'home'),
    WORKBUDDY_BASELINES_DIR: path.join(f.root, 'baselines'),
  };
  try {
    const before = fs.readFileSync(f.soul);
    const tmp = injectWriteFailure(f.soul);
    let r;
    try {
      r = runCli(applyArgs(f), env);
    } finally {
      clearInjectedWriteFailure(tmp);
    }
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

    assert.notEqual(r.status, 0, `写失败必须非零退出（实际 ${r.status}）：${out}`);
    assert.match(out, /写入未发生，目标文件未被修改/,
      `文案必须敢说"写入未发生，目标文件未被修改"（原子写之后这是事实）：${out}`);
    assert.match(out, /personalization\.soul/, `文案必须带 handle id：${out}`);
    const backup = /备份 id ([0-9A-Za-z:\-]+)/.exec(out) ?? /备份 ([0-9A-Za-z:\-]+)/.exec(out);
    assert.ok(backup, `文案必须带 backupId（用户要知道去哪还原）：${out}`);
    assert.match(out, new RegExp(`restore ${backup[1]}`),
      `必须给出可直接复制的恢复命令：${out}`);
    assert.doesNotMatch(out, /✅ 已写入/, `失败时绝不许打印"已写入"：${out}`);
    assert.doesNotMatch(out, /\n\s+at [\w.$]+ \(/,
      `不许把裸堆栈丢给用户（曾经就是它掩盖了"文件已被截断"这件事）：${out}`);
    assert.ok(before.equals(fs.readFileSync(f.soul)),
      '写失败后目标文件必须逐字节不变（缺陷态是被截成 0 字节）');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('CLI restore：还原写回失败 → 该条目说清文件状态，目标不被截断成半截文件', () => {
  /**
   * 第七处写出点（`core/backup.mjs` 的 restore 写回）。缺陷态：裸 writeFileSync 先截断 ——
   * "还原"在半途失败会把用户**当前**的内容清成 0 字节，比不还原更糟。
   */
  const f = mkFixture();
  const env = {
    WORKBUDDY_CONSOLE_HOME: path.join(f.root, 'home'),
    WORKBUDDY_BASELINES_DIR: path.join(f.root, 'baselines'),
  };
  try {
    // 先真写一次，拿到一份覆盖 SOUL.md 的备份
    const first = runCli(applyArgs(f), env);
    assert.equal(first.status, 0, `前提：第一次 apply 应成功：${first.stderr ?? ''}`);
    const id = /备份 ([0-9A-Za-z:\-]+)/.exec(first.stdout)?.[1];
    assert.ok(id, `前提：必须拿到备份 id：${first.stdout}`);

    // 备份之后再漂移一次 → 还原一定会尝试写回
    const drifted = `${NEXT_TEXT}- 漂移：WBC-CLI-RESTORE-ATOMIC-001\n`;
    fs.writeFileSync(f.soul, drifted, 'utf8');

    const tmp = injectWriteFailure(f.soul);
    let r;
    try {
      r = runCli(['restore', id, '--confirm', '--root', f.cfg, '--store', f.store], env);
    } finally {
      clearInjectedWriteFailure(tmp);
    }
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

    assert.notEqual(r.status, 0, `还原失败必须非零退出（实际 ${r.status}）：${out}`);
    assert.match(out, /写入未发生，目标文件未被修改/,
      `条目错误必须说清"文件现在是什么状态"：${out}`);
    assert.match(out, /status=failed|部分失败|还原失败/, `必须如实报失败：${out}`);
    assert.equal(fs.readFileSync(f.soul, 'utf8'), drifted,
      '写回失败时目标必须是"还原前的原样"，绝不许是被截断的半截文件');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
