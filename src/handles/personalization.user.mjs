/**
 * 把手 · personalization.user（WorkBuddy 对你的称呼 / USER.md）
 *
 * 落盘证据：personalization.md E7-2 —— 称呼的唯一落点（`- **Name:**` 行）。
 * 注意：**整个文件**都会进 user-context，不止 Name 行。
 * 模式可达性：两种模式均注入。
 */

import { createIdentityFileHandle } from './identity-file.mjs';

export const userHandle = createIdentityFileHandle({
  id: 'personalization.user',
  title: 'WorkBuddy 对你的称呼（USER.md）',
  anchorKey: 'personal.user',
  modeAvailability: {
    normal: true,
    expert: true,
    note: 'USER.md 两种模式均注入；对比：IDENTITY.md 在专家模式下不注入',
  },
});

export default userHandle;
