/**
 * 备份仓 —— 铁律 1：无备份不成写。
 *
 * 布局（在用户数据目录内，不在仓库内）：
 *   <storeRoot>/backups/<id>/manifest.json
 *   <storeRoot>/backups/<id>/files/<nn>-<basename>
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { backupsDir, stateDir, ensureDir, tildify } from './paths.mjs';
import { BackupMissingError, IntegrityError } from './errors.mjs';
import { writeFileAtomic, mapWriteError } from './atomic-write.mjs';

/** @param {Buffer|string} data */
export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** @param {Date} [d] */
function stampId(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return [
    d.getUTCFullYear(), p(d.getUTCMonth() + 1), p(d.getUTCDate()),
    'T', p(d.getUTCHours()), p(d.getUTCMinutes()), p(d.getUTCSeconds()),
    'Z-', crypto.randomBytes(3).toString('hex'),
  ].join('');
}

/**
 * 建立备份。
 * @param {{storeRoot:string, reason:string, entries:{key:string, absPath:string}[], actor?:string}} opts
 */
export function createBackup({ storeRoot, reason, entries, actor = 'cli' }) {
  const id = stampId();
  const dir = path.join(backupsDir(storeRoot), id);
  const filesDir = ensureDir(path.join(dir, 'files'));

  const recorded = entries.map((e, i) => {
    const exists = fs.existsSync(e.absPath);
    if (!exists) {
      return { key: e.key, absPath: e.absPath, existed: false, sha256: null, size: 0, stored: null };
    }
    const buf = fs.readFileSync(e.absPath);
    const name = `${String(i).padStart(2, '0')}-${path.basename(e.absPath)}`;
    fs.writeFileSync(path.join(filesDir, name), buf);
    return {
      key: e.key,
      absPath: e.absPath,
      existed: true,
      sha256: sha256(buf),
      size: buf.length,
      stored: `files/${name}`,
    };
  });

  const manifest = {
    schemaVersion: 1,
    id,
    createdAt: new Date().toISOString(),
    reason,
    actor,
    entries: recorded,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/**
 * @param {string} storeRoot
 * @param {string} id
 */
export function readManifest(storeRoot, id) {
  const f = path.join(backupsDir(storeRoot), id, 'manifest.json');
  if (!fs.existsSync(f)) throw new BackupMissingError(`找不到备份 ${id}`, { id });
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

/**
 * @param {string} storeRoot
 */
export function listBackups(storeRoot) {
  const d = backupsDir(storeRoot);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      try {
        const m = readManifest(storeRoot, e.name);
        return { id: m.id, createdAt: m.createdAt, reason: m.reason, entries: m.entries.length };
      } catch {
        return { id: e.name, createdAt: null, reason: '(manifest 损坏)', entries: 0 };
      }
    })
    .sort((a, b) => String(b.id).localeCompare(String(a.id)));
}

/**
 * 还原前副本的文件名：`key` 的 sha256 前 16 位。
 *
 * 与 `verify/readback.mjs` 的 `state/readback/<hash>.json` 同一套做法（同一算法、同一截断）：
 * 只要知道备份条目的 `key`，就能复算出文件名，不需要额外的映射表。
 * @param {string} key
 */
function preRestoreName(key) {
  return `${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16)}.bin`;
}

/**
 * 还原。先报漂移（当前值 vs 备份值），再回写。
 *
 * ⚠️ 两条硬要求（F2/F7，都是实测过的数据丢失）：
 *
 *   ① **删除或覆盖之前，先把目标当前的字节留一份副本**。
 *      曾经：对"备份时本不存在"的条目直接 `fs.rmSync(absPath, {force:true})`，
 *      删前不留任何副本 —— 实测删除后**全 store 递归搜不到被删内容的任何一个字节**，
 *      即"还原"把用户后来写的文件永久删掉了。现在每次删除/覆盖前把当前字节落到
 *      `<store>/state/restore-pre/<backupId>/<key 的 hash>.bin`，并写 `index.json` 供人按路径找回。
 *      （dryRun 不落任何东西——预演承诺"不写盘"。）
 *
 *   ② **逐条目 try/catch**：一条失败继续下一条，失败原样带回 `results`。
 *      曾经是裸循环：第二条 EISDIR 一抛，第一条已还原、后面全部不执行，
 *      调用方还拿不到"到底改了什么"（F7 实测：半还原 + 零台账）。
 *
 * @param {{storeRoot:string, id:string, dryRun?:boolean}} opts
 */
export function restoreBackup({ storeRoot, id, dryRun = false }) {
  const m = readManifest(storeRoot, id);
  const dir = path.join(backupsDir(storeRoot), id);
  const results = [];
  const saved = [];

  /** 还原前副本目录（懒创建：没东西要覆盖/删除时不留下空目录） */
  const preRoot = dryRun ? null : path.join(stateDir(storeRoot), 'restore-pre', id);
  let preDir = null;

  /**
   * 把"马上要被覆盖/删除的当前字节"存一份。
   * 存不下就让这一条失败（抛出 → 记为 error）—— 宁可不还原，也不无声删数据。
   * @param {string} key @param {string} absPath
   */
  function saveCurrent(key, absPath) {
    if (!preRoot) return;
    const st = fs.statSync(absPath);
    if (!st.isFile()) return;    // 目录不在这里造副本；删除它的那一步会自己失败（EISDIR）
    const buf = fs.readFileSync(absPath);
    preDir ??= ensureDir(preRoot);
    const file = preRestoreName(key);
    fs.writeFileSync(path.join(preDir, file), buf);
    saved.push({ key, absPath: tildify(absPath), file, bytes: buf.length, sha256: sha256(buf) });
  }

  for (const e of m.entries) {
    try {
      const currentExists = fs.existsSync(e.absPath);
      const currentSha = currentExists ? sha256(fs.readFileSync(e.absPath)) : null;

      if (!e.existed) {
        // 备份时本不存在 → 还原 = 删除后来创建的。**删前留副本**。
        const action = currentExists ? 'delete' : 'noop';
        if (!dryRun && currentExists) {
          saveCurrent(e.key, e.absPath);
          fs.rmSync(e.absPath, { force: true });
        }
        results.push({ key: e.key, absPath: tildify(e.absPath), action, ok: true, drift: currentExists });
        continue;
      }

      const storedPath = path.join(dir, e.stored);
      if (!fs.existsSync(storedPath)) {
        throw new IntegrityError(`备份文件缺失：${e.stored}`, { id, key: e.key });
      }
      const buf = fs.readFileSync(storedPath);
      const storedSha = sha256(buf);
      if (storedSha !== e.sha256) {
        throw new IntegrityError(`备份内容校验失败（sha256 不符）：${e.key}`, {
          id, key: e.key, expected: e.sha256, actual: storedSha,
        });
      }

      const drift = currentSha !== e.sha256;
      const action = drift ? 'restore' : 'noop';
      if (!dryRun && drift) {
        saveCurrent(e.key, e.absPath);       // **覆盖前留副本**
        ensureDir(path.dirname(e.absPath));
        // 原子写（R27）：还原写回同样是覆盖写；失败时目标必须是"还原前的原样"，
        // 不能是"被截断成 0 字节的半截文件"（那等于还原把文件弄丢了）
        writeFileAtomic(e.absPath, buf);
      }
      results.push({
        key: e.key,
        absPath: tildify(e.absPath),
        action,
        ok: true,
        drift,
        currentSha,
        manifestSha: e.sha256,
      });
    } catch (err) {
      // 逐条目容错：一条失败继续下一条，失败原样带回（供 engine 写 status:'partial'）
      //
      // ⚠️ 写失败的文案必须说清"文件现在是什么状态"（R28）：走原子写之后，
      //    「写入未发生，目标文件未被修改」是**事实**；这里与 CLI/HTTP 共用同一份映射，
      //    不再各自打一句裸 errno。非系统错误（如 ERR_FS_EISDIR）保持原样。
      const mapped = mapWriteError(err, { absPath: e.absPath });
      results.push({
        key: e.key,
        absPath: tildify(e.absPath),
        action: 'error',
        ok: false,
        error: mapped
          ? { code: mapped.code, message: mapped.message, hint: mapped.hint, errno: err?.code ?? null }
          : { code: err?.code ?? 'ERR', message: err?.message ?? String(err) },
      });
    }
  }

  // 还原前副本的索引：只按 key 的 hash 命名，人眼认不出是哪个文件，故附一份可读清单
  if (preDir && saved.length) {
    fs.writeFileSync(
      path.join(preDir, 'index.json'),
      `${JSON.stringify({ backupId: id, createdAt: new Date().toISOString(), entries: saved }, null, 2)}\n`,
      'utf8',
    );
  }

  const failed = results.filter((r) => !r.ok);
  return {
    id,
    dryRun,
    createdAt: m.createdAt,
    results,
    /** 全部条目成功 */
    ok: failed.length === 0,
    /** 部分成功（既不是全成也不是全败）—— 调用方据此写 status:'partial' */
    partial: failed.length > 0 && results.some((r) => r.ok),
    /** 还原前副本落点（dryRun 或没东西要备份时为 null），供界面/CLI 直接告诉用户"去哪找回" */
    savedDir: preDir ? tildify(preDir) : null,
    saved,
  };
}
