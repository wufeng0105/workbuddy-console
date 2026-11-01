/**
 * 七档 style 内容把手 —— 一个档位一个把手（安装目录的厂商文件）。
 *
 * 中文名对应关系来自 `recon-baseline/findings/08-tone-styles.md`（七档映射表）。
 * 与 `personalization.tone-style`（**选哪一档**）区分：这里管的是**每档的内容**。
 */

import { createStyleContentHandle } from './style-file.mjs';

/** styleId → 中文 UI 名（与 WorkBuddy 设置页一致） */
export const STYLE_TITLES = Object.freeze({
  creative: '天马行空',
  efficient: '高效务实',
  friendly: '亲和友善',
  professional: '专业严谨',
  sarcastic: '毒舌吐槽',
  socratic: '启发引导',
  straightforward: '直言不讳',
});

export const styleHandles = Object.freeze(
  Object.entries(STYLE_TITLES).map(([styleId, zh]) => createStyleContentHandle({
    styleId,
    title: `风格内容 · ${zh}（style-${styleId}.md）`,
  })),
);

export default styleHandles;
