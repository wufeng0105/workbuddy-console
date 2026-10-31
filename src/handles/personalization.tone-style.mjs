/**
 * 把手 · personalization.tone-style（回复风格 / `app-config.json → personalization.toneStyle`）
 *
 * 关键机制（tone-styles.md）：
 *   取值是**七档枚举**；真正注入 `{{ ToneStyleContent }}` 的是 `style-<id>.md` 的**全文**。
 *   ⇒ 改取值 = 换掉整段风格文本，所以 token 增量 = 两个 style 文件的 token 差。
 *
 * 必须拦下的静默失败：
 *   `resolveToneStyle` 对非法枚举返回空串（`Us.has(t) ? t : ''`），
 *   于是"写成功了、风格却消失了、缓存也跟着废一次"。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createJsonFieldHandle } from './json-field.mjs';

/** toneStyle 枚举白名单。证据：authority-snapshot.js `Us = new Set([...])` */
export const TONE_STYLES = Object.freeze([
  'professional', 'friendly', 'straightforward', 'creative', 'efficient', 'sarcastic', 'socratic',
]);

const STYLE_ANCHOR = 'templates.style';

/**
 * 读某档 style 文件全文（= 真正注入的内容）。
 * 取不到就返回 null —— 不猜、不用空串冒充。
 * @param {any} ctx
 * @param {string} styleId
 */
export function readStyleContent(ctx, styleId) {
  if (typeof styleId !== 'string' || !/^[a-z]+$/.test(styleId)) return null;
  const anchor = typeof ctx.resolveOptional === 'function' ? ctx.resolveOptional(STYLE_ANCHOR) : null;
  if (!anchor) return null;
  try {
    return fs.readFileSync(path.join(anchor.path, `style-${styleId}.md`), 'utf8');
  } catch { return null; }
}

export const toneStyleHandle = createJsonFieldHandle({
  id: 'personalization.tone-style',
  title: '回复风格（toneStyle）',
  anchorKey: 'config.appConfig',
  containerKey: 'personalization',
  fieldKey: 'toneStyle',
  allowedValues: [...TONE_STYLES],
  /** 与 collector 的 `e.trim()` 对齐（否则带尾随换行的输入会被误拒） */
  normalize: (v) => (typeof v === 'string' ? v.trim() : v),
  injectedContent: (v, ctx) => readStyleContent(ctx, v),
  assertionNote: '增量 = 两个 `style-<id>.md` 的 token 差（换档位等于换整段风格文本）。',
  extraWarnings: async (v, ctx) => (
    readStyleContent(ctx, v) == null
      ? [`找不到 style-${v}.md —— 该取值下风格内容为空，注入会变成 0 tokens（可能是安装目录锚点未命中）`]
      : []
  ),
});

export default toneStyleHandle;
