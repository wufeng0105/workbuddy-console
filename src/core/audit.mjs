/**
 * 审计台账 —— 每次写入都要留痕（边界契约）。
 * 追加式 JSONL；不覆盖、不改写。
 */

import fs from 'node:fs';
import path from 'node:path';
import { stateDir, ensureDir } from './paths.mjs';

/** @param {string} storeRoot */
export function auditFile(storeRoot) {
  return path.join(stateDir(storeRoot), 'audit.jsonl');
}

/**
 * @param {string} storeRoot
 * @param {object} record
 */
export function appendAudit(storeRoot, record) {
  ensureDir(stateDir(storeRoot));
  const line = JSON.stringify({ at: new Date().toISOString(), ...record });
  fs.appendFileSync(auditFile(storeRoot), `${line}\n`, 'utf8');
  return line;
}

/**
 * 读取台账（最新在后）。
 * @param {string} storeRoot
 * @param {{limit?:number}} [opts]
 */
export function readAudit(storeRoot, opts = {}) {
  const f = auditFile(storeRoot);
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  const parsed = [];
  for (const l of lines) {
    try { parsed.push(JSON.parse(l)); } catch { /* 坏行跳过，不掩盖 */ }
  }
  const limit = opts.limit ?? parsed.length;
  return parsed.slice(-limit);
}
