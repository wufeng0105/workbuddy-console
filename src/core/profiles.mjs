/**
 * 专家档位（profile）—— N 套「人设 + 表达方式 + 指令」组合，一键切换。
 *
 * 产品依据（docs/product.md 专家档位模型）：
 *   一个"专家" = `SOUL.md`（身份立场）+ `style-*.md`（表达方式）+ `toneStyle`（档位指针）。
 *   官方 UI 只能有一个人设 + 七个固定档位；工具可以存 N 套并切换。
 *
 * 存储位置（铁律 4）：`%USERPROFILE%\.workbuddy-console\profiles\<id>.json`
 *   **不进仓库**——档位里是用户的私人文本。
 *
 * 语义要点：
 *   - 档位是**源状态**（source state）；切换 = 把源状态写回 WorkBuddy（target state）。
 *     这正是 chezmoi 模型（docs/framework.md 参照系选型）。
 *   - 一次切换是**单一用户意图**，因此：一次备份覆盖全部目标、一次审计、一个期望增量。
 */

import fs from 'node:fs';
import path from 'node:path';
import { profilesDir, ensureDir } from './paths.mjs';
import { ConsoleError } from './errors.mjs';
import { writeFileAtomic } from './atomic-write.mjs';

export const PROFILE_SCHEMA_VERSION = 1;

/** 一个档位默认覆盖的把手（顺序即界面顺序） */
export const PROFILE_HANDLES = Object.freeze([
  'personalization.soul',
  'personalization.tone-style',
  'personalization.custom-prompt',
]);

/**
 * 名称 → 稳定 id（保留中文，其余非字母数字折叠成 `-`）
 * @param {string} name
 */
export function slugify(name) {
  const s = String(name).trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return s || `profile-${Date.now()}`;
}

/** @param {string} storeRoot @param {string} id */
export function profileFile(storeRoot, id) {
  return path.join(profilesDir(storeRoot), `${id}.json`);
}

/** @param {object} profile */
function assertProfile(profile) {
  const fail = (m) => { throw new ConsoleError('PROFILE_INVALID', `档位结构非法：${m}`); };
  if (!profile || typeof profile !== 'object') fail('不是对象');
  if (typeof profile.id !== 'string' || !profile.id.trim()) fail('缺 id');
  if (typeof profile.name !== 'string' || !profile.name.trim()) fail('缺 name');
  if (!profile.values || typeof profile.values !== 'object' || Array.isArray(profile.values)) fail('缺 values');
  for (const [k, v] of Object.entries(profile.values)) {
    if (typeof k !== 'string' || !k.trim()) fail('values 里有空键');
    if (typeof v !== 'string') fail(`values["${k}"] 必须是字符串（当前 ${typeof v}）`);
  }
  return profile;
}

/** @param {string} storeRoot @param {string} id */
export function readProfile(storeRoot, id) {
  const f = profileFile(storeRoot, id);
  if (!fs.existsSync(f)) {
    throw new ConsoleError('PROFILE_MISSING', `档位不存在：${id}`, { id, dir: profilesDir(storeRoot) });
  }
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
    throw new ConsoleError('PROFILE_INVALID', `档位文件无法解析：${id}`, { id, cause: String(e) });
  }
  return assertProfile(parsed);
}

/** @param {string} storeRoot */
export function listProfiles(storeRoot) {
  const dir = profilesDir(storeRoot);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() && !e.name.endsWith('.json')) continue;
    if (!e.name.endsWith('.json')) continue;
    const id = e.name.slice(0, -'.json'.length);
    try {
      const p = readProfile(storeRoot, id);
      out.push({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt ?? null,
        updatedAt: p.updatedAt ?? null,
        covers: Object.keys(p.values),
        bytes: fs.statSync(profileFile(storeRoot, id)).size,
      });
    } catch (err) {
      out.push({ id, name: `(损坏) ${err.message}`, createdAt: null, covers: [], bytes: 0, broken: true });
    }
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
}

/** @param {string} storeRoot @param {object} profile */
export function writeProfile(storeRoot, profile) {
  const p = assertProfile({
    schemaVersion: PROFILE_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    ...profile,
    updatedAt: new Date().toISOString(),
  });
  const dir = ensureDir(profilesDir(storeRoot));
  const target = path.join(dir, `${p.id}.json`);
  // 统一到一处实现（曾经这里自带一份固定名 tmp+rename；固定名会在两个进程同时写时互踩）
  writeFileAtomic(target, `${JSON.stringify(p, null, 2)}\n`);
  return p;
}

/** @param {string} storeRoot @param {string} id */
export function deleteProfile(storeRoot, id) {
  const f = profileFile(storeRoot, id);
  if (!fs.existsSync(f)) throw new ConsoleError('PROFILE_MISSING', `档位不存在：${id}`, { id });
  fs.rmSync(f, { force: true });
  return { id, deleted: true };
}
