/**
 * 把手 · personalization.identity（WorkBuddy 的名字 / IDENTITY.md）
 *
 * ⚠️ **模式相关可达性**（docs/recon-amendments.md 新增约束 2）：
 *   `isExpert === true` 时 IDENTITY.md **不读、不注入**。
 *   证据：`authority-snapshot.js:184` → `t.isExpert || c.push(this.readFileIfExists(a))`
 *                            → `t.isExpert || (e.IdentityPath=a, e.IdentityContent=…)`
 *   后果：切到专家档位时"名字"**静默消失**。
 */

import { createIdentityFileHandle } from './identity-file.mjs';

export const identityHandle = createIdentityFileHandle({
  id: 'personalization.identity',
  title: 'WorkBuddy 的名字（IDENTITY.md）',
  anchorKey: 'personal.identity',
  modeAvailability: {
    normal: true,
    expert: false,
    note: '⚠️ IDENTITY.md 在**专家模式下不注入**（切档位时"名字"静默消失）；'
      + '证据：authority-snapshot.js:184 `t.isExpert || …`',
  },
});

export default identityHandle;
