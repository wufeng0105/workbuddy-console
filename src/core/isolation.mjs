/**
 * 隔离一致性检测（残余 R39）。
 *
 * 问题：`--root` 只换**配置**那棵树（`~/.workbuddy` 那一支）；**安装**那棵树
 * （`C:\Program Files\WorkBuddy\…\templates\style`）由 `WORKBUDDY_CONSOLE_INSTALL_DIR` **单独**决定。
 * 于是"只给 `--root`"的人会以为整套都隔离了，而 7 个 `style.*` 把手仍然指向**真实安装目录**
 * 且报 `writeAccess: true` —— 一旦走到 `apply style.* --confirm`，写的就是本机 Program Files 里的真文件。
 *
 * ⚠️ 判据**不是**"落点在不在配置根下"——厂商面按设计就住在独立的安装树里，那条判据永远为真，
 * 会把**正确隔离**也报成不一致（第一版就是这么错的，被 ③ 号用例抓出来）。
 * 真正的信号是：**它落在真实安装目录，而不是你指定的安装根**。
 *
 * 分寸：**不给 `--root` 时一个字都不提示** —— 那时写真实安装目录本来就是正确行为。
 */

import path from 'node:path';
import { tildify } from './paths.mjs';

/** 真实安装目录的环境变量名（与 `anchor.mjs:181` 同一份来源） */
export const INSTALL_DIR_ENV = 'WORKBUDDY_CONSOLE_INSTALL_DIR';

/** @returns {string|null} 用户指定的安装根（未设/空串 → null） */
export function requestedInstallRoot(env = process.env) {
  const v = env?.[INSTALL_DIR_ENV];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * 找出"哪棵树都不在"的厂商面把手。
 *
 * 合法落点有**两棵**树：配置根（`prompt.tpl` 在插件缓存里，属配置树）与安装根（7 个 `style-*.md`）。
 * 一个厂商面只要落在其中**任意一棵**里，就说明它被隔离住了；两棵都不在 ⇒ 它指向的是真实安装目录。
 *
 * @param {Array<{id:string, writeClass:string, anchorPath?:string|null}>} handles doctor 里的把手列表
 * @param {{configRoot:string, installRoot?:string|null}} opts
 * @returns {Array<{id:string, path:string, reason:'no-install-root'|'outside-both-roots'}>}
 */
export function findVendorEscapes(handles, { configRoot, installRoot = null } = {}) {
  const under = (child, base) => {
    if (!base || typeof child !== 'string') return false;
    const r = path.relative(base, child);
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  };
  const out = [];
  for (const h of handles ?? []) {
    if (h?.writeClass !== 'vendor-file') continue;
    const p = h.anchorPath;
    if (!p || typeof p !== 'string') continue;
    if (under(p, configRoot)) continue;              // 配置树内的厂商面（prompt.tpl）——合法
    if (installRoot && under(p, installRoot)) continue; // 你指定的安装根——合法
    out.push({ id: h.id, path: p, reason: installRoot ? 'outside-both-roots' : 'no-install-root' });
  }
  return out;
}

/**
 * 生成给用户看的警告；不需要警告时返回 `null`。
 *
 * 只在用户**显式给了 `--root`**（意图＝隔离）时才可能返回内容。
 *
 * @param {{escapes:Array<{id:string,path:string,reason:string}>, configRoot:string,
 *          installRoot?:string|null, requestedRoot?:string|null}} a
 * @returns {string[]|null}
 */
export function isolationWarning({ escapes, configRoot, installRoot = null, requestedRoot = null }) {
  if (!requestedRoot) return null;
  if (!escapes || escapes.length === 0) return null;
  const dirs = [...new Set(escapes.map((e) => path.dirname(e.path)))];
  const noRoot = escapes.some((e) => e.reason === 'no-install-root');
  const head = noRoot
    ? `⚠️  隔离不一致：你给了 --root，但厂商面（${escapes.length} 个）没有任何隔离开关，仍指向**真实安装目录**`
    : `⚠️  隔离不一致：这 ${escapes.length} 个厂商面两棵树都不在，落在了**真实安装目录**`;
  return [
    head,
    `     配置根（你指定的）   ${tildify(configRoot)}`,
    `     安装根（你指定的）   ${installRoot ? tildify(installRoot) : '（未设置 WORKBUDDY_CONSOLE_INSTALL_DIR）'}`,
    ...dirs.map((d, i) => `${i === 0 ? '     厂商面实际落点     ' : '                          '}${tildify(d)}`),
    `     涉及把手：${escapes.map((e) => e.id).join('、')}`,
    '     想真正隔离，除了 --root / --store，还必须设：',
    `       ${INSTALL_DIR_ENV}=<镜像安装根>   （并把 7 个 style-*.md 放进对应子目录）`,
    '     否则对这些把手执行 apply 时，写的是本机 Program Files 里的真文件。',
  ];
}