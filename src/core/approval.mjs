/**
 * P3 · 审批自动同意 —— 把规则面与提示词面**编排成一个动作**。
 *
 * 用户意图是"别再问我了"，但实现上必须落到两处：
 *   ① 规则面：`sandbox.orderedRules` 把 ask 提升为 allow（否则工具调用被弹窗拦）
 *   ② 提示词面：`personal_files_safety` 去掉强制询问条款（否则模型在回答里自己问）
 *
 * ⚠️ **诚实边界（本模块存在的核心）**：
 *   ① 规则面可靠 —— 有重启后回读验证兜底。
 *   ② 提示词面**只能降低概率，无法保证**。若"模型问"来自模型自身对齐（上游），改了也没用。
 *   这条尚未实证（待实测 #4）。因此 verdict 必须能表达"一半确定、一半不确定"。
 *
 * 所以本模块**不返回单一 verdict**，而是返回逐面（per-face）结论 + 一个总体结论：
 *   - 全部成立 → effective
 *   - 有面成立、有面不确定 → undetermined（并指明是哪一面）
 *   - 规则面被还原 → ineffective
 */

import { applyLevel, detectLevel, LEVELS, LEVEL_DESC, rulesToDrop } from './safety-block.mjs';
import { ConsoleError } from './errors.mjs';

/** 预设档位：从"别再问"的三个强度档 */
export const APPROVAL_LEVELS = Object.freeze([
  {
    id: 'off',
    title: '原厂（什么都会问）',
    ruleOp: null,
    promptLevel: 'off',
    desc: '不做任何改动：规则面保持原样，提示词面 8 条全保留。',
  },
  {
    id: 'relaxed',
    title: '放宽（推荐）：写入不再问，删除仍确认',
    ruleOp: { from: 'ask', to: 'allow', actions: ['read', 'write'] },
    promptLevel: 'relaxed',
    desc: '规则面：把 read/write 的 49 条 ask 放开，**delete 仍走 ask**（保留删除确认）。'
      + '提示词面：去掉 Scan/Vague/Warn 三条强制询问，保留红线与全部安全网。',
  },
  {
    id: 'full',
    title: '完全放开：读写删都不问',
    ruleOp: { from: 'ask', to: 'allow', actions: ['read', 'write', 'delete'] },
    promptLevel: 'aggressive',
    desc: '规则面：三动作全放开。提示词面：去掉强制询问 + 三条安全网（先备份/进回收站/小批量）。'
      + '**这一步之后，模型的删除操作既不会问你，也不会自己留备份。**',
  },
]);

/** @param {string} id */
export function findApprovalLevel(id) {
  const lv = APPROVAL_LEVELS.find((x) => x.id === id);
  if (!lv) {
    throw new ConsoleError('INVALID_VALUE', `未知档位：${id}`, {
      valid: APPROVAL_LEVELS.map((x) => x.id),
    });
  }
  return lv;
}

/**
 * 只读预览：两个面各要改什么，以及"哪些是可靠的、哪些是不确定的"。
 * @param {{level:string, rulesProbe:any, promptText:string, promptTitle?:string}} p
 */
export function previewApproval({ level, rulesProbe, promptText, promptTitle }) {
  const lv = findApprovalLevel(level);
  const faces = [];

  // ── 面 1：规则 ──
  if (lv.ruleOp) {
    const rules = rulesProbe?.rules ?? [];
    const acts = lv.ruleOp.actions;
    const hits = rules.filter((r) => acts.some((a) => r[a] === lv.ruleOp.from));
    faces.push({
      face: 'rules',
      title: '规则面（宿主弹窗审批）',
      certainty: 'reliable',
      changed: hits.length,
      detail: `${acts.join('/')} = ask → allow，命中 ${hits.length} 条`,
      samples: hits.slice(0, 10).map((r) => r.path),
      verify: 'restart-readback（可可靠验证）',
      note: '这一面有重启后回读兜底，结论可信。',
    });
  } else {
    faces.push({
      face: 'rules',
      title: '规则面（宿主弹窗审批）',
      certainty: 'noop',
      changed: 0,
      detail: '不改（原厂档）',
    });
  }

  // ── 面 2：提示词 ──
  const applied = applyLevel(promptText ?? '', lv.promptLevel);
  const current = detectLevel(promptText ?? '');
  faces.push({
    face: 'prompt',
    title: '提示词面（模型自己问"要不要先扫描"）',
    certainty: 'uncertain',
    changed: applied.changed ? applied.dropped.length : 0,
    detail: applied.changed
      ? `去掉第 ${applied.dropped.join('/')} 条，保留第 ${applied.kept.join('/')} 条（现档位：${current.level} → ${lv.promptLevel}）`
      : `无需改动（现档位已是 ${current.level}）`,
    droppedRules: applied.dropped,
    verify: 'marker-trace-grep（只能证明"文本进了请求"，**证明不了"模型不再问"**）',
    note: '⚠️ 这一面**无法保证**：若"模型问"来自模型自身对齐，改提示词无效。',
    warnings: applied.warnings,
  });

  return {
    level: lv.id,
    title: lv.title,
    desc: lv.desc,
    faces,
    /** 总体判定：只要有 uncertain 面，就不可能是"完全可靠" */
    maxCertainty: faces.some((f) => f.certainty === 'uncertain') && faces.some((f) => f.certainty === 'reliable')
      ? 'partial'
      : faces.every((f) => f.certainty === 'noop') ? 'noop' : 'partial',
  };
}

/**
 * 汇总两面的验证结论为**一个诚实的三态**。
 * 规则：只要有一面未生效 → ineffective；否则只要有面无法判定 → undetermined；全成立才 effective。
 * @param {{ruleVerdict?:string, promptVerdict?:string, ruleChanged:boolean, promptChanged:boolean}} p
 */
export function combineVerdicts({ ruleVerdict, promptVerdict, ruleChanged, promptChanged }) {
  const parts = [];
  if (ruleChanged) parts.push({ face: '规则面', verdict: ruleVerdict });
  if (promptChanged) parts.push({ face: '提示词面', verdict: promptVerdict });

  /**
   * ⚠️ `parts.length === 0` **不是「已生效」**（残余 R3c，2026-11-03 修）。
   *
   * 原实现：`off` 档没有任何面需要改，直接
   * `return { verdict: 'effective', reason: '没有需要改动的面（原厂档）' }`。
   * 于是**用户从没 apply 过任何东西**也会看到绿色「✅ 生效」、退出码 0。
   *
   * 为什么错：`off` 档确实"不需要改动"，但用户点「验证」问的是
   * **「我现在的状态是不是原厂状态」**——而这段代码**从来没检查过**当前规则是不是原厂那 135 条。
   * 它把「无事可做」答成了「已生效」，正是铁律 6 禁止的那一种：**把「没测」说成「通过」**。
   *
   * 为什么不改成"真去回读当前规则、与出厂值对照"：那需要一个**出厂状态**参照系，
   * 而最初基线账本存的是**用户捕获那一刻**的状态，不是出厂——拿它当出厂会造出新的假确定。
   * 所以如实判 `undetermined`，并给出**可行动的下一步**。
   */
  if (parts.length === 0) {
    return {
      verdict: 'undetermined',
      reason: '这个档位没有需要改动的面（原厂档），因此没有可验证的改动。'
        + '注意：这**不代表**你当前就是原厂状态——本次没有读过规则，也就没有证据。'
        + '要确认现状，请 `node src/cli.mjs probe rules.file`（看当前规则）'
        + ' 与 `node src/cli.mjs baseline`（看最初基线记录的条目）自行对照。',
      parts,
    };
  }
  if (parts.some((p) => p.verdict === 'ineffective')) {
    const bad = parts.filter((p) => p.verdict === 'ineffective').map((p) => p.face);
    return {
      verdict: 'ineffective',
      reason: `${bad.join('、')}未生效`,
      parts,
    };
  }
  if (parts.some((p) => p.verdict !== 'effective')) {
    const unknown = parts.filter((p) => p.verdict !== 'effective').map((p) => p.face);
    return {
      verdict: 'undetermined',
      reason: `${unknown.join('、')}无法判定 —— 其余面已成立，但整体不能算完成。`
        + '提示词面即使文本进了请求，也**无法证明模型不再自己问**（待实测 #4）。',
      parts,
    };
  }
  return {
    verdict: 'effective',
    reason: '两个面都成立。注意：提示词面的"生效"只表示文本进入了请求，'
      + '**不表示模型一定不再问**——那取决于模型自身对齐，需实际使用观察。',
    parts,
  };
}

export { LEVELS, LEVEL_DESC, rulesToDrop };
