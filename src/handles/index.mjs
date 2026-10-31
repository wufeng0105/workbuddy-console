/**
 * 把手注册入口 —— 新增把手只改这里（加数据，不动 Core）。
 */

import { register } from '../core/registry.mjs';
import { soulHandle } from './personalization.soul.mjs';
import { userHandle } from './personalization.user.mjs';
import { identityHandle } from './personalization.identity.mjs';
import { toneStyleHandle } from './personalization.tone-style.mjs';
import { customPromptHandle } from './personalization.custom-prompt.mjs';
import { styleHandles } from './styles.mjs';

/** 全部把手（顺序即界面顺序） */
export const ALL_HANDLES = Object.freeze([
  soulHandle,
  userHandle,
  identityHandle,
  toneStyleHandle,
  customPromptHandle,
  ...styleHandles,
]);

let registered = false;

/** 幂等 */
export function registerAll() {
  if (registered) return ALL_HANDLES;
  for (const h of ALL_HANDLES) register(h);
  registered = true;
  return ALL_HANDLES;
}

/** 仅供测试重复注册 */
export function resetRegistrationFlag() {
  registered = false;
}
