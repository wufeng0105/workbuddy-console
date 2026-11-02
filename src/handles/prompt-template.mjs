/**
 * C 组提示词模板 —— 本项目第一个**版本定位 + 请求头部通道**的把手。
 *
 * 位置（实证）：`~/.workbuddy/plugins/cache/workbuddy-builtin/<plugin>/<版本>-wb.<build>.../prompt.tpl`
 *   - 版本目录带 build hash → **运行时才知道确切路径**（用 resolveTarget）
 *   - 升级即重建该目录 → `upgradeBehavior: 'invalidated'`
 *   - 请求**头部**通道 → 验证策略用**标记法**（trace grep），不是 token-delta
 *
 * ⚠️ 一条关键语义：`personal_files_safety` 只存在于**根模板** `prompt.tpl` 内
 *   （实测 6 个文件 = 3 个 welcomemode × 双版本缓存）。
 *   而 fragments（interaction.md 等）在别的插件目录下，属另一个把手（P2b）。
 *
 * ⚠️ 闸门：C 组模板能否**热改**尚未实测（待实测 #3）。
 *   在证实前，闸门用 `app-must-be-closed` 是**保守但安全**的选择：
 *   宁可要求"先关掉 WorkBuddy"，也不制造"写了不生效"的困惑。
 *   实测 #3 若证明可热改，再把闸门放宽 —— 这是数据演进，不改框架。
 */

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../core/backup.mjs';
import { diffLines, renderDiff } from '../core/diff.mjs';
import { AnchorMissingError } from '../core/errors.mjs';
import { markerStrategy, buildMarker } from '../verify/marker.mjs';

/** 注入判定用的标记前缀（足够独特，不会与自然文本碰撞） */
const MARKER_PREFIX = 'WBC-PROBE';

/**
 * @param {{
 *   id:string, title:string, plugin:string, fileName:string,
 *   modeLabel:string,
 * }} p
 */
export function createPromptTemplateHandle({ id, title, plugin, fileName }) {
  /**
   * 定位：`<cache builtin>/<plugin>/<最高版本目录>/<fileName>`
   * 版本目录必须唯一 —— 双版本并存时要挑"最高"，而不是随便一个。
   * @param {any} ctx
   */
  function targetOf(ctx) {
    const base = ctx.resolveOptional?.('plugins.cache.builtin');
    if (!base) {
      throw new AnchorMissingError('插件缓存目录锚点未命中（plugins.cache.builtin）', { anchor: 'plugins.cache.builtin' });
    }
    const pluginDir = path.join(base.path, plugin);
    if (!fs.existsSync(pluginDir)) {
      throw new AnchorMissingError(`插件未安装：${plugin}`, { plugin, dir: pluginDir });
    }

    // 只认形如 5.9.3-wb.<build>… 的版本目录
    const versions = fs.readdirSync(pluginDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+-/.test(e.name))
      .map((e) => e.name);
    if (versions.length === 0) {
      throw new AnchorMissingError(`插件 ${plugin} 下没有版本目录`, { plugin, dir: pluginDir });
    }

    const cmp = (a, b) => {
      const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
      const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
      for (let i = 0; i < 3; i += 1) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
      }
      return 0;
    };
    const active = [...versions].sort(cmp).at(-1);

    const abs = path.join(pluginDir, active, fileName);
    return {
      key: `plugins.cache.builtin/${plugin}/${active}/${fileName}`,
      path: abs,
      exists: fs.existsSync(abs),
      version: active,
      otherVersions: versions.filter((v) => v !== active),
    };
  }

  return {
    id,
    title,
    target: 'plugins.cache.builtin',
    writeClass: 'vendor-file',   // 插件缓存版本目录 → 逐次确认
    privilege: 'none',           // 用户目录，不需要提权
    channel: 'request-head',     // ★ 请求头部
    upgradeBehavior: 'invalidated',
    gate: 'app-must-be-closed',  // 保守：待实测 #3 证实可热改后再放宽
    /** next 就是整个模板文件的全文（见 engine.apply 的 noop 判定注释） */
    writesWholeFile: true,

    /** 头部通道 → 标记法（trace grep）；**禁止**用 token-delta 判头部 */
    verification: {
      strategy: 'marker-trace-grep',
      channel: 'request-head',
      baseline: '改动后用 WorkBuddy 发送一条消息，新 trace 里 grep 标记',
      assertion: `请求头部出现 ${MARKER_PREFIX} 标记即判定"进入请求"；未出现则需排除 trace 未落盘的情况`,
    },

    resolveTarget: targetOf,

    // ── 1. 探测 ────────────────────────────────────────────────
    async probe(ctx) {
      const t = targetOf(ctx);
      const exists = t.exists;
      const text = exists ? fs.readFileSync(t.path, 'utf8') : '';
      let writeAccess = false;
      if (exists) {
        try { fs.accessSync(t.path, fs.constants.W_OK); writeAccess = true; } catch { writeAccess = false; }
      }
      const hasPolicy = text.includes('<personal_files_safety>');
      return {
        path: t.path,
        exists,
        text,
        bytes: Buffer.byteLength(text, 'utf8'),
        sha256: exists ? sha256(Buffer.from(text, 'utf8')) : null,
        tokens: { tokens: null, chars: text.length, cjk: 0, other: text.length },
        version: t.version,
        otherVersions: t.otherVersions,
        writeAccess,
        hasPolicy,
        /** 提示：双版本并存时只改活跃版本 */
        versionNote: t.otherVersions.length
          ? `另有旧版本目录：${t.otherVersions.join(', ')}（不改它们）`
          : null,
      };
    },

    // ── 2. 差异预览 ────────────────────────────────────────────
    async preview(ctx, { next = '' } = {}) {
      const st = await this.probe(ctx);
      const diff = diffLines(st.text, next);
      const warnings = [];

      if (st.otherVersions.length) {
        warnings.push(`只改活跃版本 ${st.version}；旧版本目录保持原样。`);
      }
      if (!st.writeAccess) warnings.push('当前进程不可写该文件。');
      if (st.hasPolicy && !next.includes('<personal_files_safety>')) {
        warnings.push(
          '⚠️ **新内容里没有 `<personal_files_safety>` 段** —— 这会移除官方的个人文件安全条款'
          + '（No-Go Zones / Scan=Read-Only / 模糊先问）。'
          + '按 docs/product.md 的「放宽」档位，通常应**保留 No-Go Zones**、只去掉强制询问条款。',
        );
      }
      const appRunning = ctx.isWorkBuddyRunning?.();
      if (appRunning === true) warnings.push('WorkBuddy 正在运行：本把手要求在应用退出后写入。');

      return {
        path: st.path,
        willCreate: !st.exists,
        diff,
        diffText: renderDiff(diff),
        cost: { before: st.text.length, after: next.length, delta: next.length - st.text.length,
          cacheNote: '改的是请求**头部**：下一次请求该段全价重 warm（一次），之后自愈。' },
        /** 头部通道无法用 token 估增量，交给标记法 */
        expectedDeltaTokens: null,
        injectedChars: null,
        truncated: false,
        dropped: 0,
        warnings,
        bytesDelta: Buffer.byteLength(next, 'utf8') - st.bytes,
        version: st.version,
      };
    },

    // ── 4. 写入 ────────────────────────────────────────────────
    async apply(ctx, { next = '' } = {}) {
      const st = await this.probe(ctx);
      if (!st.exists) {
        throw new AnchorMissingError(`模板不存在：${st.path}`, { path: st.path });
      }
      if (!st.writeAccess) {
        throw new AnchorMissingError(`当前进程不可写：${st.path}`, { path: st.path });
      }
      fs.writeFileSync(st.path, next, 'utf8');
      return {
        path: st.path,
        bytes: Buffer.byteLength(next, 'utf8'),
        writeMode: 'replace',
        version: st.version,
        upgradeNote: '该文件在版本哈希目录内：WorkBuddy 升级会重建此目录，届时需重放。',
      };
    },

    // ── 5. 验证（标记法，不用 token-delta）──────────────────────
    async verify(ctx, args = {}) {
      const st = await this.probe(ctx);
      const marker = args.marker ?? MARKER_PREFIX;

      // 前置条件：**必须真的改过**。没改过却去 grep 标记，只会得到一个毫无意义的"未生效"。
      // 这不是"未生效"，是"根本没做过这件事"——按三态纪律必须判 undetermined。
      if (!args.marker && !args.afterMs) {
        const lastApply = (ctx.readAudit?.() ?? [])
          .filter((r) => r.event === 'apply' && r.handle === this.id).at(-1);
        if (!lastApply) {
          return {
            verdict: 'undetermined',
            reason: `这个把手还没有 apply 记录 —— 先改一次（并让 WorkBuddy 发一条消息），再验证。`
              + `若只是想知道当前模板长什么样，用 probe。`,
            handle: this.id,
            version: st.version,
            warnings: [],
          };
        }
        return markerStrategyAfter(ctx, this.id, st, marker, lastApply, args);
      }

      const r = await markerStrategy.verify({
        configRoot: ctx.configRoot,
        marker,
        afterMs: args.afterMs,
        sessionStartOf: args.sessionStartOf,
      });
      return {
        ...r,
        handle: this.id,
        currentBytes: st.bytes,
        version: st.version,
        warnings: [
          ...(r.warnings ?? []),
          ...(st.hasPolicy ? [] : ['当前模板里已没有 `<personal_files_safety>` 段。']),
        ],
        hint: `要验证是否进入请求：在模板里放一个标记 ${buildMarker(MARKER_PREFIX, 'xxx')}，`
          + '然后让 WorkBuddy 发一条消息，再运行 verify。',
      };
    },
  };
}

/**
 * 有 apply 记录时，按改动时间做标记法验证。
 *
 * ⚠️ 前置守卫（独立复核 [C15]/[C16] 抓出的 HIGH，违反铁律 6）：
 * 标记法的前提是"模板里含一个我们认识的标记 `WBC-PROBE…`"。
 * 但 **apply 从不注入标记** —— 用户正常编辑模板，写进去的是自己的内容。
 * 于是 verify 拿常量前缀去 grep，必然找不到 → 判 `ineffective`（未生效）。
 * 这是把"没测"说成"未生效"：用户明明改对了，工具说他没生效。
 *
 * 实测旁证：真实 6 个 prompt.tpl 全部 `hasMarker = False`。
 *
 * 处置：**模板里没有标记时，直接判 undetermined 并说清原因**，不去 grep 一个必然落空的东西。
 * （另一条路是 apply 时自动注入标记，但那会污染用户真实的模板内容，不采用。）
 */
async function markerStrategyAfter(ctx, handleId, st, marker, lastApply, args) {
  const hasMarker = typeof st.text === 'string' && st.text.includes(String(marker));

  if (!hasMarker && !args.marker) {
    return {
      verdict: 'undetermined',
      reason: '当前模板里**没有验证标记**（`WBC-PROBE…`）——标记法无法判定是否生效。'
        + '原因：apply 写入的是你的真实内容，不会自动注入标记。'
        + '若要做标记法验证，请手动在模板里放一个 `WBC-PROBE-test` 之类的标记，'
        + '再让 WorkBuddy 发一条消息，然后重跑 verify。'
        + '（这不代表改动没生效——只代表"用这个策略测不出来"。）',
      handle: handleId,
      currentBytes: st.bytes,
      version: st.version,
      markerMissing: true,
      warnings: [
        '这是**无法判定**，不是"未生效"——不要据此回滚改动。',
        ...(st.hasPolicy ? [] : ['当前模板里已没有 `<personal_files_safety>` 段。']),
      ],
      hint: `标记格式：${buildMarker(MARKER_PREFIX, 'test')}`,
    };
  }

  const afterMs = Date.parse(lastApply.at);
  const r = await markerStrategy.verify({
    configRoot: ctx.configRoot,
    marker,
    afterMs: Number.isFinite(afterMs) ? afterMs : undefined,
    sessionStartOf: args.sessionStartOf,
  });
  return {
    ...r,
    handle: handleId,
    currentBytes: st.bytes,
    version: st.version,
    afterMs: Number.isFinite(afterMs) ? lastApply.at : null,
    warnings: [
      ...(r.warnings ?? []),
      ...(st.hasPolicy ? [] : ['当前模板里已没有 `<personal_files_safety>` 段。']),
    ],
  };
}
