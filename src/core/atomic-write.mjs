/**
 * 原子写 —— **一处实现，六处调用**（R27 / R28 的实现处）。
 *
 * 为什么必须存在（Lead 实测）：
 *   六处写盘用的是裸 `fs.writeFileSync(abs, data)`。它在写之前就**把目标截断成 0 字节**
 *   ——也就是说，真 ENOSPC 下目标的 42 B 原内容在抛错之前就已经没了，
 *   而用户从错误文案里读到的印象是"失败＝文件没变"。**事实相反**。
 *
 * 原子写的做法与参照物完全一致（`core/profiles.mjs:110-112`，注释写着「原子替换，避免半截文件」）：
 *   同目录建临时文件 → 写进临时文件 → `fs.renameSync` 覆盖目标。
 *   - 临时文件必须与目标**同目录**（同一卷才可能原子 rename；放 `os.tmpdir()` 会跨卷退化成复制）。
 *   - 任一步失败都删掉临时文件并原样抛出，**目标文件一个字节都不动**。
 *   - 目录不存在这类前置错误原样抛（由 `mapWriteError` 统一翻译）。
 *
 * ⚠️ 临时文件名是**唯一**的：`<目标>.<pid>.<8位随机>.tmp`。
 *
 *   曾经它是固定的 `<目标>.tmp`（照抄参照物）。同一进程内其实安全（write+rename 两行同步，
 *   Node 不会在里面插队），但**两个进程**同时写同一个目标就会互踩：
 *
 *     A: 写 tmp（完整）        B: 写 tmp（把 A 的内容截断重写）
 *     A: rename tmp → 目标     ← 目标拿到的是 **B 的内容**，而 A 报了成功（假成功）
 *     B: rename tmp → 目标     ← tmp 已被移走 → ENOENT → B 报失败
 *
 *   pid 隔离进程，随机后缀隔离同进程内的重复调用。**必须与目标同目录**不许变（同卷才能原子 rename）。
 *
 * ⚠️ 唯一名的代价是"崩溃残件不再被下次写自动覆盖"，所以写之前会 best-effort 清一遍
 *   **同一目标、同一命名模式、且 mtime 超过 `STALE_TMP_MS`** 的兄弟 `.tmp`（见 `sweepStaleTmpFor`）。
 *   绝不动 1 小时以内的 —— 那可能是另一个进程正在写的。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ConsoleError } from './errors.mjs';
import { tildify } from './paths.mjs';

/**
 * 原子写失败后**唯一为真**的那句话。
 *
 * 这句话能说出口，恰恰是因为走了 tmp+rename：写失败发生在临时文件上，
 * 目标文件从未被打开过。所以它不是安慰话，是可验证的事实（见 selftest 的三证断言）。
 */
export const WRITE_NOT_HAPPENED = '写入未发生，目标文件未被修改';

/**
 * 私有标记：这个异常来自**一次真的落盘尝试**。
 *
 * 只有带上它的错误才配说 `WRITE_NOT_HAPPENED` —— 探测失败、闸门拒绝、
 * 把手在写之前自己抛的错（如 STYLE_FILE_MISSING）都不算，不能跟着蹭这句话。
 */
const WRITE_ATTEMPT = Symbol.for('wbc.atomicWrite.attempted');

/**
 * 崩溃残件的判定阈值。
 *
 * 为什么是 1 小时：唯一名不会被下次写覆盖，所以要主动清；但**绝不能清掉正在写的**。
 * 一次原子写的窗口是毫秒级，1 小时是三个数量级以上的余量——宁可留下垃圾，
 * 也不误删另一个进程刚写好、正要 rename 的临时文件。
 */
export const STALE_TMP_MS = 60 * 60 * 1000;

/**
 * 临时文件路径：与目标**同目录**（同卷才能原子 rename），文件名**唯一**。
 *
 * 唯一性由两段保证：`process.pid` 隔离进程，4 字节随机隔离同进程内的重复调用。
 * 不许改成固定名——那会让两个进程同时写同一目标时互踩（见文件头的推演）。
 *
 * @param {string} absPath
 * @returns {string}
 */
export function tmpPathFor(absPath) {
  return `${absPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

/**
 * 这个名字是不是"某个目标的临时兄弟"。
 *
 * 严格匹配 `<basename>.<数字>.<8位十六进制>.tmp`，**只认我们自己造的**——
 * 清理与断言都靠它，松一点就可能误删用户的文件。
 *
 * @param {string} absPath 目标绝对路径
 * @param {string} name 同目录下的文件名（不是路径）
 * @returns {boolean}
 */
export function isTmpSiblingFor(absPath, name) {
  const base = path.basename(absPath);
  return new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.[0-9a-f]{8}\\.tmp$`).test(name);
}

/**
 * best-effort 清掉崩溃残件：同一目标、同一命名模式、且 mtime 早于 `maxAgeMs`。
 *
 * 三条纪律：**绝不抛错**（清不掉就跳过）、**绝不删不匹配模式的**、**绝不动阈值以内的**。
 *
 * @param {string} absPath
 * @param {{maxAgeMs?:number, now?:number}} [opts]
 * @returns {string[]} 被删掉的文件名（供断言；失败时为已删成功的那些）
 */
export function sweepStaleTmpFor(absPath, { maxAgeMs = STALE_TMP_MS, now = Date.now() } = {}) {
  const removed = [];
  let names;
  try { names = fs.readdirSync(path.dirname(absPath)); } catch { return removed; }
  for (const n of names) {
    if (!isTmpSiblingFor(absPath, n)) continue;
    const p = path.join(path.dirname(absPath), n);
    try {
      if (now - fs.statSync(p).mtimeMs < maxAgeMs) continue; // 可能是别人正在写的
      fs.rmSync(p, { force: true });
      removed.push(n);
    } catch { /* best-effort：清不掉不影响本次写 */ }
  }
  return removed;
}

/**
 * 原子写：写临时文件 → rename 覆盖目标。
 *
 * @param {string} absPath 目标绝对路径（目录必须已存在；不存在会以 ENOENT 原样抛）
 * @param {string|Buffer} data
 * @returns {{path:string, bytes:number, tmp:string}}
 */
export function writeFileAtomic(absPath, data) {
  // 先清崩溃残件（best-effort，绝不影响本次写）。唯一名的代价就是它。
  sweepStaleTmpFor(absPath);
  const tmp = tmpPathFor(absPath);
  try {
    fs.writeFileSync(tmp, data, typeof data === 'string' ? 'utf8' : undefined);
    fs.renameSync(tmp, absPath); // 原子替换，避免半截文件
    return {
      path: absPath,
      bytes: Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data), 'utf8'),
      tmp,
    };
  } catch (e) {
    if (e && typeof e === 'object') e[WRITE_ATTEMPT] = true;
    // 临时文件是本次写的垃圾；清不掉也不影响"目标没被改"这个事实，不覆盖真实错误
    try { fs.rmSync(tmp, { force: true }); } catch { /* 保持原异常 */ }
    throw e;
  }
}

/** @param {any} e 这个异常是不是一次真的落盘尝试失败 */
export function isWriteFailure(e) {
  return Boolean(e && typeof e === 'object' && e[WRITE_ATTEMPT] === true);
}

/**
 * 把写失败的 errno 翻译成**用户能据此行动**的错误（R28）。
 *
 * 这是**唯一一份** errno 映射：HTTP（`server.mjs`）与 CLI（`cli.mjs`）都调它，
 * 不再各留一份（曾经只有 `server.mjs` 有 `DISK_FULL`，CLI 直接打裸
 * `Error: ENOSPC …` + 栈，连"文件现在是什么状态"都不说）。
 *
 * 状态声明的纪律：**只有**真的发起过原子写的失败才带
 * 「写入未发生，目标文件未被修改」。读失败、探测失败不许蹭这句话。
 *
 * @param {any} e 原始异常
 * @param {{handle?:string, absPath?:string, backupId?:string|null}} [ctx]
 * @returns {{code:string, message:string, hint:string}|null} 不是系统错误时返回 null（调用方兜底 INTERNAL）
 */
export function mapWriteError(e, { handle, absPath, backupId = null } = {}) {
  const errno = String(e?.code ?? '');
  // 只认 POSIX errno 形态；ERR_INVALID_ARG_TYPE 这类内部码不该被包装成"能给用户看的结论"
  if (!/^E[A-Z]+$/.test(errno)) return null;

  // 目标路径优先用调用方给的（把手的锚点）：写失败时 `e.path` 指向的是**临时文件**，
  // 用户关心的是"哪个文件没被改"，不是我们内部的 .tmp 落在哪
  const p = String(absPath ?? (typeof e?.path === 'string' ? e.path : '') ?? '');
  const where = p ? `（${tildify(p)}）` : '';
  // ⚠️ 状态声明**只**给真的发起过原子写的失败：读失败、探测失败不许蹭这句话
  const state = isWriteFailure(e) ? `，${WRITE_NOT_HAPPENED}` : '';

  /** 让人能直接复制执行的下一句 */
  const backupLine = backupId
    ? `备份 id ${backupId} 可用于还原/比对（node src/cli.mjs restore ${backupId}）。`
    : '本次未建立备份。';
  const who = [handle ? `把手 ${handle}` : null, backupId ? `备份 ${backupId}` : null]
    .filter(Boolean).join('；');
  /** 统一的尾巴：where + who + backupLine，保证三样（路径/handle/备份）都在 */
  const tail = `${where}${state}。${who ? `${who}。` : ''}${backupLine}`;

  if (errno === 'ENOSPC') {
    return {
      code: 'DISK_FULL',
      message: `磁盘空间不足${tail}`,
      hint: '清理磁盘后重试。目标文件仍是写入前的原内容，无需恢复。',
    };
  }
  if (errno === 'EPERM' || errno === 'EACCES') {
    return {
      code: 'PERMISSION_DENIED',
      message: `该文件被占用或无权限${tail}`,
      hint: '目标可能在受保护目录（如 Program Files），或文件被 WorkBuddy / 安全软件占用。'
        + '厂商文件需要管理员权限；用户目录下的文件通常是 WorkBuddy 运行中锁住了。',
    };
  }
  if (errno === 'EBUSY' || errno === 'ETXTBSY') {
    return {
      code: 'FILE_BUSY',
      message: `文件被占用${tail}`,
      hint: '先退出 WorkBuddy 再试。',
    };
  }
  if (errno === 'ENOENT') {
    return {
      code: 'NOT_FOUND_PATH',
      message: `目标路径不存在${tail}`,
      hint: '锚点可能失效（WorkBuddy 升级换了目录）—— 去「守护」页看漂移。',
    };
  }
  // 其它 errno：保留原始 errno，但仍要加**同一句**状态声明（不许只说"写失败了"）
  // 原始报错文本进 hint —— 直接拼进 message 会把同一个路径说两遍
  return {
    code: errno,
    message: `写入失败（原始 errno ${errno}）${where}${state}。${who ? `${who}。` : ''}${backupLine}`,
    hint: `原始错误：${e?.message ?? String(e)}。这是未归类的系统错误，原始 errno 已保留；`
      + '目标文件未被修改，可重试。',
  };
}

/**
 * `mapWriteError` 的异常形态：抛这个，CLI 与 HTTP 两条腿都会自动说清文件状态。
 *
 * @param {any} e @param {{handle?:string, absPath?:string, backupId?:string|null}} [ctx]
 * @returns {ConsoleError} 带 `backupId` / `written:false` / `cause`
 */
export function writeFailureError(e, ctx = {}) {
  const d = mapWriteError(e, ctx) ?? {
    code: String(e?.code ?? 'WRITE_FAILED'),
    message: `写入失败：${e?.message ?? String(e)}`,
    hint: '目标文件未被修改，可重试。',
  };
  const err = new ConsoleError(d.code, d.message, {
    hint: d.hint,
    handle: ctx.handle ?? null,
    path: ctx.absPath ? tildify(ctx.absPath) : null,
    backupId: ctx.backupId ?? null,
    /** 事实：这次写没有发生（与「写已落盘但台账失败」的 written:true 相对） */
    written: false,
  });
  err.backupId = ctx.backupId ?? null;
  err.written = false;
  err.errno = e?.code ?? null;
  err.cause = e;
  return err;
}
