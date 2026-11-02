/**
 * 路径解析 —— 所有"东西放哪"的答案都在这里，不散落。
 *
 * 铁律 4：用户数据一律放 %USERPROFILE%\.workbuddy-console\（本仓库是 public）。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * 本工具的私有数据目录（profiles / backups / state）。
 *
 * @param {string} [override] 命令行 `--store` 传入的目录。
 *   ⚠️ 曾经这个参数**不存在**：`cli.mjs` 的帮助里承诺了 `--store <dir>`，
 *   但代码里是裸调 `storeRoot()`，参数被静默丢弃（独立复核两路发现）。
 *   现在真的生效：显式参数 > 环境变量 > 默认值。
 */
export function storeRoot(override) {
  return override?.trim()
    || process.env.WORKBUDDY_CONSOLE_HOME?.trim()
    || path.join(os.homedir(), '.workbuddy-console');
}

/**
 * WorkBuddy 的配置根目录。
 * 可用 `--root` 或 `WORKBUDDY_CONFIG_DIR` 重定向（实验隔离用）。
 * @param {string} [override]
 */
export function configRoot(override) {
  return override?.trim()
    || process.env.WORKBUDDY_CONFIG_DIR?.trim()
    || path.join(os.homedir(), '.workbuddy');
}

export const STORE_SUBDIRS = Object.freeze({
  profiles: 'profiles',
  backups: 'backups',
  state: 'state',
});

/** @param {string} root */
export function backupsDir(root) { return path.join(root, STORE_SUBDIRS.backups); }
/** @param {string} root */
export function stateDir(root) { return path.join(root, STORE_SUBDIRS.state); }
/** @param {string} root */
export function profilesDir(root) { return path.join(root, STORE_SUBDIRS.profiles); }

/** @param {string} p */
export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/**
 * 把绝对路径缩写成 `~` 形式，用于界面与日志（不用于实际 IO）。
 * @param {string} p
 */
export function tildify(p) {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
