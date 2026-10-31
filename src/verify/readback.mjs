/**
 * 验证策略 · 重启后回读（readback-after-restart）
 * ---------------------------------------------------------------
 * 适用：配置值 / 规则矩阵 —— 专治 `extraAllowWrite` 那类"启动被抹掉"。
 *
 * 为什么必须单独一条策略：
 *   写完立刻读回**永远是对的**（刚写的就是那份），所以"读回一致"证明不了任何事。
 *   真正的风险是：**WorkBuddy 启动时把值重置回默认**。
 *   证据：`reconcileDesktopExtraAllowWrite()` 就是这么干的（见 docs/recon-amendments.md 修正 3）。
 *
 * 因此本策略把验证拆成两个阶段：
 *   1. `after-write`  —— 写入后立即读回（证明"确实写进去了"）
 *   2. `after-restart` —— 重启 WorkBuddy 后再读回（证明"没被启动逻辑抹掉"）
 *
 * 三态：
 *   - 两阶段都一致 → effective
 *   - 阶段 2 不一致 → ineffective（**这才是 `extraAllowWrite` 那类坑的判据**）
 *   - 还没重启过 → undetermined，并明确告诉用户下一步做什么
 *
 * 状态存在 `<storeRoot>/state/readback/<key>.json`，因为"重启后再读"跨越了两次进程调用。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stateDir, ensureDir } from '../core/paths.mjs';

/** @param {string} storeRoot @param {string} key */
function statePath(storeRoot, key) {
  const h = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return path.join(stateDir(storeRoot), 'readback', `${h}.json`);
}

/**
 * 阶段 1：写入后登记"期望值"。
 * @param {{storeRoot:string, key:string, snapshot:any, meta?:any}} p
 */
export function recordAfterWrite({ storeRoot, key, snapshot, meta }) {
  const file = statePath(storeRoot, key);
  ensureDir(path.dirname(file));
  const rec = {
    key,
    recordedAt: new Date().toISOString(),
    fingerprint: fingerprintOf(snapshot),
    snapshot,
    meta: meta ?? {},
  };
  fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
  return rec;
}

/** @param {string} storeRoot @param {string} key */
export function readRecord(storeRoot, key) {
  const file = statePath(storeRoot, key);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** @param {any} v */
export function fingerprintOf(v) {
  return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
}

/**
 * 判定。
 * @param {{storeRoot:string, key:string, current:any, restarted?:boolean}} p
 */
export function evaluateReadback({ storeRoot, key, current, restarted }) {
  const rec = readRecord(storeRoot, key);
  if (!rec) {
    return {
      verdict: 'undetermined',
      reason: `还没有写入记录（${key}）—— 先改一次，再验证`,
      stage: 'no-record',
    };
  }

  const nowFp = fingerprintOf(current);
  if (nowFp !== rec.fingerprint) {
    return {
      verdict: 'ineffective',
      reason: `当前值与写入时**不一致** —— 改动已被还原或覆盖`,
      stage: restarted ? 'after-restart' : 'after-write',
      expected: rec.fingerprint,
      actual: nowFp,
      recordedAt: rec.recordedAt,
    };
  }

  if (!restarted) {
    return {
      verdict: 'undetermined',
      reason: `写入的值现在还在（阶段 1 通过），但**还没重启过 WorkBuddy** —— `
        + `必须先重启再读一次，才能证明它不会被启动逻辑抹掉。`
        + `（这正是 sandbox.extraAllowWrite 踩过的坑：启动时被强制重置）`,
      stage: 'after-write',
      recordedAt: rec.recordedAt,
      restarted: false,
    };
  }

  return {
    verdict: 'effective',
    reason: `重启之后值仍然保持 —— 没有被启动逻辑覆盖`,
    stage: 'after-restart',
    recordedAt: rec.recordedAt,
    restarted: true,
  };
}

export const readbackStrategy = Object.freeze({
  id: 'readback-after-restart',
  channels: Object.freeze(['config-value', 'rule-matrix']),
  recordAfterWrite,
  evaluateReadback,
});
