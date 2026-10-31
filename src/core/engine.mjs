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
import { ConfirmationRequiredError, GateBlockedError, ConsoleError } from './errors.mjs';
import * as registry from './registry.mjs';
import { isWorkBuddyRunning } from './appstate.mjs';
import { readActiveToneStyle } from './appconfig.mjs';
import { autoCapture } from '../verify/auto-capture.mjs';
import { evaluateTokenDelta } from '../verify/token-delta.mjs';
import {
  writeProfile, readProfile, listProfiles, deleteProfile, slugify, PROFILE_HANDLES,
} from './profiles.mjs';
import { buildBundle, readBundle, detectDrift } from './replay.mjs';
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
    /** 输入形态：text（默认，整篇文本）/ rule-op（结构化操作，如规则矩阵） */
    inputKind: h.inputKind ?? 'text',
    ...(h.domain ? { domain: h.domain } : {}),
  };
}

/**
 * @param {{configRoot:string, storeRoot:string, version?:string, actor?:string, sessionStartOf?:Function, appStateProbe?:()=>true|false|'unknown'}} opts
 */
export function createEngine({
  configRoot, storeRoot, version, actor = 'cli', sessionStartOf, appStateProbe,
}) {
  const resolver = createResolver({ configRoot, version });
  /** 可注入的进程状态探测 —— 让闸门可测试（生产默认查真实进程） */
  const probeAppState = appStateProbe ?? isWorkBuddyRunning;
  const ctx = {
    configRoot,
    storeRoot,
    version: resolver.version,
    resolve: resolver.resolve,
    /** 取不到返回 null 而不是抛错（用于可选锚点，如安装目录相关） */
    resolveOptional: (key) => { try { return resolver.resolve(key); } catch { return null; } },
    isWorkBuddyRunning: probeAppState,
    /** 把手在 verify 里可能需要查自己的 apply 记录（如标记法的 afterMs） */
    readAudit: () => readAudit(storeRoot),
  };

  /** 边界契约 · 进程互斥闸门 */
  function gateCheck(handle) {
    const kind = handle.gate ?? 'none';
    const g = { kind, blocked: false, reason: null, warnings: [] };
    if (kind === 'app-must-be-closed') {
      const r = probeAppState();
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

  /**
   * 解析一个把手的实际目标。
   *
   * 契约补充：把手可实现 `resolveTarget(ctx)` 覆盖静态锚点，用于"运行时才知道写到哪"的场合
   *   —— style 档位内容（按 id）、C 组模板（按版本哈希）。
   * 不实现则回退到 `target` 声明的锚点。
   * @param {object} h
   */
  function anchorFor(h) {
    if (typeof h.resolveTarget === 'function') return h.resolveTarget(ctx);
    return resolver.resolve(h.target);
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
    const anchor = anchorFor(h);

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

    const anchor = anchorFor(h);
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

    // 把把手自己的结果**展开到顶层**，方便调用方直接读（同时保留 written 原样）
    return {
      handle: h.id,
      backupId: manifest.id,
      ...written,
      written,
      gate: g,
      verification: h.verification,
      expectedDeltaTokens,
    };
  }

  // ── 5. 验证（三态，原样透传，不粉饰）────────────────────────
  async function verify(id, args = {}) {
    const h = registry.get(id);
    const strategy = h.verification?.strategy;

    const manual = Number.isFinite(args.baselineTokens)
      || Number.isFinite(args.observedTokens)
      || Number.isFinite(args.expectedDelta);

    /**
     * 只有 token-delta 需要"自动对照"（从 trace 取基线/观测）。
     * 头部通道的 marker-trace-grep 自己会扫 trace，不该被套上 token 逻辑。
     */
    const needsAutoCapture = strategy === 'token-delta';

    /** @type {any} */
    let effective = args;
    let capture = null;

    if (needsAutoCapture && !manual) {
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
      strategy,
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

  // ── 专家档位（多把手事务）───────────────────────────────────

  /**
   * 从**当前实际状态**采集一个档位 —— 相当于 chezmoi 的 `re-add`（把现状吸回源）。
   * @param {{id?:string, name:string, handleIds?:string[]}} p
   */
  async function captureProfile({ id, name, handleIds } = {}) {
    const explicit = Array.isArray(handleIds) && handleIds.length > 0;
    const ids = explicit ? [...handleIds] : [...PROFILE_HANDLES];

    // 默认档位额外带上**当前生效**的 style 内容把手 ——
    // 这样"一个专家"才真正等于「人设 + 表达方式」，切档位时两处一起换。
    if (!explicit) {
      const activeStyle = readActiveToneStyle(ctx);
      const sid = activeStyle ? `style.${activeStyle}` : null;
      if (sid && registry.list().some((h) => h.id === sid)) ids.push(sid);
    }

    const values = {};
    const sources = {};
    for (const hid of ids) {
      const h = registry.get(hid);
      const st = await h.probe(ctx);
      values[hid] = st.value !== undefined ? String(st.value ?? '') : String(st.text ?? '');
      sources[hid] = { path: tildify(st.path), sha256: st.sha256 ?? null, bytes: st.bytes ?? null };
    }
    const resolvedId = id?.trim() || slugify(name);
    return writeProfile(storeRoot, {
      id: resolvedId,
      name: name?.trim() || resolvedId,
      values,
      sources,
    });
  }

  /**
   * 预览一次档位切换：逐把手差异 + **合计期望增量**。
   * @param {string|object} profileOrId
   */
  async function planProfile(profileOrId) {
    const profile = typeof profileOrId === 'string' ? readProfile(storeRoot, profileOrId) : profileOrId;
    const items = [];
    for (const [hid, next] of Object.entries(profile.values)) {
      const h = registry.get(hid);
      const anchor = resolver.resolve(h.target);
      const gate = gateCheck(h);
      const st = await h.probe(ctx);
      const pv = await h.preview(ctx, { next });
      items.push({
        handle: hid,
        title: h.title,
        writeClass: h.writeClass,
        anchor: tildify(anchor.path),
        current: st.value !== undefined ? st.value : `${String(st.text ?? '').length} 字符`,
        next: st.value !== undefined ? next : `${next.length} 字符`,
        expectedDeltaTokens: pv.expectedDeltaTokens ?? null,
        diffText: pv.diffText,
        warnings: pv.warnings ?? [],
        gate,
      });
    }
    return {
      profile: { id: profile.id, name: profile.name },
      items,
      expectedDeltaTokens: items.reduce((s, i) => s + (i.expectedDeltaTokens ?? 0), 0),
      needsConfirm: items.some((i) => i.writeClass === 'vendor-file'),
      blocked: items.some((i) => i.gate.blocked),
    };
  }

  /**
   * 应用档位：**一次备份覆盖全部目标 → 全部写入 → 一条审计**。
   * 这是"单一用户意图 = 单一事务"的落地点：切换前后各是一个可还原的整体。
   * @param {string|object} profileOrId
   */
  async function applyProfile(profileOrId, { confirm = false, reason } = {}) {
    const profile = typeof profileOrId === 'string' ? readProfile(storeRoot, profileOrId) : profileOrId;

    /** @type {Map<string,{key:string,absPath:string}>} 按绝对路径去重（多个字段可能同文件） */
    const targets = new Map();
    const planned = [];
    const previews = [];

    for (const [hid, next] of Object.entries(profile.values)) {
      const h = registry.get(hid);
      const gate = gateCheck(h);
      if (gate.blocked) throw new GateBlockedError(gate.reason, { handle: hid, profile: profile.id });
      if (h.writeClass === 'vendor-file' && !confirm) {
        throw new ConfirmationRequiredError(
          `档位 ${profile.id} 含厂商文件把手 ${hid}，需显式确认（--confirm）`,
          { profile: profile.id, handle: hid },
        );
      }
      const anchor = anchorFor(h);
      targets.set(anchor.path, { key: anchor.key ?? h.target, absPath: anchor.path });
      const pv = await h.preview(ctx, { next });
      previews.push({ handle: hid, expectedDeltaTokens: pv.expectedDeltaTokens ?? null, warnings: pv.warnings ?? [] });
      planned.push({ h, next });
    }

    // 铁律 1：**先**一次备份覆盖全部目标，再动任何一个
    const manifest = createBackup({
      storeRoot,
      actor,
      reason: reason ?? `apply profile ${profile.id}（${targets.size} 文件 / ${planned.length} 把手）`,
      entries: [...targets.values()],
    });

    const written = [];
    for (const { h, next } of planned) {
      written.push({ handle: h.id, ...(await h.apply(ctx, { next })) });
    }

    const expectedDeltaTokens = previews.reduce((s, p) => s + (p.expectedDeltaTokens ?? 0), 0);
    appendAudit(storeRoot, {
      event: 'apply-profile',
      profile: profile.id,
      profileName: profile.name,
      backupId: manifest.id,
      handles: planned.map((p) => p.h.id),
      files: [...targets.values()].map((t) => t.key),
      expectedDeltaTokens,
      actor,
    });

    return {
      profile: profile.id,
      backupId: manifest.id,
      written,
      expectedDeltaTokens,
      previews,
      files: targets.size,
    };
  }

  /**
   * 档位切换后的生效验证 —— 同一套 token-delta。
   * 期望增量 = 各把手合计（它们都在同一条 user-context 尾段通道里）。
   * @param {string|object} profileOrId
   */
  async function verifyProfile(profileOrId, args = {}) {
    const id = typeof profileOrId === 'string' ? profileOrId : profileOrId?.id;
    const lastApply = readAudit(storeRoot)
      .filter((r) => r.event === 'apply-profile' && r.profile === id)
      .at(-1);

    const finish = (res) => {
      appendAudit(storeRoot, {
        event: 'verify-profile', profile: id, verdict: res.verdict, reason: res.reason, actor,
      });
      return res;
    };

    if (!lastApply) {
      return finish({
        verdict: 'undetermined',
        reason: `档位 ${id} 还没有 apply 记录 —— 先切换一次，再验证`,
        profile: id,
        warnings: [],
      });
    }

    const applyAtMs = Date.parse(lastApply.at);
    const capture = autoCapture({
      configRoot,
      applyAtMs: Number.isFinite(applyAtMs) ? applyAtMs : Date.now(),
      expectedDelta: lastApply.expectedDeltaTokens ?? undefined,
      sessionStartOf,
    });
    if (capture.blockedReason) {
      return finish({
        verdict: 'undetermined', reason: capture.blockedReason, profile: id,
        warnings: capture.warnings ?? [], capture,
      });
    }

    const result = evaluateTokenDelta({
      baselineTokens: capture.baselineTokens,
      observedTokens: capture.observedTokens,
      expectedDelta: capture.expectedDelta,
    });
    return finish({
      ...result,
      profile: id,
      handles: lastApply.handles,
      evidence: capture.evidence,
      warnings: capture.warnings ?? [],
    });
  }

  // ── 版本重放（演进契约）─────────────────────────────────────

  /** 建重放包：只收 upgradeBehavior==='invalidated' 的把手 */
  async function captureBundle() {
    return buildBundle({ storeRoot, handles: registry.list(), ctx });
  }

  /** 只读检测：升级后哪些定制没了、哪些需要重放 */
  async function checkDrift() {
    return detectDrift({ storeRoot, handles: registry.list(), ctx });
  }

  /**
   * 重放：把快照灌回**指定**（默认全部需要重放的）把手。
   * 一次备份覆盖全部目标、一条审计、整体可还原 —— 与档位切换同一套事务语义。
   * @param {{only?:string[], confirm?:boolean, reason?:string}} [opts]
   */
  async function replay({ only, confirm = false, reason } = {}) {
    const drift = await checkDrift();
    if (!drift.ok) {
      throw new ConsoleError('NO_BUNDLE', drift.reason, { hint: '先运行 captureBundle' });
    }
    const bundle = readBundle(storeRoot);
    const targets = (only?.length ? only : drift.needReplay).filter(Boolean);
    if (targets.length === 0) {
      return { replayed: [], skipped: [], note: '没有需要重放的把手（定制都还在）', drift };
    }

    /** @type {Map<string,{key:string, absPath:string}>} */
    const backups = new Map();
    const plan = [];
    const skipped = [];

    for (const id of targets) {
      const h = registry.get(id);
      const entry = bundle.entries[id];
      if (!entry) { skipped.push({ id, reason: '重放包里没有这一项' }); continue; }
      if (entry.content == null) {
        skipped.push({ id, reason: '这一项不是文本型（如规则矩阵），重放需单独处理' });
        continue;
      }
      const gate = gateCheck(h);
      if (gate.blocked) {
        throw new GateBlockedError(gate.reason, { handle: id, op: 'replay' });
      }
      if (h.writeClass === 'vendor-file' && !confirm) {
        throw new ConfirmationRequiredError(
          `重放涉及厂商文件把手 ${id}，需显式确认（--confirm）`,
          { handle: id },
        );
      }
      const anchor = anchorFor(h);
      backups.set(anchor.path, { key: anchor.key ?? h.target, absPath: anchor.path });
      plan.push({ h, next: entry.content });
    }

    if (plan.length === 0) {
      return { replayed: [], skipped, note: '没有可重放的文本型把手', drift };
    }

    const manifest = createBackup({
      storeRoot,
      actor,
      reason: reason ?? `replay（${plan.length} 个把手 / ${backups.size} 个文件）`,
      entries: [...backups.values()],
    });

    const replayed = [];
    for (const { h, next } of plan) {
      try {
        const r = await h.apply(ctx, { next });
        replayed.push({ handle: h.id, ok: true, ...r });
      } catch (e) {
        replayed.push({ handle: h.id, ok: false, error: `${e.code ?? 'ERR'}: ${e.message}` });
      }
    }

    const okCount = replayed.filter((r) => r.ok).length;
    const failed = replayed.filter((r) => !r.ok);

    appendAudit(storeRoot, {
      event: 'replay',
      backupId: manifest.id,
      handles: plan.map((p) => p.h.id),
      ok: okCount,
      failed: failed.length,
      actor,
    });

    return {
      backupId: manifest.id,
      replayed,
      ok: okCount,
      failed: failed.length,
      /** 有失败就必须让调用方看得见 —— 不允许"部分成功"被说成成功 */
      partial: failed.length > 0 && okCount > 0,
      skipped,
      files: backups.size,
      drift,
    };
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
        entry.anchorPath = tildify(anchorFor(h).path);
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

  return {
    resolver, ctx,
    probe, plan, apply, verify, restore, backups, audit, doctor,
    // 专家档位
    captureProfile, planProfile, applyProfile, verifyProfile,
    profiles: () => listProfiles(storeRoot),
    removeProfile: (id) => deleteProfile(storeRoot, id),
    // 版本重放（演进契约）
    captureBundle, checkDrift, replay,
  };
}
