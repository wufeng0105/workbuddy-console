/**
 * C 组根模板把手（三个 welcomemode）—— 请求头部通道，按版本哈希定位。
 *
 * 为什么值得单独做：
 *   官方 `content_policy` 与 `personal_files_safety` 全文都在这里
 *   （实测：`welcomemode-{code,work,design}/<版本>/prompt.tpl`，共 6 个文件 = 三模式 × 双版本）。
 *   这是"越界审批自动同意"（P3）里**提示词面**的那一半。
 *
 * 通道：请求**头部** → 验证用标记法，不用 token-delta（见 docs/verification.md）。
 */

import { createPromptTemplateHandle } from './prompt-template.mjs';

/** 三个欢迎模式（每个模式一套提示词） */
export const WELCOME_MODES = Object.freeze(['code', 'work', 'design']);

export const promptTemplateHandles = Object.freeze(
  WELCOME_MODES.map((mode) => createPromptTemplateHandle({
    id: `prompt.welcomemode-${mode}`,
    title: `提示词模板 · ${mode} 模式（prompt.tpl）`,
    plugin: `welcomemode-${mode}`,
    fileName: 'prompt.tpl',
  })),
);

export default promptTemplateHandles;
