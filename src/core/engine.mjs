/**
 * 执行引擎 —— plan → apply → verify → audit 的唯一入口。
 *
 * 设计要点：
 *   - 前端/CLI 都只通过本引擎动作，**不直接碰文件系统**
 *   - apply 前必然先备份（铁律 1），无需调用方记得
 *   - 闸门未满足时**拒绝执行**，而不是"写了不生效"（边界契约）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResolver } from './anchor.mjs';
import { createBackup, restoreBackup, listBackups, sha256, readManifest } from './backup.mjs';
import { appendAudit, readAudit } from './audit.mjs';
import { diffLines, renderDiff } from './diff.mjs';
import { estimateCost } from './tokens.mjs';
import { ConfirmationRequiredError, GateBlockedError, ConsoleError } from './errors.mjs';
import { writeFileAtomic, mapWriteError, isWriteFailure, writeFailureError } from './atomic-write.mjs';
import * as registry from './registry.mjs';
import { isWorkBuddyRunning } from './appstate.mjs';
import { readActiveToneStyle } from './appconfig.mjs';
import { autoCapture } from '../verify/auto-capture.mjs';
import { evaluateTokenDelta } from '../verify/token-delta.mjs';
import {
  writeProfile, readProfile, listProfiles, deleteProfile, slugify, PROFILE_HANDLES,
} from './profiles.mjs';
import { buildBundle, readBundle, detectDrift } from './replay.mjs';
import { previewApproval, findApprovalLevel, combineVerdicts, APPROVAL_LEVELS } from './approval.mjs';
import { applyLevel, detectLevel } from './safety-block.mjs';
import { readRules } from './rules.mjs';
import { tildify, backupsDir } from './paths.mjs';

/**
 * 整文件把手的 `next` 必须是**字符串**（R31）。
 *
 * 为什么必须显式拦：`0 / false / {} / [] / true` 这类 JSON 值到把手层会变成
 * `TypeError`（或 `[object Object]`）—— 引擎把它包成 `code=INTERNAL` + 裸堆栈；
 * 更糟的是**备份已经建好了**：文件一个字节没变，`backups/` 里却留下一份孤儿备份。
 * 用户看到"内部错误"，去查备份还会以为自己改成功过。
 *
 * 语义选择 `INPUT_INVALID` 而不是 `INPUT_MISSING`：
 *   `INPUT_MISSING` 的含义是"**没有**提供写入内容"（键缺失 / JSON `null`），
 *   这里内容**提供了**，只是形态不是这个把手能写的。报 MISSING 会把用户引向
 *   "我是不是忘了传参数"，而真正的问题是"我传错了类型"。
 *
 * `''`（显式空串）仍然放行 —— 那是"清空文件"的合法意图，是故意的不便（P1 不变式）。
 *
 * @param {object} h @param {any} next
 */
function assertWholeFileInput(h, next) {
  if (h.writesWholeFile !== true) return;
  if (typeof next === 'string') return;
  const shape = next === null ? 'null'
    : Array.isArray(next) ? '数组'
      : typeof next === 'object' ? '对象'
        : `${typeof next}（${JSON.stringify(next)}）`;
  throw new ConsoleError(
    'INPUT_INVALID',
    `「${h.title}」是整文件写入的把手，next 必须是字符串，收到 ${shape}。`
    + `拒绝执行：**未建立备份、未改动文件**。`
    + `\n  要清空文件请显式传空字符串 ""；结构化值（0 / false / {} / [] / true）对这个把手没有意义。`,
    { handle: h.id, received: shape, writesWholeFile: true },
  );
}

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
  /**
   * 最初基线账本目录（可选）。
   *
   * 为什么需要这个参数：默认位置是**项目目录** `baselines/`（铁律 4 的例外条款——
   * 账本随仓库维护、gitignore 排除）。但那样一来，任何**隔离运行**都还会往真实账本目录写：
   * 拿 fixture 起一次服务（`--root`/`--store` 都指到临时目录），启动时的自动补建
   * 就会把合成账本 `5.9.3(0000).json` 落进真实 `baselines/`，
   * UI 于是显示"共 2 套账本"，用户分不清哪本是出厂快照、哪本是测试垃圾。
   *
   * （实测复现过两次：第一次误判成自测 T8 的锅，第二次用 fixture 起服务时抓到真凶——
   *   自测早就修好了 `WORKBUDDY_BASELINES_DIR`，起服务这条路没人管。）
   *
   * 规则：显式传入 > WORKBUDDY_BASELINES_DIR > 项目默认。
   * 调用方（服务端）只在**显式指定了非默认 store** 时才传，所以正常用户路径不受影响。
   */
  baselinesDir: explicitBaselinesDir,
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

  /**
   * 写后审计的保护壳（F6）。
   *
   * 为什么必须有：`appendAudit` 曾经裸露在"文件已经写完"之后。`store/state` 不可写时——
   * 目标文件**已改**、调用方收到"失败"、`audit.jsonl` **零行**、异常里**没有 `backupId`**。
   * 用户既不知道写已经发生，也不知道有一份备份可以还原；双失败时真实原因（EPERM）
   * 还会被审计异常（EEXIST）顶掉。
   *
   * 现在：审计失败**不吞掉**，也不伪装成功——抛一个可判定的错误：
   *   - 错误码 `AUDIT_WRITE_FAILED`；
   *   - 异常对象带 `backupId`（告诉调用方"写已经发生，有备份可退"）；
   *   - 文案明说"已完成，但台账没写成"。
   * **不**做"审计失败就回滚文件"：写入与台账不在一个事务里，回滚做不到原子，
   * 只会把"文件已改"变成"文件被回滚了一半"，比如实报告更糟。
   *
   * @param {object} record 审计记录
   * @param {{backupId?:string|null, wrote?:boolean}} [opts]
   */
  function auditAfterWrite(record, { backupId = null, wrote = true } = {}) {
    try {
      appendAudit(storeRoot, record);
    } catch (e) {
      const err = new ConsoleError(
        'AUDIT_WRITE_FAILED',
        (wrote
          ? `操作已完成${backupId ? `（备份 ${backupId} 可还原）` : ''}，但台账记录失败`
          : '台账记录失败（本次是预演，未写盘）')
        + `：${e?.code ?? 'ERR'} ${e?.message ?? e}`,
        { backupId, wrote },
      );
      err.backupId = backupId;
      err.written = wrote;
      err.cause = e;
      throw err;
    }
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
  async function apply(id, { next, confirm = false, reason } = {}) {
    const h = registry.get(id);

    /**
     * ⚠️ 防线（独立复核 D1，CRITICAL）：`next` 必须是**显式传进来的值**。
     *
     * 曾经签名是 `{ next = '' }` —— 漏传就兜底成空字符串，把手把整个文件写成空。
     * 实测：32 字节的人设文件 → 0 字节，CLI 还打印「✅ 已写入」。
     * 一次漏参数的命令就清空用户数据，而且工具用绿色说成功。
     *
     * 现在：`next` 为 undefined（漏传）直接拒绝；只有**显式**传空字符串才允许清空
     * （那是用户的真实意图，例如主动清空某段内容）。
     */
    if (next === undefined) {
      throw new ConsoleError(
        'INPUT_MISSING',
        `未提供写入内容（next）—— 拒绝执行。`
        + `\n  这是防"漏参数把 ${h.title} 的整个文件清空"的硬防线（曾实测 32 字节 → 0 字节且报成功）。`
        + `\n  确实要清空内容，请显式传空字符串。`,
        { handle: h.id },
      );
    }

    /**
     * R31：畸形 `next`（`0 / false / {} / [] / true`）必须在**建备份之前**拒掉。
     *
     * 曾经：引擎先把备份建好，再调 `h.apply` —— 把手层一个 `TypeError` 抛出来，
     * HTTP 回 400 但 `code=INTERNAL` + 裸堆栈，而 `backups/` 里**已经多了一份孤儿备份**。
     * 用户以为改成功了/以为留下了一份可还原的快照，其实两边都不是。
     *
     * 位置很关键：**在 `createBackup` 之上**。这里拒绝 = 副作用为零（文件未变、无备份、无台账）。
     */
    assertWholeFileInput(h, next);

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

    /**
     * 无改动即不写、不备份。
     *
     * 曾经（T3）：apply 不做 noop 判定，内容一模一样也照写、照建备份 ——
     * 于是用户每点一次「应用」就多一份噪声备份，台账里也分不清哪次真改了什么。
     * `restoreBaseline` 一直有 `changed` 判定，apply 却没有，两个同类动作语义不一致。
     *
     * 判定分两层（独立复核 D4 指出第一版只覆盖 10/18 把手）：
     *
     *   ① **纯文本把手**（身份文件 / 风格 / 模板）：写入内容与现存文本逐字节比较，
     *      相同就直接返回 noop，**连备份都不建**。这是零成本的预判。
     *   ② **结构化把手**（JSON 字段 / 规则矩阵）：它们做"最小改动写入"，
     *      传入的 next 与文件全文根本不可比（例如 toneStyle 传的是枚举值 'efficient'，
     *      文件是整篇 JSON）。对这些只能**写完再比**：前后字节一致则判定为 noop，
     *      并把刚建的备份删掉（否则就是噪声备份）。
     *
     * 第一版只做了 ①，导致 value 型（toneStyle / customPrompt）与 rule-op 型
     * （rules.*）同值重复 apply 仍然每次建备份 —— 计划里的验收判据「同内容两次备份数不变」不通过。
     */
    const nextText = typeof next === 'string' ? next : JSON.stringify(next);

    /**
     * "整文件文本把手"的判定 —— **不能靠猜**（独立复核 D4 抓出）。
     *
     * 踩过的两个坑：
     *   ① 最早按 `!h.inputKind` 判 → `json-field` 工厂（toneStyle / customPrompt）
     *      根本没声明 inputKind，被误判成文本把手，于是它的"最小改动写入"跳过了第②层，
     *      同值重复 apply 照样建备份。
     *   ② 改成 `typeof next === 'string'` 也不行 → toneStyle 的 next 是**枚举值字符串**
     *      'efficient'，与"整篇 JSON 文件全文"性质完全不同，但类型上分不出来。
     *
     * 正确做法：**让把手自己声明**。契约里加一个可选的 `writesWholeFile: true`：
     *   - 身份文件（SOUL/USER/IDENTITY）、风格文件、提示词模板 → true（next 就是整文件内容）
     *   - JSON 字段（toneStyle / customPrompt）、规则矩阵 → 不声明（next 只是字段值/操作）
     *
     * 没声明的按"非整文件"处理（保守：宁可多走一次写后比对，也不要把结构化写入误判成全文）。
     */
    const writesWholeFile = h.writesWholeFile === true;
    const isTextHandle = writesWholeFile && typeof next === 'string';

    // 期望增量按**截断后**文本计算（把手自己知道注入上限），落进台账供 verify 自动对照
    //
    // ⚠️ 这里必须把 preview 的 **warnings 也留下来**，不能只取 expectedDeltaTokens。
    // 曾经（D2）只取增量、把 warnings 扔掉 —— 于是 style 把手那条
    // 「该档位当前未生效，改这个文件不会影响任何请求」永远送不到用户眼前：
    // 前端不调 /plan，apply 又把它丢了，两处都断 → 警告彻底不可达。
    // 这正好是本项目存在的理由（防"写成功但效果为零"）在自己代码里失守。
    let expectedDeltaTokens = null;
    let previewWarnings = [];
    let previewIsActive = null;
    if (typeof h.preview === 'function') {
      try {
        const pv = await h.preview(ctx, { next });
        expectedDeltaTokens = pv.expectedDeltaTokens ?? null;
        previewWarnings = Array.isArray(pv.warnings) ? pv.warnings : [];
        if (typeof pv.isActive === 'boolean') previewIsActive = pv.isActive;
      } catch { /* 预览失败不阻断写入（写入本身仍有备份兜底） */ }
    }

    // ① 纯文本把手：写入内容与现存文本逐字节相同 → 什么都不做
    if (isTextHandle && before === nextText) {
      appendAudit(storeRoot, {
        event: 'apply',
        handle: h.id,
        anchor: h.target,
        path: tildify(anchor.path),
        backupId: null,
        bytesBefore: Buffer.byteLength(before, 'utf8'),
        bytesAfter: Buffer.byteLength(before, 'utf8'),
        /**
         * ⚠️ 这里必须是 **null**，不能是 0。
         *
         * 曾经写 0，后果（由独立复核抓出，三版代码上全部复现）：
         * noop apply 之后跑 verify，自动对照读到 expectedDelta=0，
         * `evaluateTokenDelta` 走"预期无变化 + 实测无变化"分支 → 回 **effective**。
         * 也就是**用户什么都没改，工具却报绿色「✅ 生效」**——违铁律 6。
         *
         * 语义上：expectedDeltaTokens 表示"这次改动应带来多少增量"。
         * 没改动 = 没有可验证的期望 = null（无从判定），不是 0（期望零增量）。
         */
        expectedDeltaTokens: null,
        gateKind: g.kind,
        actor,
        changed: false,
        noop: true,
        reason: reason ?? 'apply-noop',
      });
      return {
        handle: h.id,
        backupId: null,
        contentChanged: false,
        path: anchor.path,
        bytes: Buffer.byteLength(before, 'utf8'),
        note: '内容与现状一致，未写入、未建备份（无需验证——没有改动）',
        written: null,
        gate: g,
        verification: h.verification,
        expectedDeltaTokens: null,
        noop: true,
      };
    }

    const manifest = createBackup({
      storeRoot,
      actor,
      reason: reason ?? `apply ${h.id}`,
      entries: [{ key: h.target, absPath: anchor.path }],
    });

    /**
     * 铁律 1 的失败面：备份已落盘、写入却失败时，**必须留下台账**。
     *
     * 曾经（T1）：这里裸 await。写失败（例如 EPERM）→ 备份成了孤儿、审计里一个字都没有，
     * 用户看到的是"点了没反应、也没报错留痕"。同类路径 `applyProfile`（见下）
     * 与 `replay` 都有逐项 try/catch + `status: partial/failed`，唯独单把手这条漏了。
     */
    let written;
    try {
      written = await h.apply(ctx, { next });
    } catch (e) {
      /**
       * ① 先判断这次是不是**什么都没写**（残余 R41）。
       *
       * 备份是在调 `h.apply` **之前**建的，而有些校验只能进去才做得了——
       * 例如 `rules.*` 的"没有规则命中"，它必须先读到当前规则才知道命不命中。
       * 这类拒绝发生后，那份备份的内容与目标文件**逐字节相同**，纯粹是冗余；
       * 留在 store 里看起来却像"动过"，还会被误当成改动痕迹（实测 6 份同 sha 的）。
       *
       * 分寸（两条都要满足才清）：
       *   · 不是一次真正的落盘尝试（`!isWriteFailure`）—— 原子写下"写失败 ⇒ 目标未变"，
       *     但那种情况**保留**备份是对的（铁律 1：备份是唯一能回到写前状态的东西，
       *     而且报错文案会把它交给用户）；
       *   · 目标文件逐字节没变 —— 防止"写成功了、后面某步才抛错"被误判成没写。
       * 两条都满足 ⇒ 这份备份与当前文件完全重复，删掉不影响任何可还原性。
       */
      let untouched = false;
      if (!isWriteFailure(e)) {
        try {
          const now = fs.existsSync(anchor.path) ? fs.readFileSync(anchor.path) : Buffer.alloc(0);
          untouched = Buffer.compare(now, Buffer.from(before, 'utf8')) === 0;
        } catch { untouched = false; }
      }
      if (untouched) {
        try {
          fs.rmSync(path.join(backupsDir(storeRoot), manifest.id), { recursive: true, force: true });
        } catch { /* 清不掉不影响结论 */ }
      }
      /** 清掉之后**不许再引用**那个 id：否则文案会把用户指向一份已经不存在的备份 */
      const keepBackupId = untouched ? null : manifest.id;
      /**
       * 写失败的文案必须说清"文件现在是什么状态"（R28）。
       *
       * 原子写带来一个新事实：**写失败 ⇒ 目标文件必然没被改过**。所以这里把裸 errno
       * 翻译成稳定码，并把这句话、handle id、目标路径、backupId 一起说出来。
       * 曾经 CLI 只打裸 `Error: ENOSPC …` + 栈，用户会以为"失败＝文件没变"——
       * 而当时的事实**正相反**（裸 writeFileSync 已把目标截断成 0 字节）。
       */
      const mapped = isWriteFailure(e)
        ? writeFailureError(e, { handle: h.id, absPath: anchor.path, backupId: keepBackupId })
        : e;
      /**
       * 失败台账：**审计再失败也不许顶掉真实原因**（F6 的"二次伤害"）。
       * 曾经 `store/state` 与目标文件同时不可写时，用户看到的是审计的 EEXIST，
       * 而真正该看的 EPERM 被吃掉了。
       */
      try {
        appendAudit(storeRoot, {
          event: 'apply',
          handle: h.id,
          anchor: h.target,
          path: tildify(anchor.path),
          backupId: keepBackupId,
          backupDropped: untouched || undefined,
          bytesBefore: Buffer.byteLength(before, 'utf8'),
          expectedDeltaTokens,
          gateKind: g.kind,
          actor,
          changed: false,
          status: 'failed',
          // 台账里也必须是**翻译后**的码与文案（否则用户从 audit 里读不出文件状态）
          error: { code: mapped?.code ?? 'ERR', message: mapped?.message },
          reason: reason ?? `apply ${h.id}`,
        });
      } catch { /* 保留原始异常 e：它才是用户要看的失败原因 */ }
      // 把备份 id 带进异常，让调用方知道"有一份备份，可以还原"（被清掉时是 null）
      if (e && typeof e === 'object') e.backupId = keepBackupId;
      throw mapped;
    }

    const after = fs.existsSync(anchor.path) ? fs.readFileSync(anchor.path, 'utf8') : '';

    /**
     * ② 结构化把手（或任何绕过预判的路径）：**写完再比**。
     * 前后字节完全一致 ⇒ 这次 apply 实际上什么都没改。
     * 处置：删掉刚建的备份（否则就是噪声备份）并如实回报 noop。
     *
     * 为什么不靠把手自己上报：`rules.*` 的 `changed` 是"改了几条规则"（数字），
     * `toneStyle` 是"枚举值有没有换"，语义各不相同；引擎只认"文件字节变没变"这个共同事实。
     */
    const contentChanged = before !== after;

    if (!contentChanged && !isTextHandle) {
      // 只在"结构化把手 + 文件确实没变"时清掉备份。
      // （纯文本把手的 noop 已在前面拦掉，不会走到这里；走到的都是"以为要改、实际没改"。）
      try {
        fs.rmSync(path.join(backupsDir(storeRoot), manifest.id), { recursive: true, force: true });
      } catch { /* 删不掉就留着：多一份备份比丢数据好 */ }
      appendAudit(storeRoot, {
        event: 'apply',
        handle: h.id,
        anchor: h.target,
        path: tildify(anchor.path),
        backupId: null,
        bytesBefore: Buffer.byteLength(before, 'utf8'),
        bytesAfter: Buffer.byteLength(after, 'utf8'),
        expectedDeltaTokens: null,
        gateKind: g.kind,
        actor,
        changed: false,
        noop: true,
        reason: reason ?? `apply-noop ${h.id}`,
      });
      return {
        handle: h.id,
        backupId: null,
        ...(written && typeof written === 'object' ? written : {}),
        contentChanged: false,
        noop: true,
        path: anchor.path,
        bytes: Buffer.byteLength(after, 'utf8'),
        note: '内容与现状一致，未改动（已清理本次预建的备份）',
        written,
        gate: g,
        verification: h.verification,
        expectedDeltaTokens: null,
        /** 预览阶段的警告（如"这一档当前未生效"）——noop 也要如实带出 */
        previewWarnings,
        isActive: previewIsActive,
      };
    }

    /**
     * 写已经落盘，台账这一笔**必须**保护起来（F6）：
     * 审计失败时不许让用户以为"写入失败"——异常会带 `backupId` 并明说"已写入、台账失败"。
     */
    auditAfterWrite({
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
      changed: contentChanged,
      status: 'ok',
    }, { backupId: manifest.id });

    // 把把手自己的结果**展开到顶层**，方便调用方直接读（同时保留 written 原样）
    //
    // ⚠️ 顶层**不额外**塞 `changed`：多个把手（rules.*）自己就用 `changed` 表示
    // "改了几条规则"。引擎若再写一个布尔 `changed`，会把把手的数值覆盖成 true，
    // 下游断言全部读到布尔而不是条数（自测当场红过 3 条）。
    // 引擎自己的"内容是否变化"用独立字段名 `contentChanged`。
    return {
      handle: h.id,
      backupId: manifest.id,
      ...written,
      written,
      gate: g,
      verification: h.verification,
      expectedDeltaTokens,
      contentChanged: before !== after,
      /**
       * 预览阶段的全部警告。**必须带出去**（D2）：
       * style 把手的「当前未生效」「不可写」这些提醒只在这里，
       * 丢掉就等于把"写了也白写"这件事瞒下来。
       */
      previewWarnings,
      /** 该把手原本是"当前生效"的那一份吗（style.* 用；其它把手为 null） */
      isActive: previewIsActive,
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
      } else if (lastApply.noop === true) {
        /**
         * 上一次 apply 是 noop（内容没变）→ 没有任何可验证的改动。
         *
         * 这是独立复核抓出的假阳性：noop 记录曾写 `expectedDeltaTokens: 0`，
         * verify 读到 0 → "预期无变化 + 实测无变化" → 回 **effective**。
         * 用户什么都没改，工具报绿色「✅ 生效」。
         *
         * 正确语义：**没改过就没有"生效"可言**，三态里只有 undetermined 说得通。
         *
         * ⚠️ 判据只能用 `noop === true`（独立复核 D6）：
         * 曾经写成 `lastApply.noop === true || lastApply.changed === false`，
         * 而**写入失败**的台账记录也带 `changed: false` —— 于是"上次写入失败了"
         * 被误报成"上次没有真正改动内容"，把用户引向完全错误的下一步。
         */
        capture = {
          blockedReason: '上一次 apply 没有真正改动内容（noop）—— 没有可验证的变化。'
            + '改点东西再应用，然后新建会话发一条消息，再验证。',
          warnings: [],
        };
      } else if (lastApply.status === 'failed') {
        capture = {
          blockedReason: `上一次 apply **失败了**（${lastApply.error?.code ?? 'ERR'}: ${lastApply.error?.message ?? '未知原因'}）——`
            + '内容根本没写进去，无从验证。先修好写入失败（权限/占用/厂商文件确认），再应用一次。',
          warnings: ['不要把"上次写入失败"当成"没改动"——两者下一步完全不同。'],
        };
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
      /**
       * ⚠️ 任一项估不出增量 ⇒ 整体 `null`，**不许** `?? 0` 兜底（F3）。
       *
       * `?? 0` 把"估不出来"折成"预期零变化"，于是下游判据走
       * 「预期无变化 + 实测无变化 → effective」——**改动完全没进请求也报 ✅ 生效**。
       * 单个把手的 noop 早已按"null = 判不了"修过，档位这条同类路径漏了。
       * `null` 一路传下去，`token-delta` 会说"缺少理论增量 → undetermined"。
       */
      expectedDeltaTokens: items.some((i) => i.expectedDeltaTokens == null)
        ? null
        : items.reduce((s, i) => s + i.expectedDeltaTokens, 0),
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
      // R31：档位对象可以是**手搓**的（不做 assertProfile，见 F1 断言的由来）——
      // 畸形值同样必须在建备份之前拒掉，否则又会留下一份孤儿备份
      assertWholeFileInput(h, next);
      targets.set(anchor.path, { key: anchor.key ?? h.target, absPath: anchor.path });
      const pv = await h.preview(ctx, { next });
      previews.push({ handle: hid, expectedDeltaTokens: pv.expectedDeltaTokens ?? null, warnings: pv.warnings ?? [] });
      planned.push({ h, next, anchor });
    }

    // 铁律 1：**先**一次备份覆盖全部目标，再动任何一个
    const manifest = createBackup({
      storeRoot,
      actor,
      reason: reason ?? `apply profile ${profile.id}（${targets.size} 文件 / ${planned.length} 把手）`,
      entries: [...targets.values()],
    });

    const written = [];
    const failed = [];
    // 逐项 try/catch：中途失败时，前面已落盘的写入**必须**在审计里留下记录。
    // 否则会出现"孤儿备份 + 无台账"——用户看不到自己有东西处于半写状态。
    // 这与 replay() 的纪律一致：先记录发生了什么，再报告成败。
    for (const { h, next, anchor } of planned) {
      try {
        written.push({ handle: h.id, ...(await h.apply(ctx, { next })) });
      } catch (e) {
        // 写失败同样要说清文件状态（R28）：与单把手 apply 共用同一份 errno 映射
        const m = mapWriteError(e, { handle: h.id, absPath: anchor?.path, backupId: manifest.id });
        failed.push({ handle: h.id, code: m?.code ?? e.code ?? 'ERR', message: m?.message ?? e.message });
      }
    }

    /**
     * 同上（F3）：任一项估不出增量 ⇒ 整体 `null`。
     * 折成 0 会让 `verifyProfile` 把"改动完全没进请求"报成"✅ 生效"——
     * 实测姿势：档位里含一个头部通道把手（`prompt.welcomemode-*`，其 preview 明确
     * 返回 `expectedDeltaTokens: null`，因为头部通道无法用 token 估增量）。
     */
    const expectedDeltaTokens = previews.some((p) => p.expectedDeltaTokens == null)
      ? null
      : previews.reduce((s, p) => s + p.expectedDeltaTokens, 0);
    /** 多把手事务的审计同样受保护（F6）：文件已经写了，台账失败要如实说，不许伪装成"整件事失败" */
    auditAfterWrite({
      event: 'apply-profile',
      profile: profile.id,
      profileName: profile.name,
      backupId: manifest.id,
      handles: planned.map((p) => p.h.id),
      written: written.map((w) => w.handle),
      failed,
      status: failed.length ? (written.length ? 'partial' : 'failed') : 'ok',
      files: [...targets.values()].map((t) => t.key),
      expectedDeltaTokens,
      actor,
    }, { backupId: manifest.id });

    return {
      profile: profile.id,
      backupId: manifest.id,
      written,
      failed,
      status: failed.length ? (written.length ? 'partial' : 'failed') : 'ok',
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
      /**
       * ⚠️ 原样透传，**不许** `?? undefined`（F3）。
       *
       * 三个值必须保持可区分：
       *   - 数字（含 0）→ 真的算出了理论增量（0 = 确实不该动，可以判 effective）；
       *   - `null` → 估不出来（必须判 undetermined）；
       *   - 字段缺失 → 老台账，同样按"估不出来"处理。
       * `?? undefined` 把 null 悄悄换成 undefined，看似结果一样，实则抹掉了
       * "null 是有意义的状态"这条语义——下一个消费点只要写 `expectedDelta ?? 0`，
       * 把"没生效"报成"生效"的缺陷就原地复活。
       */
      expectedDelta: lastApply.expectedDeltaTokens,
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
      // R31：重放包是磁盘上的 JSON，可能被改坏 —— 畸形内容同样在备份之前拒掉
      assertWholeFileInput(h, entry.content);
      backups.set(anchor.path, { key: anchor.key ?? h.target, absPath: anchor.path });
      plan.push({ h, next: entry.content, anchor });
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
    for (const { h, next, anchor } of plan) {
      try {
        const r = await h.apply(ctx, { next });
        replayed.push({ handle: h.id, ok: true, ...r });
      } catch (e) {
        // 写失败要说清文件状态（R28）：与 apply / applyProfile 共用同一份 errno 映射
        const m = mapWriteError(e, { handle: h.id, absPath: anchor?.path, backupId: manifest.id });
        replayed.push({ handle: h.id, ok: false, error: `${m?.code ?? e.code ?? 'ERR'}: ${m?.message ?? e.message}` });
      }
    }

    const okCount = replayed.filter((r) => r.ok).length;
    const failed = replayed.filter((r) => !r.ok);

    /** 重放也是写事务：台账失败要如实报告（F6），并把 backupId 挂到异常上 */
    auditAfterWrite({
      event: 'replay',
      backupId: manifest.id,
      handles: plan.map((p) => p.h.id),
      ok: okCount,
      failed: failed.length,
      actor,
    }, { backupId: manifest.id });

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

  // ── P3 · 审批自动同意（编排两个面）─────────────────────────

  /** 当前 C 组活跃模板（用于提示词面） */
  function activePromptHandle() {
    const list = registry.list().filter((h) => h.id.startsWith('prompt.welcomemode-'));
    // 默认取 code 模式；调用方可指定
    return list[0] ?? null;
  }

  /** 各提示词模板当前处于哪个档位 */
  async function approvalState() {
    const out = { levels: APPROVAL_LEVELS, prompts: [], rules: null };
    for (const h of registry.list().filter((x) => x.id.startsWith('prompt.welcomemode-'))) {
      try {
        const st = await h.probe(ctx);
        out.prompts.push({
          handle: h.id,
          path: tildify(st.path),
          version: st.version,
          hasBlock: st.hasPolicy,
          level: detectLevel(st.text ?? ''),
        });
      } catch (e) {
        out.prompts.push({ handle: h.id, error: `${e.code ?? 'ERR'}: ${e.message}` });
      }
    }
    try {
      const r = readRules(ctx, 'file');
      out.rules = {
        ok: r.ok,
        ruleCount: r.ok ? r.rules.length : 0,
        pending: r.ok ? {
          readAsk: r.rules.filter((x) => x.read === 'ask').length,
          writeAsk: r.rules.filter((x) => x.write === 'ask').length,
          deleteAsk: r.rules.filter((x) => x.delete === 'ask').length,
        } : null,
      };
    } catch (e) {
      out.rules = { ok: false, error: `${e.code ?? 'ERR'}: ${e.message}` };
    }
    return out;
  }

  /**
   * 预览某档"审批自动同意"要改什么（只读）。
   * @param {string} level
   * @param {{promptHandleId?:string}} [opts]
   */
  async function planApproval(level, { promptHandleId } = {}) {
    const lv = findApprovalLevel(level);
    const pH = promptHandleId ? registry.get(promptHandleId) : activePromptHandle();
    const promptState = pH ? await pH.probe(ctx) : null;
    const rules = (() => {
      try { return readRules(ctx, 'file'); } catch { return { ok: false, rules: [] }; }
    })();

    const preview = previewApproval({
      level,
      rulesProbe: rules.ok ? { rules: rules.rules } : { rules: [] },
      promptText: promptState?.text ?? '',
      promptTitle: pH?.title,
    });

    return {
      ...preview,
      levelDesc: lv,
      promptHandle: pH?.id ?? null,
      promptPath: promptState ? tildify(promptState.path) : null,
      promptVersion: promptState?.version ?? null,
      gate: {
        appRunning: probeAppState(),
        warning: '提示词面在 C 组版本目录内；规则面在 settings.json。两项都需要重启 WorkBuddy 才生效。',
      },
    };
  }

  /**
   * 应用某档"审批自动同意"：**一次备份覆盖两个面**、一条审计、整体可还原。
   * @param {string} level
   * @param {{confirm?:boolean, promptHandleId?:string, reason?:string}} [opts]
   */
  async function applyApproval(level, { confirm = false, promptHandleId, reason } = {}) {
    const lv = findApprovalLevel(level);
    if (level === 'off') {
      return { level, changed: false, note: '原厂档：不需要任何改动' };
    }

    const plan = await planApproval(level, { promptHandleId });
    const pH = plan.promptHandle ? registry.get(plan.promptHandle) : null;
    const rulesH = registry.get('rules.file');

    // 闸门：两个面都要求应用退出
    const gateR = gateCheck(rulesH);
    if (gateR.blocked) throw new GateBlockedError(gateR.reason, { level, face: 'rules' });
    if (pH) {
      const gateP = gateCheck(pH);
      if (gateP.blocked) throw new GateBlockedError(gateP.reason, { level, face: 'prompt' });
      if (pH.writeClass === 'vendor-file' && !confirm) {
        throw new ConfirmationRequiredError(
          `档位 ${level} 会写 C 组提示词模板（厂商文件），需显式确认（--confirm）`,
          { level, handle: pH.id },
        );
      }
    }

    /** @type {Map<string,{key:string,absPath:string}>} */
    const backups = new Map();
    const touched = [];

    // 规则面
    if (lv.ruleOp) {
      const a = anchorFor(rulesH);
      backups.set(a.path, { key: a.key ?? rulesH.target, absPath: a.path });
      touched.push({ face: 'rules', handle: rulesH.id });
    }
    // 提示词面
    let promptNext = null;
    if (pH) {
      const st = await pH.probe(ctx);
      const applied = applyLevel(st.text ?? '', lv.promptLevel);
      if (applied.changed) {
        const a = anchorFor(pH);
        backups.set(a.path, { key: a.key ?? pH.target, absPath: a.path });
        promptNext = applied.text;
        touched.push({ face: 'prompt', handle: pH.id, dropped: applied.dropped });
      }
    }

    if (backups.size === 0) {
      return { level, changed: false, note: '两个面都已是目标状态，无需改动', plan };
    }

    const manifest = createBackup({
      storeRoot,
      actor,
      reason: reason ?? `approval ${level}（${touched.map((t) => t.face).join('+')}）`,
      entries: [...backups.values()],
    });

    const done = [];
    // 先规则（可靠面），后提示词（不确定面）
    if (lv.ruleOp) {
      try {
        const r = await rulesH.apply(ctx, {
          next: { ...lv.ruleOp },
        });
        done.push({ face: 'rules', ok: true, changed: r.changed ?? null });
      } catch (e) {
        done.push({ face: 'rules', ok: false, error: `${e.code ?? 'ERR'}: ${e.message}` });
      }
    }
    if (promptNext != null && pH) {
      try {
        await pH.apply(ctx, { next: promptNext });
        done.push({ face: 'prompt', ok: true });
      } catch (e) {
        done.push({ face: 'prompt', ok: false, error: `${e.code ?? 'ERR'}: ${e.message}` });
      }
    }

    /** 审批面写入后的台账同样受保护（F6） */
    auditAfterWrite({
      event: 'apply-approval',
      level,
      backupId: manifest.id,
      faces: done.map((d) => ({ face: d.face, ok: d.ok })),
      actor,
    }, { backupId: manifest.id });

    return {
      level,
      title: lv.title,
      backupId: manifest.id,
      files: backups.size,
      done,
      ok: done.filter((d) => d.ok).length,
      failed: done.filter((d) => !d.ok).length,
      plan,
      /** 明确告诉用户：两个面都需要重启才生效 */
      restartRequired: true,
    };
  }

  /**
   * 验证某档"审批自动同意" —— 逐面给结论，再合成一个**诚实的三态**。
   * @param {string} level
   */
  /**
   * 审批档位的验证。
   *
   * @param {string} level
   * @param {{restarted?:boolean}} [opts]
   *   `restarted` —— 用户声明「我已经重启过 WorkBuddy 了」。
   *
   *   ⚠️ 残余 R3b（2026-11-03 修）：本函数原来**不收任何参数**，
   *   内部 `verify('rules.file', {})` 传的是空对象 ⇒ `readback-after-restart`
   *   永远拿不到 `restarted: true` ⇒ **规则面永久停在「无法判定」**。
   *   而 CLI 在 `approval-apply` 之后打印「重启后验证：approval-verify <档位>」——
   *   那条命令**给不出结论**，是空承诺。
   *
   *   注意这里是**用户声明**，不是工具猜测（项目反对猜）：工具无法可靠判断
   *   "这次读到的值是不是重启后才读的"，只能由做过重启的人说。
   *   不声明时仍然如实判 `undetermined`，但提示语会告诉用户**该加什么参数**。
   */
  async function verifyApproval(level, { restarted = false } = {}) {
    const lv = findApprovalLevel(level);
    const parts = { ruleChanged: Boolean(lv.ruleOp), promptChanged: lv.promptLevel !== 'off' };

    /** 规则面：重启后回读（需要用户声明 restarted，见上方注释） */
    let ruleVerdict;
    if (parts.ruleChanged) {
      try {
        const v = await verify('rules.file', { restarted });
        ruleVerdict = v.verdict;
      } catch (e) {
        ruleVerdict = 'undetermined';
      }
    }

    /** 提示词面：标记法（只能证明文本进了请求） */
    let promptVerdict;
    if (parts.promptChanged) {
      const pH = activePromptHandle();
      if (pH) {
        try {
          const v = await verify(pH.id, {});
          promptVerdict = v.verdict;
        } catch { promptVerdict = 'undetermined'; }
      }
    }

    const combined = combineVerdicts({
      ruleVerdict,
      promptVerdict,
      ruleChanged: parts.ruleChanged,
      promptChanged: parts.promptChanged,
    });

    appendAudit(storeRoot, {
      event: 'verify-approval',
      level,
      verdict: combined.verdict,
      reason: combined.reason,
      actor,
    });

    return {
      level,
      ...combined,
      caveat:
        '**"审批自动同意"永远不可能被完全验证。** '
        + '规则面能可靠验证（重启后回读）；提示词面只能验证"文本进了请求"，'
        + '无法验证"模型不再自己问" —— 后者取决于模型自身对齐，属上游。',
    };
  }

  /**
   * 总览 —— 一次聚合，供 UI 首屏用（避免 4 次往返）。
   * 设计原则：能给"未知"就给"未知"，绝不猜。
   */
  async function overview() {
    /**
     * ⚠️ 必须 await（2026-11-03 致命回归）。
     *
     * `doctor()` 改成 async 之后（R3d：真跑 probe），这里漏了 await ⇒ 拿到的是 Promise，
     * 下面 `d.anchors.filter(...)` 在 Promise 上取 `.anchors` → TypeError。
     *
     * 后果不是"报个错"：**整个 `/api/overview` 恒 500**，首页全空；
     * 而 `launch.mjs` 用 `/api/overview` 判断"这个端口是不是我的实例"，
     * 于是第二次双击会误报「令牌对不上，去旧窗口重抄」——地址完全可用。
     *
     * 三条门禁全绿却没抓到它：自测只测 `/api/doctor`（对 `api/overview` 零命中），
     * 前端断言用的是 DOM stub 假数据。**"有断言"和"断言覆盖了这条路径"是两件事。**
     */
    const d = await doctor();
    const drift = await checkDrift();

    /** 定制清单：用重放包的 sha 判断"改过没"；无包 = 未知 */
    const bundle = readBundle(storeRoot);
    const customized = [];
    const unknown = [];
    for (const h of registry.list()) {
      const entry = bundle?.entries?.[h.id];
      if (!entry) { unknown.push({ id: h.id, title: h.title, reason: '没有重放包基线，无法判断是否被改过' }); continue; }
      try {
        const st = await h.probe(ctx);
        const nowSha = st.sha256 ?? null;
        if (nowSha && entry.sha256 && nowSha !== entry.sha256) {
          customized.push({ id: h.id, title: h.title, path: tildify(st.path) });
        }
      } catch {
        unknown.push({ id: h.id, title: h.title, reason: '探测失败' });
      }
    }

    /** 待处理：需要重放 / 锚点失效 */
    const todos = [];
    if (drift.ok && drift.needReplay.length) {
      todos.push({
        kind: 'replay',
        severity: 'warn',
        title: `${drift.needReplay.length} 项定制在升级后不见了`,
        detail: drift.needReplay.join('、'),
        action: 'replay',
      });
    }
    const badAnchor = d.anchors.filter((a) => !a.ok);
    if (badAnchor.length) {
      todos.push({
        kind: 'anchor',
        severity: 'error',
        title: `${badAnchor.length} 个锚点失效`,
        detail: badAnchor.map((a) => a.key).join('、'),
        action: 'doctor',
      });
    }

    const recent = readAudit(storeRoot, { limit: 12 }).reverse();
    const backups = listBackups(storeRoot).slice(0, 8);

    return {
      version: d.version,
      configRoot: d.configRoot,
      storeRoot: d.storeRoot,
      health: { ok: d.ok, anchors: d.anchors.length, anchorFailures: badAnchor.length, handles: d.handles.length },
      gate: { appRunning: probeAppState(), note: '应用运行中时，要求停机的把手会拒绝写入' },
      drift: drift.ok
        ? {
          available: true,
          bundleCreatedAt: drift.bundleCreatedAt,
          bundleVersion: drift.bundleVersion,
          currentVersion: drift.currentVersion,
          versionChanged: drift.versionChanged,
          needReplay: drift.needReplay.length,
          results: drift.results,
        }
        : { available: false, reason: drift.reason },
      customized,
      unknown,
      todos,
      recent,
      backups,
      counts: {
        handles: registry.list().length,
        profiles: listProfiles(storeRoot).length,
        backups: listBackups(storeRoot).length,
        audit: readAudit(storeRoot).length,
      },
    };
  }

  // ── 6. 还原 ────────────────────────────────────────────────
  /**
   * 还原前的闸门检查（独立复核 D3）。
   *
   * 为什么需要它：`apply` 对 `app-must-be-closed` 类的把手会拒绝执行，
   * 而 `restore`/`/api/restore` 曾经**完全不过闸** —— WorkBuddy 运行中也能写厂商文件。
   * 同一类写操作两套规矩，等于给了一个绕过闸门的后门。
   *
   * 判据：一条备份可能覆盖多个把手；**只要有一条被阻断，整体拒绝**（宁严不宽）。
   * @param {string} backupId
   */
  function checkRestoreGate(backupId) {
    let manifest;
    try {
      manifest = readManifest(storeRoot, backupId);
    } catch {
      // 备份不存在由后续 restore 报 BACKUP_MISSING，这里不重复判定
      return { blocked: false, reason: null, handles: [], gate: null };
    }

    const blockedHandles = [];
    let gateKind = null;
    let reason = null;

    for (const entry of manifest.entries ?? []) {
      // 把备份条目反查成把手：优先按 key，其次按 anchorPath
      const h = registry.list().find((x) => x.target === entry.key)
        ?? registry.list().find((x) => {
          try { return anchorFor(x).path === entry.absPath; } catch { return false; }
        });
      if (!h) continue;                       // 不是把手管的文件（例如手写的外部路径）
      const g = gateCheck(h);
      if (g.blocked) {
        blockedHandles.push(h.id);
        gateKind = g.kind;
        reason = g.reason;
      }
    }

    if (!blockedHandles.length) return { blocked: false, reason: null, handles: [], gate: null };
    return {
      blocked: true,
      reason: `还原会写入 ${blockedHandles.length} 个需要停机的把手：${blockedHandles.join('、')}。`
        + `${reason ?? ''}（拒绝执行，而不是写了不生效）`,
      handles: blockedHandles,
      gate: gateKind,
    };
  }

  function restore(backupId, { dryRun = false } = {}) {
    let r;
    try {
      r = restoreBackup({ storeRoot, id: backupId, dryRun });
    } catch (e) {
      /**
       * **整体**失败（备份不存在 / manifest 损坏）：也必须留台账，且异常带 `backupId`（F6/F7）。
       * 审计再失败也不能顶掉真实原因 —— 这里是"补一笔"，不是"换个错抛出去"。
       */
      try {
        appendAudit(storeRoot, {
          event: 'restore',
          backupId,
          dryRun,
          changed: 0,
          status: 'failed',
          error: { code: e?.code ?? 'ERR', message: e?.message ?? String(e) },
          actor,
        });
      } catch { /* 保留原始异常 */ }
      if (e && typeof e === 'object' && e.backupId === undefined) e.backupId = backupId;
      throw e;
    }

    // `changed` 只算真正动了文件的（restore/delete）；`error` 条目不是"变化"
    const changed = r.results.filter((x) => x.action === 'restore' || x.action === 'delete');
    const failed = r.results.filter((x) => !x.ok);
    /** 三态：全成 / 部分成 / 全败 —— 不再只有"成了"与"抛异常"两种 */
    const status = r.ok ? 'ok' : (r.partial ? 'partial' : 'failed');

    /**
     * 审计**无论成败**都写（F6/F7）。
     *
     * 曾经：审计裸露在写之后，而 `restoreBackup` 是裸循环 ——
     * 实测"第一条目已还原、第二条目 EISDIR 中断，restore 审计 0 行"（半还原 + 零台账）。
     * 现在逐条目失败明细、状态三态、还原前副本落点一起进台账。
     */
    auditAfterWrite({
      event: 'restore',
      backupId,
      dryRun,
      changed: changed.length,
      status,
      failed: failed.map((x) => ({
        key: x.key,
        code: x.error?.code ?? 'ERR',
        message: x.error?.message ?? '',
      })),
      savedDir: r.savedDir,
      actor,
    }, { backupId, wrote: !dryRun });

    return { ...r, changed, failed, status };
  }

  function backups() { return listBackups(storeRoot); }
  function audit(limit) { return readAudit(storeRoot, { limit }); }

  /** 体检：锚点是否成立 + 把手契约是否满足 */
  /**
   * 轻量体检：只验锚点能不能解析出路径。**同步、不跑 probe**。
   *
   * 存在的理由：`describe()` / 隔离警告这类调用点要的是**同步**结果
   * （它们在对象字面量里、在启动路径上，改成 async 会连锁改一大片）。
   * 它回答的问题只有"锚点键能不能定位到路径"——**不要**拿它当"把手可用"。
   */
  function doctorAnchors() {
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

  /**
   * 体检（完整）。
   *
   * ⚠️ 残余 R3d（2026-11-03 修）：本函数原来只验「锚点能不能解析」——
   * `ok = anchors.every(a => a.ok) && handles.every(h => h.anchorOk)`。
   * 于是 11 个锚点里 7 个**目标文件根本不存在**时，它照样打「总判：✅ 全部通过」、退出码 0；
   * 而 CLI 帮助文案承诺的是「锚点是否成立、**把手是否可用**」。
   *
   * 现在做三层，逐层回答不同的问题：
   *   ① `anchors` —— 锚点键能不能解析出路径（原来就有的那层）
   *   ② `handles[].targetExists` —— 那个路径上**真的有文件吗**（新增；不存在就 ❌）
   *   ③ `handles[].probe` —— **真跑一次 `h.probe()`**，拿到「存在 / 可写 / 内容指纹」（新增）
   *
   * 为什么 ③ 必须真跑而不是"看路径存不存在"：可写性、内容能不能解析（JSON 坏没坏）、
   * 按 id 动态定位（style.* 七个 / prompt 的版本目录）都只有 probe 知道。
   *
   * 三态而非布尔：`probe` 抛错时是**判不了**，不是"通过"——铁律 6。
   */
  async function doctor() {
    const anchors = resolver.probeAll();
    const handles = [];
    for (const h of registry.list()) {
      const entry = {
        ...meta(h),
        anchorOk: true,
        anchorPath: null,
        error: null,
        /** 目标路径上是否真有东西：true / false / null（没查到） */
        targetExists: null,
        /** 真跑 probe 的结论：'ok' | 'failed' | 'skipped' */
        probe: 'skipped',
        probeError: null,
        /** 可写性（只有 probe 能答；null = 该把手不报告此项） */
        writeAccess: null,
      };
      try {
        entry.anchorPath = tildify(anchorFor(h).path);
      } catch (e) {
        entry.anchorOk = false;
        entry.error = `${e.code ?? 'ERROR'}: ${e.message}`;
        handles.push(entry);
        continue;               // 锚点都不成立，probe 一定失败，不必再打一次
      }
      if (typeof h.probe !== 'function') {
        entry.probe = 'skipped';
        handles.push(entry);
        continue;
      }
      try {
        const st = await h.probe(ctx);
        entry.probe = 'ok';
        entry.targetExists = st?.exists === true;
        if (typeof st?.writeAccess === 'boolean') entry.writeAccess = st.writeAccess;
        if (typeof st?.bytes === 'number') entry.bytes = st.bytes;
        if (typeof st?.sha256 === 'string') entry.sha256 = st.sha256;
        // probe 成功但目标不存在 —— 不是"通过"，是"锚点指向的地方还没有东西"
        if (st?.exists !== true) entry.error = '目标不存在（锚点可解析，但该路径下没有文件）';
      } catch (e) {
        entry.probe = 'failed';
        entry.probeError = `${e.code ?? 'ERROR'}: ${e.message}`;
        entry.error = entry.probeError;
      }
      handles.push(entry);
    }

    /**
     * 总判：任一项不确定即不算通过。
     * 这里的判据读法 —— **"不知道" 与 "失败" 都不通过**，只有全部确实成立才 ✅。
     */
    const anchorBad = anchors.filter((a) => !a.ok);
    const probeFailed = handles.filter((h) => h.probe === 'failed');
    const targetMissing = handles.filter((h) => h.anchorOk && h.probe === 'ok' && h.targetExists !== true);
    const notWritable = handles.filter((h) => h.writeAccess === false);
    const ok = anchorBad.length === 0 && probeFailed.length === 0 && targetMissing.length === 0;

    return {
      version: resolver.version,
      tableFile: resolver.tableFile,
      configRoot: tildify(configRoot),
      storeRoot: tildify(storeRoot),
      anchors,
      handles,
      summary: {
        anchorBad: anchorBad.length,
        probeFailed: probeFailed.length,
        targetMissing: targetMissing.length,
        notWritable: notWritable.length,
        probeSkipped: handles.filter((h) => h.probe === 'skipped').length,
      },
      ok,
    };
  }

  // ── 最初基线（版本化账本）──────────────────────────────────
  // 每个 WorkBuddy 版本一套账：baselines/<版本(哈希)>.json。
  // 同版账本捕获一次不可覆盖；升级出新版 → 新版另立一本，旧账永不被动。
  // 条目三类：text（整文件把手）/ value（json 字段把手，只存字段值）/ file（规则矩阵共享文件）。
  //
  // 位置：按 AGENTS 铁律 4 的**例外条款**，最初基线账本维护在项目目录 `baselines/`
  // （由 .gitignore 排除，公开仓库不收其内容）。
  //
  // ⚠️ 曾经的坑（T8）：这个位置**不可覆盖**，于是 `selftest.mjs` 一跑就把合成账本
  // `5.9.3(0000).json` 写进了真实账本目录，UI 因此显示"共 2 套账本"，
  // 用户无法分辨哪本是出厂快照、哪本是测试垃圾。
  // 现在允许经 `WORKBUDDY_BASELINES_DIR` 覆盖 —— 自测必须指向临时目录，
  // 生产默认位置保持不变（不搬动既有真实账本）。
  const baselinesDir = () => (explicitBaselinesDir?.trim()
    || process.env.WORKBUDDY_BASELINES_DIR?.trim()
    || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'baselines'));

  /** 旧位置（storeRoot/baselines、storeRoot/baseline.json）→ 项目目录 baselines/ 的迁移 */
  function migrateStoreBaselines(key) {
    const legacyDir = path.join(storeRoot, 'baselines');
    const legacyFile = path.join(storeRoot, 'baseline.json');
    const target = ledgerFile(key);
    if (fs.existsSync(legacyDir)) {
      for (const f of fs.readdirSync(legacyDir).filter((x) => x.endsWith('.json'))) {
        const t = path.join(baselinesDir(), f);
        if (!fs.existsSync(t)) {
          fs.mkdirSync(baselinesDir(), { recursive: true });
          fs.renameSync(path.join(legacyDir, f), t);
        }
      }
      try { fs.rmdirSync(legacyDir); } catch { /* 非空则保留 */ }
    }
    if (fs.existsSync(legacyFile) && !fs.existsSync(target)) {
      try {
        const data = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
        data.versionKey = key;
        fs.mkdirSync(baselinesDir(), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf8');
        fs.rmSync(legacyFile);
      } catch { /* 迁移失败不影响捕获 */ }
    }
  }

  /** 版本键：版本(构建哈希)。哈希取自插件缓存目录名（…-wb.x.gd4692421.h… → d4692421）；取不到退化为纯版本号 */
  function versionKey() {
    const v = version ?? '?';
    const ids = registry.list();
    for (const h of ids.filter((x) => x.id.startsWith('prompt.')).concat(ids)) {
      try {
        const p = String(anchorFor(h)?.path ?? '');
        const m = p.match(/(\d+\.\d+\.\d+)-wb\.[^.]+\.g([0-9a-f]+)\./) ?? p.match(/\.g([0-9a-f]{8,})\./);
        if (m) return `${m[1] ?? v}(${m[2]})`;
      } catch { /* 逐把手尝试 */ }
    }
    return `${v}`;
  }

  const ledgerFile = (key) => path.join(baselinesDir(), `${key}.json`);

  function readLedger(key) {
    try { return JSON.parse(fs.readFileSync(ledgerFile(key), 'utf8')); } catch { return null; }
  }

  async function captureBaseline() {
    const key = versionKey();
    migrateStoreBaselines(key);
    const file = ledgerFile(key);
    if (fs.existsSync(file)) {
      return { ...readLedger(key), note: `账本 ${key} 已存在，未覆盖（同版最初快照不可修改）` };
    }
    const entries = {};
    for (const h of registry.list()) {
      let st;
      try { st = await h.probe(ctx); } catch { continue; }
      if (!st?.exists) continue;
      if (h.inputKind === 'rule-op') {
        // 三个规则域共享一个 settings 文件 —— 一份文件级条目，三张卡共用
        const ekey = `rules:${h.target}`;
        if (!entries[ekey]) {
          entries[ekey] = { kind: 'file', anchorKey: h.target, content: st.text ?? '', sha256: sha256(Buffer.from(st.text ?? '', 'utf8')) };
        }
        continue;
      }
      if (st.value !== undefined && st.value !== null && st.value !== '') {
        entries[h.id] = { kind: 'value', content: String(st.value), sha256: sha256(Buffer.from(String(st.value), 'utf8')) };
        continue;
      }
      entries[h.id] = { kind: 'text', content: st.text ?? '', sha256: sha256(Buffer.from(st.text ?? '', 'utf8')) };
    }
    const out = { versionKey: key, capturedAt: new Date().toISOString(), version: 1, entries };
    fs.mkdirSync(baselinesDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
    return out;
  }

  function baselineInfo() {
    const key = versionKey();
    const dir = baselinesDir();
    const ledgers = [];
    let current = null;
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          const k = d.versionKey ?? f.replace(/\.json$/, '');
          const item = { versionKey: k, capturedAt: d.capturedAt, count: Object.keys(d.entries ?? {}).length, isCurrent: k === key };
          ledgers.push(item);
          if (item.isCurrent) current = d;
        } catch { /* 跳过坏文件 */ }
      }
    }
    if (!current) return { available: false, versionKey: key, ledgers };
    const entries = {};
    for (const [k, v] of Object.entries(current.entries)) {
      /**
       * 只给**短值**类条目带 `content`（`kind: 'value'` 且够短）。
       *
       * 为什么要带：界面上「还原」按钮需要说清"还原到什么"，否则只能写"还原"两个字，
       * 用户不悬停就不知道它会把值改回哪一个（D6）。
       * 为什么只给短的：真实账本 152 KB，绝大多数体积是全文本（SOUL.md 等）；
       * 枚举/字段值只有几个字符，带上不增加负担，又是标签真正需要的那个信息。
       */
      const small = v.kind === 'value' && typeof v.content === 'string' && v.content.length <= 120;
      entries[k] = {
        kind: v.kind,
        sha256: v.sha256,
        chars: v.content ? v.content.length : 0,
        ...(small ? { content: v.content } : {}),
      };
    }
    return { available: true, versionKey: key, capturedAt: current.capturedAt, entries, ledgers };
  }

  /** 还原最初设置：把**当前版本账本**的快照写回。写前必备份（铁律 1）；闸门不满足即拒绝。 */
  async function restoreBaseline(id, { confirm = false } = {}) {
    const key = versionKey();
    const b = readLedger(key);
    if (!b) throw new ConsoleError('NO_BASELINE', `当前版本 ${key} 还没有账本——先建立本版账本`);
    const h = registry.get(id);
    let entry = b.entries[id];
    if (!entry && h.inputKind === 'rule-op') entry = b.entries[`rules:${h.target}`];
    if (!entry) throw new ConsoleError('NO_BASELINE', `把手 ${id} 在 ${key} 账本中没有快照`, { id });

    const g = gateCheck(h);
    if (g.blocked) throw new GateBlockedError(g.reason, { handle: h.id, gate: g.kind });
    if (h.writeClass === 'vendor-file' && !confirm) {
      throw new ConfirmationRequiredError(`把手 ${id} 写入的是厂商文件，需显式确认`, { handle: h.id, target: h.target });
    }

    const st = await h.probe(ctx);
    if (!st?.exists || !st.path) throw new ConsoleError('ANCHOR_MISSING', `把手 ${id} 的锚点当前无法定位`, { id });

    const manifest = createBackup({
      storeRoot, actor,
      reason: `restore-baseline ${id}`,
      entries: [{ key: h.target, absPath: st.path }],
    });

    /**
     * 铁律 1 的失败面（独立复核 D2）：备份已落盘、还原却失败时，**必须留下台账**。
     *
     * 曾经：这里裸写盘。失败（EPERM 等）→ 备份成了孤儿、审计里一个字都没有，
     * 用户看到"点了还原没反应"，也不知道有一份备份可以回滚。
     * 与单把手 apply 的 T1 是同一个病——T1 修好了，这条同类路径漏了。
     * 控制台的「还原」按钮走的正是这条路径。
     */
    let changed = false;
    try {
      if (entry.kind === 'file') {
        if ((st.text ?? '') !== entry.content) {
          // 原子写（R27 的第 7 处，brief 未列）：控制台「还原」按钮走的正是这条路，
          // 裸 writeFileSync 在 ENOSPC 下会先把目标截断成 0 字节 —— 与那六处是同一个缺陷。
          writeFileAtomic(st.path, entry.content);
          changed = true;
        }
      } else {
        const cur = entry.kind === 'value'
          ? (st.value !== undefined && st.value !== null ? String(st.value) : '')
          : (st.text ?? '');
        if (cur !== entry.content) {
          await h.apply(ctx, { next: entry.content });
          changed = true;
        }
      }
    } catch (e) {
      // 写失败要说清文件状态（R28）：与 apply / replay / 还原同一条映射
      const mapped = isWriteFailure(e)
        ? writeFailureError(e, { handle: id, absPath: st.path, backupId: manifest.id })
        : e;
      // 审计再失败也不许顶掉真实原因（F6 的"二次伤害"）
      try {
        appendAudit(storeRoot, {
          event: 'restore',
          handle: id,
          anchor: h.target,
          path: tildify(st.path ?? ''),
          backupId: manifest.id,
          bytesBefore: Buffer.byteLength(st.text ?? '', 'utf8'),
          actor,
          changed: false,
          status: 'failed',
          error: { code: mapped?.code ?? 'ERR', message: mapped?.message },
          reason: 'restore-baseline',
        });
      } catch { /* 保留原始异常 e */ }
      if (e && typeof e === 'object') e.backupId = manifest.id;
      throw mapped;
    }

    /** 写已经落盘，台账这一笔必须受保护（F6） */
    auditAfterWrite({
      event: 'restore',
      handle: id,
      anchor: h.target,
      path: tildify(st.path ?? ''),
      backupId: manifest.id,
      bytesBefore: Buffer.byteLength(st.text ?? '', 'utf8'),
      actor,
      changed,
      status: 'ok',
      reason: 'restore-baseline',
    }, { backupId: manifest.id });
    return { handle: id, changed, backupId: manifest.id, kind: entry.kind, ledger: key };
  }

  return {
    resolver, ctx,
    probe, plan, apply, verify, restore, backups, audit, doctor, doctorAnchors,
    checkRestoreGate,
    // 最初基线
    baselineCapture: captureBaseline, baseline: baselineInfo, baselineRestore: restoreBaseline,
    // 专家档位
    captureProfile, planProfile, applyProfile, verifyProfile,
    profiles: () => listProfiles(storeRoot),
    profileDetail: (id) => readProfile(storeRoot, id),
    removeProfile: (id) => deleteProfile(storeRoot, id),
    // 版本重放（演进契约）
    captureBundle, checkDrift, replay,
    // P3 · 审批自动同意
    approvalState, planApproval, applyApproval, verifyApproval,
    // 总览
    overview,
  };
}
