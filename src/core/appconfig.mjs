/**
 * app-config.json 读取 —— 多个把手都要看它，抽到 Core 避免把手之间互相依赖。
 *
 * 存储真身（实证）：`~/.workbuddy/app/app-config.json → personalization.*`
 * `settings.json` 仅 legacy 兜底（appConfig 有值时永不读取）。
 */

import fs from 'node:fs';

/** toneStyle 枚举白名单。证据：authority-snapshot.js `Us = new Set([...])` */
export const TONE_STYLE_IDS = Object.freeze([
  'professional', 'friendly', 'straightforward', 'creative', 'efficient', 'sarcastic', 'socratic',
]);

/**
 * 解析 app-config.json；任何异常都返回 null（由调用方决定怎么报）
 * @param {any} ctx
 */
export function readAppConfig(ctx) {
  const anchor = ctx.resolveOptional?.('config.appConfig');
  if (!anchor || !anchor.exists) return null;
  try {
    return JSON.parse(fs.readFileSync(anchor.path, 'utf8'));
  } catch { return null; }
}

/**
 * 当前生效的回复风格档位。取不到就返回 null —— **不猜**。
 * @param {any} ctx
 * @returns {string|null}
 */
export function readActiveToneStyle(ctx) {
  const cfg = readAppConfig(ctx);
  const v = cfg?.personalization?.toneStyle;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return TONE_STYLE_IDS.includes(t) ? t : null;
}
