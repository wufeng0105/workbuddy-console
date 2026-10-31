/**
 * 执行引擎 —— plan → apply → verify → audit 的唯一入口。
 *
 * 设计要点：
 *   - 前端/CLI 都只通过本引擎动作，**不直接碰文件系统**
 *   - apply 前必然先备份（铁律 1），无需调用方记得
 *   - 闸门未满足时**拒绝执行**，而不是"写了不生效"（边界契约）
 */

import fs from 'node:fs';
import { createResolver } from './anchor.mjs';
import { createBackup, restoreBackup, listBackups } from './backup.mjs';
import { appendAudit, readAudit } from './audit.mjs';
import { diffLines, renderDiff } from './diff.mjs';
import { estimateCost } from './tokens.mjs';
import { ConfirmationRequiredError, GateBlockedError } from './errors.mjs';
import * as registry from './registry.mjs';
import { isWorkBuddyRunning } from './appstate.mjs';
import { autoCapture } from '../verify/auto-capture.mjs';
import { tildify } from './paths.mjs';

/** @param {object} h */
function meta(h) {
  return {
    id: h.id,
    title: h.title,
    target: h.target,
    writeClass: h.writeClass,
    privilege: h.privilege,
    channel: h.channel,
    upgradeBehavior: h.upgradeBehavior,
    gate: h.gate ?? 'none',
    verification: h.verification,
  };
}

/**
 * @param {{configRoot:string, storeRoot:string, version?:string, actor?:string, sessionStartOf?:Function}} opts
 */
export function createEngine({ configRoot, storeRoot, version, actor = 'cli', sessionStartOf }) {
  const resolver = createResolver({ configRoot, version });
  const ctx = {
    configRoot,
    storeRoot,
    version: resolver.version,
    resolve: resolver.resolve,
    isWorkBuddyRunning,
  };

  /** 边界契约 · 进程互斥闸门 */
  function gateCheck(handle) {
    const kind = handle.gate ?? 'none';
    const g = { kind, blocked: false, reason: null, warnings: [] };
    if (kind === 'app-must-be-closed') {
      const r = isWorkBuddyRunning();
      if (r === true) {
        g.blocked = true;
        g.reason = 'WorkBuddy 正在运行：该把手要求在应用退出后写入（拒绝执行，而不是写了不生效）';
      } else if (r === 'unknown') {
        g.warnings.push('无法确认 WorkBuddy 是否在运行（进程探测不可用）—— 请自行确认');
      }
    } else if (kind === 'new-session-required') {
      g.warnings.push('该改动需在 WorkBuddy 中**新建会话**后生效（当前会话不受影响）');
    }
    return g;
  }

  // ── 1. 探测 ────────────────────────────────────────────────
  async function probe(id) {
    const h = registry.get(id);
    return { handle: meta(h), state: await h.probe(ctx) };
  }

  // ── 预览 + 计划 ────────────────────────────────────────────
  async function plan(id, { next = '' } = {}) {
    const h = registry.get(id);
    const state = await h.probe(ctx);
    const anchor = resolver.resolve(h.target);

    const preview = typeof h.preview === 'function'
      ? await h.preview(ctx, { next })
      : (() => {
        const diff = diffLines(state.text ?? '', next);
        return { diff, diffText: renderDiff(diff), cost: estimateCost({ before: state.text ?? '', after: next }) };
      })();

    return {
      handle: meta(h),
      anchor: { key: h.target, path: tildify(anchor.path) },
      current: {
        exists: state.exists,
        bytes: state.bytes,
        sha256: state.sha256,
        tokens: state.tokens?.tokens ?? null,
      },
      preview,
      needsConfirm: h.writeClass === 'vendor-file',
      gate: gateCheck(h),
    };
  }

  // ── 4. 写入（备份先行，铁律 1）──────────────────────────────
  async function apply(id, { next = '', confirm = false, reason } = {}) {
    const h = registry.get(id);

    const g = gateCheck(h);
    if (g.blocked) throw new GateBlockedError(g.reason, { handle: h.id, gate: g.kind });
    if (h.writeClass === 'vendor-file' && !confirm) {
      throw new ConfirmationRequiredError(
        `把手 ${h.id} 写入的是厂商文件，需显式确认（--confirm）`,
        { handle: h.id, target: h.target },
      );
    }

    const anchor = resolver.resolve(h.target);
    const before = fs.existsSync(anchor.path) ? fs.readFileSync(anchor.path, 'utf8') : '';

    // 期望增量按**截断后**文本计算（把手自己知道注入上限），落进台账供 verify 自动对照
    let expectedDeltaTokens = null;
    if (typeof h.preview === 'function') {
      try {
        expectedDeltaTokens = (await h.preview(ctx, { next })).expectedDeltaTokens ?? null;
      } catch { /* 预览失败不阻断写入（写入本身仍有备份兜底） */ }
    }

    const manifest = createBackup({
      storeRoot,
      actor,
      reason: reason ?? `apply ${h.id}`,
      entries: [{ key: h.target, absPath: anchor.path }],
    });

    const written = await h.apply(ctx, { next });
    const after = fs.existsSync(anchor.path) ? fs.readFileSync(anchor.path, 'utf8') : '';

    appendAudit(storeRoot, {
      event: 'apply',
      handle: h.id,
      anchor: h.target,
      path: tildify(anchor.path),
      backupId: manifest.id,
      bytesBefore: Buffer.byteLength(before, 'utf8'),
      bytesAfter: Buffer.byteLength(after, 'utf8'),
      expectedDeltaTokens,
      gateKind: g.kind,
      actor,
    });

    return { handle: h.id, backupId: manifest.id, written, gate: g, verification: h.verification, expectedDeltaTokens };
  }

  // ── 5. 验证（三态，原样透传，不粉饰）────────────────────────
  async function verify(id, args = {}) {
    const h = registry.get(id);

    const manual = Number.isFinite(args.baselineTokens)
      || Number.isFinite(args.observedTokens)
      || Number.isFinite(args.expectedDelta);

    /** @type {any} */
    let effective = args;
    let capture = null;

    if (!manual) {
      // 自动对照：用台账里的 apply 时间戳 + trace 里的 prompt_tokens
      const lastApply = readAudit(storeRoot)
        .filter((r) => r.event === 'apply' && r.handle === id)
        .at(-1);

      if (!lastApply) {
        capture = { blockedReason: '这个把手还没有 apply 记录 —— 先改一次，再验证', warnings: [] };
      } else {
        const applyAtMs = Date.parse(lastApply.at);
        capture = autoCapture({
          configRoot,
          applyAtMs: Number.isFinite(applyAtMs) ? applyAtMs : Date.now(),
          expectedDelta: lastApply.expectedDeltaTokens ?? undefined,
          sessionStartOf,
        });
      }

      if (capture.blockedReason) {
        const res = {
          verdict: 'undetermined',
          reason: capture.blockedReason,
          handle: id,
          warnings: capture.warnings ?? [],
          capture,
        };
        appendAudit(storeRoot, { event: 'verify', handle: id, verdict: res.verdict, reason: res.reason, actor });
        return res;
      }
      effective = {
        ...args,
        baselineTokens: capture.baselineTokens,
        observedTokens: capture.observedTokens,
        expectedDelta: capture.expectedDelta,
      };
    }

    const res = await h.verify(ctx, effective);
    const merged = {
      ...res,
      ...(capture ? { capture, evidence: capture.evidence, warnings: [...(res.warnings ?? []), ...(capture.warnings ?? [])] } : {}),
    };

    // 说明：**会话归属**已在 auto-capture 层把关 ——
    // 「会话起点早于改动时间」的会话会被整个排除出观测池，因此不会产生
    // "旧会话没变 → 误判为未生效"的假阴性。见 docs/verification.md 自动对照流程。

    appendAudit(storeRoot, {
      event: 'verify',
      handle: h.id,
      verdict: merged.verdict,
      reason: merged.reason,
      auto: !manual,
      actor,
    });
    return merged;
  }

  // ── 6. 还原 ────────────────────────────────────────────────
  function restore(backupId, { dryRun = false } = {}) {
    const r = restoreBackup({ storeRoot, id: backupId, dryRun });
    const changed = r.results.filter((x) => x.action !== 'noop');
    appendAudit(storeRoot, { event: 'restore', backupId, dryRun, changed: changed.length, actor });
    return { ...r, changed };
  }

  function backups() { return listBackups(storeRoot); }
  function audit(limit) { return readAudit(storeRoot, { limit }); }

  /** 体检：锚点是否成立 + 把手契约是否满足 */
  function doctor() {
    const anchors = resolver.probeAll();
    const handles = registry.list().map((h) => {
      const entry = { ...meta(h), anchorOk: true, anchorPath: null, error: null };
      try {
        entry.anchorPath = tildify(resolver.resolve(h.target).path);
      } catch (e) {
        entry.anchorOk = false;
        entry.error = `${e.code ?? 'ERROR'}: ${e.message}`;
      }
      return entry;
    });
    return {
      version: resolver.version,
      tableFile: resolver.tableFile,
      configRoot: tildify(configRoot),
      storeRoot: tildify(storeRoot),
      anchors,
      handles,
      ok: anchors.every((a) => a.ok) && handles.every((h) => h.anchorOk),
    };
  }

  return { resolver, ctx, probe, plan, apply, verify, restore, backups, audit, doctor };
}
