/**
 * 把手 · personalization.custom-prompt（给 WorkBuddy 的指令 / `app-config.json → personalization.customPrompt`）
 *
 * 注入链（实证）：`app-config.json → personalization.customPrompt`
 *   → PersonalizationCollector（日志 `Injected custom prompt (N chars)`）
 *   → 模板变量 `{{ UserCustomPrompt }}` → user-context 渲染产物 → 进请求尾段。
 * token 增量实证：4KB 标记 → +1151（见 recon-amendments 的记录：该数值基线出处有矛盾，判据以本机当次实测为准）。
 *
 * 注意与 `UserInstructionsContent` 区分：那是 **C 组根模板**的另一个变量，不是本字段。
 */

import { createJsonFieldHandle } from './json-field.mjs';

export const customPromptHandle = createJsonFieldHandle({
  id: 'personalization.custom-prompt',
  title: '给 WorkBuddy 的指令（customPrompt）',
  anchorKey: 'config.appConfig',
  containerKey: 'personalization',
  fieldKey: 'customPrompt',
  /** 注入的就是字段值本身 */
  injectedContent: (v) => (typeof v === 'string' ? v : ''),
  /**
   * 与 collector 的 `resolveCustomPrompt(e){ return e.trim() }` 对齐。
   * 注意：这也**如实反映**了 App 的真实行为——首尾空白本来就进不了请求。
   */
  normalize: (v) => (typeof v === 'string' ? v.trim() : v),
  assertionNote: '长度上限**未验证**（侦察期 4KB 实测通过；若模型端有截断，实测 Δ 会小于预期）。',
});

export default customPromptHandle;
