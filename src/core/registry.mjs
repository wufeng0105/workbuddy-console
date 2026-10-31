/**
 * 把手注册表 —— 注册即校验（铁律 2：未声明验证策略的把手不允许上线）。
 */

import { assertHandle } from './contracts.mjs';
import { HandleContractError } from './errors.mjs';

/** @type {Map<string, object>} */
const handles = new Map();

/**
 * @param {object} handle
 */
export function register(handle) {
  assertHandle(handle); // 契约不过即抛错
  if (handles.has(handle.id)) {
    throw new HandleContractError(`把手 id 重复：${handle.id}`, { id: handle.id });
  }
  handles.set(handle.id, handle);
  return handle;
}

/** @param {string} id */
export function get(id) {
  const h = handles.get(id);
  if (!h) throw new HandleContractError(`未注册的把手：${id}`, { id, known: [...handles.keys()] });
  return h;
}

export function list() {
  return [...handles.values()];
}

/** 仅供测试 */
export function clear() {
  handles.clear();
}
