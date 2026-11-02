/**
 * 版本重放 —— 演进契约的执行细节（docs/framework.md 6.4）。
 *
 * 问题：WorkBuddy 升级后，一部分定制会被洗掉：
 *   - `style-*.md` 在安装目录 → 升级器整体替换该目录（**疑失效**，待实测 #6）
 *   - C 组 `prompt.tpl` 在**版本哈希目录**内 → 升级重建目录，旧路径直接消失
 *   - 用户目录的（SOUL / USER / IDENTITY / app-config）→ 存活，不用重放
 *
 * 解法 = 四步：
 *   1. **快照**  —— 把"标了 invalidated 的把手"的当前内容存成重放包
 *   2. **检测**  —— 升级后比对：内容还在吗？锚点还成立吗？
 *   3. **重放**  —— 把快照灌回去（一次事务、一次备份）
 *   4. **验证**  —— 复用各把手自己的验证策略
 *
 * 关键设计：**重放包是"内容 + 锚点键"，不是"绝对路径"**。
 *   因为升级后路径会变（build hash 换掉），存路径必然失效；存锚点键才能重新定位。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stateDir, ensureDir } from './paths.mjs';
import { writeFileAtomic } from './atomic-write.mjs';

export const BUNDLE_SCHEMA_VERSION = 1;

/** @param {string} storeRoot */
function bundleFile(storeRoot) {
  return path.join(stateDir(storeRoot), 'replay', 'bundle.json');
}

/** @param {string} s */
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

/**
 * 建重放包：只收 `upgradeBehavior === 'invalidated'` 的把手。
 * @param {{storeRoot:string, handles:object[], ctx:any, write:(p:string, s:string)=>void}} p
 */
export async function buildBundle({ storeRoot, handles, ctx }) {
  /** @type {Record<string, any>} */
  const entries = {};
  const skipped = [];

  for (const h of handles) {
    if (h.upgradeBehavior !== 'invalidated') {
      skipped.push({ id: h.id, reason: `upgradeBehavior=${h.upgradeBehavior}（不需要重放）` });
      continue;
    }
    let st;
    try {
      st = await h.probe(ctx);
    } catch (e) {
      skipped.push({ id: h.id, reason: `探测失败：${e.message}` });
      continue;
    }
    if (!st.exists) {
      skipped.push({ id: h.id, reason: '目标当前不存在（可能是全新安装或尚未生成）' });
      continue;
    }
    // 存**锚点键**而不是绝对路径：升级后路径会变，锚点键才能重新定位
    entries[h.id] = {
      anchor: h.target,
      /** 结构化手存放操作描述；文本手存放全文 */
      inputKind: h.inputKind ?? 'text',
      content: h.inputKind === 'rule-op' ? null : st.text,
      sha256: st.text ? sha256(st.text) : null,
      bytes: st.bytes ?? (st.text ? Buffer.byteLength(st.text, 'utf8') : 0),
      capturedAt: new Date().toISOString(),
      capturedFrom: st.path,
    };
  }

  const bundle = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    version: ctx.version,
    entries,
    skipped,
  };

  const file = bundleFile(storeRoot);
  ensureDir(path.dirname(file));
  // 统一到一处实现（曾经这里自带一份固定名 tmp+rename；固定名会在两个进程同时写时互踩）
  writeFileAtomic(file, `${JSON.stringify(bundle, null, 2)}\n`);

  return { bundle, file };
}

/** @param {string} storeRoot */
export function readBundle(storeRoot) {
  const file = bundleFile(storeRoot);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 检测：升级之后，哪些定制还在、哪些需要重放。
 * **只比对，不写盘。**
 * @param {{storeRoot:string, handles:object[], ctx:any}} p
 */
export async function detectDrift({ storeRoot, handles, ctx }) {
  const bundle = readBundle(storeRoot);
  if (!bundle) {
    return {
      ok: false,
      reason: '还没有重放包 —— 先运行 bundle 建一份',
      results: [],
      needReplay: [],
    };
  }

  const byId = new Map(handles.map((h) => [h.id, h]));
  const results = [];

  for (const [id, entry] of Object.entries(bundle.entries)) {
    const h = byId.get(id);
    if (!h) {
      results.push({ id, kind: 'handle-missing', severity: 'warn', detail: '该把手在当前版本已不存在，跳过' });
      continue;
    }
    /** @type {any} */
    let st;
    try {
      st = await h.probe(ctx);
    } catch (e) {
      results.push({
        id,
        kind: 'anchor-missing',
        severity: 'error',
        detail: `锚点失效：${e.message}`,
        hint: '升级后路径可能变了；本应通过锚点键重新定位 —— 若仍失败，说明锚点表需要更新',
      });
      continue;
    }

    if (!st.exists) {
      results.push({
        id, kind: 'target-missing', severity: 'error',
        detail: '目标文件不存在（升级可能清理了它）',
        anchorPath: st.path,
      });
      continue;
    }

    const nowText = st.text ?? '';
    const nowSha = nowText ? sha256(nowText) : null;
    if (nowSha === entry.sha256) {
      results.push({ id, kind: 'unchanged', severity: 'info', detail: '定制仍在，无需重放' });
      continue;
    }

    results.push({
      id,
      kind: 'vendor-restored',
      severity: 'warn',
      detail: '内容与快照不一致 —— 多半是升级替换了它',
      expectedSha: entry.sha256,
      actualSha: nowSha,
      anchorPath: st.path,
      /** 新旧路径不同 = 升级换了版本目录 */
      moved: entry.capturedFrom !== st.path,
    });
  }

  const needReplay = results
    .filter((r) => ['vendor-restored', 'target-missing', 'anchor-missing'].includes(r.kind))
    .map((r) => r.id);

  return {
    ok: true,
    bundleCreatedAt: bundle.createdAt,
    bundleVersion: bundle.version,
    currentVersion: ctx.version,
    versionChanged: bundle.version !== ctx.version,
    results,
    needReplay,
  };
}
