/**
 * 把手 · personalization.soul（人设设定 / SOUL.md）
 * 实现见 identity-file.mjs 的工厂 —— SOUL / USER / IDENTITY 三者同构。
 *
 * 模式可达性：**两种模式均注入**。
 */

import { createIdentityFileHandle, MAX_CHARS, truncateToInjectionLimit } from './identity-file.mjs';

export { MAX_CHARS, truncateToInjectionLimit };

export const soulHandle = createIdentityFileHandle({
  id: 'personalization.soul',
  title: '人设设定（SOUL.md）',
  anchorKey: 'personal.soul',
  modeAvailability: {
    normal: true,
    expert: true,
    note: 'SOUL.md 两种模式均注入；对比：IDENTITY.md 在专家模式下不注入',
  },
});

export default soulHandle;
