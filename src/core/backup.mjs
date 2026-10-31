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
import { backupsDir, ensureDir, tildify } from './paths.mjs';
import { BackupMissingError, IntegrityError } from './errors.mjs';

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
 * 还原。先报漂移（当前值 vs 备份值），再回写。
 * @param {{storeRoot:string, id:string, dryRun?:boolean}} opts
 */
export function restoreBackup({ storeRoot, id, dryRun = false }) {
  const m = readManifest(storeRoot, id);
  const dir = path.join(backupsDir(storeRoot), id);
  const results = [];

  for (const e of m.entries) {
    const currentExists = fs.existsSync(e.absPath);
    const currentSha = currentExists ? sha256(fs.readFileSync(e.absPath)) : null;

    if (!e.existed) {
      // 备份时本不存在 → 还原 = 删除后来创建的
      const action = currentExists ? 'delete' : 'noop';
      if (!dryRun && currentExists) fs.rmSync(e.absPath, { force: true });
      results.push({ key: e.key, absPath: tildify(e.absPath), action, drift: currentExists });
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
      ensureDir(path.dirname(e.absPath));
      fs.writeFileSync(e.absPath, buf);
    }
    results.push({
      key: e.key,
      absPath: tildify(e.absPath),
      action,
      drift,
      currentSha,
      manifestSha: e.sha256,
    });
  }

  return { id, dryRun, createdAt: m.createdAt, results };
}
