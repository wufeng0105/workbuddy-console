/**
 * 锚点解析器 —— 铁律 3：路径 / 键 / 版本一律运行时探测，探测失败**硬报错**。
 *
 * 关键语义（易错，务必读）：
 *   **锚点保证的是「位置可确定」，不是「目标已存在」。**
 *   目标是否存在由把手的 probe 报告。
 *   否则：全新安装（SOUL.md 尚未创建）会被锚点层挡住，工具直接不可用。
 *
 * 锚点表是**数据**（按 WorkBuddy 版本一份），解析器是**框架**。
 * 升级时只加数据、不改本文件（演进契约）。
 *
 * 锚点条目三种形态：
 *   { dirGlob, file }  目录用 glob 定位（必须唯一命中），文件名固定 —— 文件可不存在
 *   { rel }            相对路径 —— 校验父目录存在；文件可不存在；kind=dir 时目标必须存在
 *   { glob, multi? }   通配定位 —— 默认必须唯一命中；optional 时允许缺席
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnchorMissingError } from './errors.mjs';
import { tildify } from './paths.mjs';

const ANCHORS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'anchors');

/** @param {string} s */
function escapeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * 支持单层 `*` 的路径模式解析（不做递归通配）。
 * @param {string} root
 * @param {string} pattern 相对 root，以 `/` 分隔，段内可用 `*`
 * @returns {string[]} 命中的绝对路径
 */
export function resolvePattern(root, pattern) {
  let candidates = [root];
  for (const seg of String(pattern).split('/').filter(Boolean)) {
    const next = [];
    for (const c of candidates) {
      if (!seg.includes('*')) {
        const p = path.join(c, seg);
        if (fs.existsSync(p)) next.push(p);
        continue;
      }
      let entries;
      try { entries = fs.readdirSync(c, { withFileTypes: true }); } catch { continue; }
      const rx = new RegExp(`^${seg.split('*').map(escapeRx).join('.*')}$`);
      for (const e of entries) if (rx.test(e.name)) next.push(path.join(c, e.name));
    }
    candidates = next;
    if (candidates.length === 0) break;
  }
  return candidates;
}

/** @param {string} a @param {string} b */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * 从本机运行时数据**探测** WorkBuddy 版本。
 * 依据：`plugins/cache/workbuddy-builtin/<plugin>/<版本>-wb.<build>.../` 的目录名。
 * @param {string} configRoot
 * @returns {string|null}
 */
export function detectVersion(configRoot) {
  const base = path.join(configRoot, 'plugins', 'cache', 'workbuddy-builtin');
  if (!fs.existsSync(base)) return null;
  const found = new Set();
  for (const plugin of fs.readdirSync(base, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    let versions;
    try { versions = fs.readdirSync(path.join(base, plugin.name)); } catch { continue; }
    for (const v of versions) {
      const m = /^(\d+\.\d+\.\d+)-/.exec(v);
      if (m) found.add(m[1]);
    }
  }
  if (found.size === 0) return null;
  return [...found].sort(compareVersions).at(-1) ?? null;
}

const ANCHOR_FILE_RE = /^workbuddy-(.+)\.json$/;

/** 本仓库已有的锚点表版本 */
export function listAnchorVersions() {
  if (!fs.existsSync(ANCHORS_DIR)) return [];
  return fs.readdirSync(ANCHORS_DIR)
    .map((f) => ANCHOR_FILE_RE.exec(f)?.[1])
    .filter(Boolean)
    .sort(compareVersions);
}

/**
 * 载入锚点表。
 * @param {string} version
 */
export function loadAnchorTable(version) {
  const file = path.join(ANCHORS_DIR, `workbuddy-${version}.json`);
  if (!fs.existsSync(file)) {
    throw new AnchorMissingError(
      `缺少 WorkBuddy ${version} 的锚点表 —— 请新增数据文件（不要改解析器）`,
      { version, expected: tildify(file), available: listAnchorVersions() },
    );
  }
  let table;
  try {
    table = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new AnchorMissingError(`锚点表无法解析：${tildify(file)}`, { version, cause: String(e) });
  }
  if (!table || typeof table !== 'object' || !table.anchors) {
    throw new AnchorMissingError(`锚点表结构非法（缺 anchors）：${tildify(file)}`, { version });
  }
  return { file, table };
}

/**
 * 创建解析器实例。
 * @param {{configRoot:string, version?:string}} opts
 */
export function createResolver({ configRoot, version }) {
  const resolvedVersion = version ?? detectVersion(configRoot);
  if (!resolvedVersion) {
    throw new AnchorMissingError(
      '无法探测 WorkBuddy 版本（插件缓存目录不存在或为空）—— 拒绝猜测',
      { configRoot: tildify(configRoot) },
    );
  }
  const { file, table } = loadAnchorTable(resolvedVersion);

  /**
   * 宽容解析：不抛错，返回状态（供 doctor / 体检使用）。
   * @param {string} key
   * @returns {{key:string, ok:boolean, kind:string, path:string|null, exists:boolean, optional:boolean, error:string|null}}
   */
  function tryResolve(key) {
    const base = { key, ok: false, kind: 'file', path: null, exists: false, optional: false, error: null };
    const entry = table.anchors[key];
    if (!entry) return { ...base, error: `锚点表中无此键` };

    const kind = entry.kind ?? 'file';
    const optional = entry.optional === true;
    const multi = entry.multi === true;
    const out = { ...base, kind, optional };

    try {
      let target = null;

      if (entry.dirGlob) {
        // 目录 glob 定位父目录（必须唯一命中）；文件本身可不存在
        const dirs = resolvePattern(configRoot, entry.dirGlob)
          .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
        if (dirs.length === 0) return { ...out, error: `父目录探测失败：${entry.dirGlob}` };
        if (dirs.length > 1 && !multi) {
          return { ...out, error: `父目录命中多个，拒绝猜测：${dirs.map(tildify).join(', ')}` };
        }
        target = entry.file ? path.join(dirs[0], entry.file) : dirs[0];
      } else if (entry.glob) {
        const hits = resolvePattern(configRoot, entry.glob);
        if (hits.length === 0) {
          if (optional) return { ...out, ok: true, path: null, exists: false, error: null };
          return { ...out, error: `锚点探测失败：${entry.glob}` };
        }
        if (hits.length > 1 && !multi) {
          return { ...out, error: `锚点命中多个，拒绝猜测：${hits.map(tildify).join(', ')}` };
        }
        target = hits[0];
      } else if (entry.rel) {
        target = path.join(configRoot, entry.rel);
        if (kind === 'dir') {
          // 目录本身就是锚点：必须存在
          if (!fs.existsSync(target)) return { ...out, error: `目录锚点不存在：${entry.rel}` };
        } else {
          // 文件锚点：只要求父目录可确定；文件可不存在（全新安装）
          const parent = path.dirname(target);
          if (!fs.existsSync(parent)) {
            if (optional) return { ...out, ok: true, path: target, exists: false };
            return { ...out, error: `父目录不存在：${tildify(parent)}` };
          }
        }
      } else {
        return { ...out, error: '锚点条目既无 dirGlob/glob 也无 rel' };
      }

      const exists = fs.existsSync(target);
      if (exists) {
        const st = fs.statSync(target);
        if (kind === 'dir' && !st.isDirectory()) return { ...out, path: target, error: '锚点要求目录，实际是文件' };
        if (kind === 'file' && !st.isFile()) return { ...out, path: target, error: '锚点要求文件，实际是目录' };
      }
      return { ...out, ok: true, path: target, exists };
    } catch (e) {
      return { ...out, error: String(e?.message ?? e) };
    }
  }

  /**
   * 严格解析：位置不可确定即抛 AnchorMissingError（写入路径必须用它）。
   * @param {string} key
   */
  function resolve(key) {
    const r = tryResolve(key);
    if (!r.ok) {
      throw new AnchorMissingError(
        `锚点无法确定：${key} —— ${r.error}`,
        { key, version: resolvedVersion, configRoot: tildify(configRoot) },
      );
    }
    return {
      key,
      kind: r.kind,
      path: r.path,
      exists: r.exists,
      optionalAbsent: r.optional && !r.path,
    };
  }

  /** 体检：表内全部锚点（缺席的可选锚点不算失败） */
  function probeAll() {
    return Object.keys(table.anchors).map((key) => {
      const r = tryResolve(key);
      return {
        key,
        ok: r.ok,
        optional: r.optional,
        exists: r.exists,
        path: r.path ? tildify(r.path) : null,
        error: r.error,
      };
    });
  }

  return { version: resolvedVersion, tableFile: file, table, configRoot, resolve, tryResolve, probeAll };
}
