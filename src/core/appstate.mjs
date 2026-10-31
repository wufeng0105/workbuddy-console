/**
 * 宿主应用状态探测 —— 边界契约的"进程互斥闸门"要用。
 *
 * 诚实原则：探测不到就返回 'unknown'，**不要猜**，也不要假装知道。
 */

import { execFileSync } from 'node:child_process';

const IMAGE = 'WorkBuddy.exe';

/**
 * @returns {true|false|'unknown'}
 */
export function isWorkBuddyRunning() {
  if (process.platform !== 'win32') return 'unknown';
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${IMAGE}`, '/NH'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      // 沙箱可能禁止管道捕获 → 失败即降级为 unknown
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (/No tasks are running/i.test(out)) return false;
    return new RegExp(IMAGE.replace('.', '\\.'), 'i').test(out);
  } catch {
    return 'unknown';
  }
}
