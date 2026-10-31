/**
 * `personal_files_safety` 段落手术 —— P3「审批自动同意」的**提示词面**。
 *
 * 背景（实测原文，8 条规则）：
 *   1 No-Go Zones        —— 厂商红线（禁递归删除家目录/系统目录）
 *   2 Scan = Read-Only   —— **强制询问来源**
 *   3 Vague = Ask First  —— **强制询问来源**
 *   4 Warn + List + Confirm —— **强制询问来源**
 *   5 Back Up First      —— 安全网
 *   6 Trash, Not Delete  —— 安全网
 *   7 Small Batches      —— 安全网
 *   8 No Script Files    —— 编码坑（Windows 非 ASCII 路径）
 *
 * 设计原则：**分级放宽，不是无差别删除**
 *   - 放宽只针对"强制询问"三条（2/3/4）
 *   - 红线（1）与安全网（5/6/7/8）默认保留
 *   - 理由：把 1 去掉等于允许它递归删家目录；把 6 去掉等于允许 rm 而不是进回收站。
 *     那不是"审批自动同意"，那是"自毁开关"。
 *
 * 全部操作都是**文本级手术**，且幂等：重复执行同一档位不会叠加修改。
 */

/** 按**规则正文特征**识别语义 —— 不能用编号，因为放宽后会重新编号 */
const SEMANTICS_BY_TEXT = Object.freeze([
  { re: /No-Go Zones/i, key: 'no-go-zones', kind: 'redline', label: 'No-Go Zones（禁递归删除家目录/系统目录）' },
  { re: /Scan = Read-Only/i, key: 'scan-readonly', kind: 'ask', label: 'Scan = Read-Only（扫描只出报告）' },
  { re: /Vague = Ask First/i, key: 'vague-ask', kind: 'ask', label: 'Vague = Ask First（模糊指令先问）' },
  { re: /Warn \+ List \+ Confirm/i, key: 'warn-confirm', kind: 'ask', label: 'Warn + List + Confirm（破坏性操作先确认）' },
  { re: /Back Up First/i, key: 'backup-first', kind: 'safety', label: 'Back Up First（先备份）' },
  { re: /Trash, Not Delete/i, key: 'trash-not-delete', kind: 'safety', label: 'Trash, Not Delete（进回收站而非 rm）' },
  { re: /Small Batches/i, key: 'small-batches', kind: 'safety', label: 'Small Batches（每批最多 10 个）' },
  { re: /No Script Files/i, key: 'no-script-files', kind: 'safety', label: 'No Script Files（Windows 非 ASCII 路径）' },
]);

/**
 * 按正文识别一条规则的语义。
 * @param {string} ruleText
 */
export function classifyRule(ruleText) {
  for (const s of SEMANTICS_BY_TEXT) {
    if (s.re.test(ruleText)) return { key: s.key, kind: s.kind, label: s.label };
  }
  return { key: 'unknown', kind: 'unknown', label: '(未识别)' };
}

/** 规则编号 → 语义分类（仅用于"原厂顺序"的展示；判定一律走 classifyRule） */
export const RULE_SEMANTICS = Object.freeze({
  1: { key: 'no-go-zones', kind: 'redline', label: 'No-Go Zones（禁递归删除家目录/系统目录）' },
  2: { key: 'scan-readonly', kind: 'ask', label: 'Scan = Read-Only（扫描只出报告）' },
  3: { key: 'vague-ask', kind: 'ask', label: 'Vague = Ask First（模糊指令先问）' },
  4: { key: 'warn-confirm', kind: 'ask', label: 'Warn + List + Confirm（破坏性操作先确认）' },
  5: { key: 'backup-first', kind: 'safety', label: 'Back Up First（先备份）' },
  6: { key: 'trash-not-delete', kind: 'safety', label: 'Trash, Not Delete（进回收站而非 rm）' },
  7: { key: 'small-batches', kind: 'safety', label: 'Small Batches（每批最多 10 个）' },
  8: { key: 'no-script-files', kind: 'safety', label: 'No Script Files（Windows 非 ASCII 路径）' },
});

export const LEVELS = Object.freeze(['off', 'relaxed', 'aggressive']);

export const LEVEL_DESC = Object.freeze({
  off: '原厂：8 条全保留',
  relaxed: '放宽：去掉 3 条强制询问（2/3/4），保留红线与全部安全网',
  aggressive: '激进：去掉 3 条强制询问 + 3 条安全网（5/6/7），**只保留**红线（1）与编码坑（8）',
});

const BLOCK_RE = /<personal_files_safety>[\s\S]*?<\/personal_files_safety>/;
const RULE_LINE_RE = /^(\d+)\.\s+\*\*/gm;

/** @param {string} text */
export function hasBlock(text) {
  return typeof text === 'string' && BLOCK_RE.test(text);
}

/** @param {string} text */
export function extractBlock(text) {
  const m = BLOCK_RE.exec(text ?? '');
  return m ? m[0] : null;
}

/**
 * 解析块内的规则（编号 + 原文整段）。
 * 注意：块开头可能有 header 行（`**CRITICAL:**` 等），不能让第 1 条规则把它吞掉。
 * @param {string} block
 * @returns {{num:number, text:string, semantics:any}[]}
 */
export function parseRules(block) {
  if (!block) return [];
  const inner = block.replace(/^<personal_files_safety>/, '').replace(/<\/personal_files_safety>$/, '');
  const marks = [];
  let m;
  const re = /^(\d+)\.\s+\*\*/gm;
  re.lastIndex = 0;
  while ((m = re.exec(inner)) !== null) {
    marks.push({ num: Number(m[1]), start: m.index, lineStart: m.index });
  }
  const out = [];
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i].start;
    const end = i + 1 < marks.length ? marks[i + 1].start : inner.length;
    out.push({
      num: marks[i].num,
      text: inner.slice(start, end).trimEnd(),
      semantics: classifyRule(inner.slice(start, end)),
    });
  }
  return out;
}

/**
 * 取块内规则之前的 header（`**CRITICAL:**` / `**Trigger:**` 等），重建时要原样保留。
 * ⚠️ 必须**去掉首尾空行**：否则每次重建都会多吞/多吐一个换行，
 *    导致"重复应用同一档位"产生累积漂移（幂等失效）。
 * @param {string} block
 */
export function extractHeader(block) {
  if (!block) return '';
  const inner = block.replace(/^<personal_files_safety>/, '').replace(/<\/personal_files_safety>$/, '');
  const firstRule = inner.search(/^\d+\.\s+\*\*/m);
  const head = firstRule < 0 ? inner : inner.slice(0, firstRule);
  return head.replace(/^\n+/, '').replace(/\n+$/, '');
}

/**
 * 某档位要**去掉**哪些规则语义 key。
 * ⚠️ 用语义 key 而不是编号 —— 放宽后会重新编号，按编号删第二次就会删错。
 * @param {'off'|'relaxed'|'aggressive'} level
 * @returns {string[]}
 */
export function keysToDrop(level) {
  if (level === 'off') return [];
  if (level === 'relaxed') return ['scan-readonly', 'vague-ask', 'warn-confirm'];
  if (level === 'aggressive') return ['scan-readonly', 'vague-ask', 'warn-confirm', 'backup-first', 'trash-not-delete', 'small-batches'];
  throw new Error(`未知档位：${level}`);
}

/**
 * @param {'off'|'relaxed'|'aggressive'} level
 * @returns {number[]} 原厂编号（仅供展示；实际删除按 keysToDrop）
 */
export function rulesToDrop(level) {
  const keys = keysToDrop(level);
  return Object.entries(RULE_SEMANTICS)
    .filter(([, v]) => keys.includes(v.key))
    .map(([k]) => Number(k))
    .sort((a, b) => a - b);
}

/**
 * 重新编号（去掉规则后保持 1..N 连续，否则模型看到的编号会跳）。
 * @param {{num:number, text:string}[]} rules
 */
function renumber(rules) {
  return rules.map((r, i) => ({ ...r, num: i + 1, text: String(r.text).replace(/^\d+\./, `${i + 1}.`) }));
}

/**
 * 把档位应用到整篇文本。**幂等**：同一档位重复应用不会再变。
 *
 * @param {string} text 整篇 prompt.tpl
 * @param {'off'|'relaxed'|'aggressive'} level
 * @returns {{text:string, changed:boolean, dropped:number[], kept:number[], before:number[], warnings:string[]}}
 */
export function applyLevel(text, level) {
  if (!LEVELS.includes(level)) throw new Error(`未知档位：${level}`);
  const block = extractBlock(text);
  if (!block) {
    return {
      text, changed: false, dropped: [], kept: [], before: [],
      warnings: ['当前文本里没有 `<personal_files_safety>` 段 —— 无法应用档位（可能已被删除或结构变了）'],
    };
  }

  const rules = parseRules(block);
  const before = rules.map((r) => r.num);
  const dropKeys = new Set(keysToDrop(level));
  const kept = rules.filter((r) => !dropKeys.has(r.semantics.key));
  const dropped = rules.filter((r) => dropKeys.has(r.semantics.key));
  const warnings = [];

  // 红线守卫：**处理之后**仍须存在红线。
  // 若处理前就没有红线（模板已被改坏），那是另一个问题 —— 应报错让人知道，
  // 而不是静默"保住"一个不存在的红线。
  const hadRedline = rules.some((r) => r.semantics.kind === 'redline');
  if (!hadRedline) {
    throw new Error(
      '拒绝：当前文本里没有厂商红线（No-Go Zones）—— 模板可能已被改坏。'
      + '请先用 restore 还原，或检查 C 组模板锚点是否指错了文件。',
    );
  }
  if (!kept.some((r) => r.semantics.kind === 'redline')) {
    throw new Error('拒绝：该档位会去掉厂商红线（No-Go Zones），这是不允许的');
  }
  const header = extractHeader(block);
  const rebuilt = [
    ...(header ? header.split('\n') : []),
    ...(kept.length ? renumber(kept).map((r) => r.text) : []),
  ].join('\n');

  const nextText = text.replace(BLOCK_RE, `<personal_files_safety>\n${rebuilt}\n</personal_files_safety>`);
  if (level === 'aggressive') {
    warnings.push(
      '激进档去掉了「先备份」「进回收站」「小批量」三条安全网 —— '
      + '模型可能直接删除而不留退路。工具自身的备份不能保护 WorkBuddy 执行的文件操作。',
    );
  }
  if (level !== 'off') {
    warnings.push(
      '⚠️ **这条改动是否真的能治住"模型在回答里自己问"，尚未实证**（待实测 #4）。'
      + '规则面的放宽是可靠的；提示词面只能"降低概率"，无法保证 —— 若它问是出于模型自身对齐，改了也没用。',
    );
  }

  return {
    text: nextText,
    changed: nextText !== text,
    /** 原厂编号（供展示） */
    dropped: dropped.map((r) => r.num),
    /** 语义 key（判定与幂等用） */
    droppedKeys: dropped.map((r) => r.semantics.key),
    kept: kept.map((r) => r.num),
    keptKeys: kept.map((r) => r.semantics.key),
    before,
    warnings,
  };
}

/**
 * 识别一段文本当前处于哪个档位（用于幂等判定与界面呈现）。
 * @param {string} text
 */
export function detectLevel(text) {
  const block = extractBlock(text);
  if (!block) return { level: 'unknown', kept: [], reason: '没有 personal_files_safety 段' };
  const rules = parseRules(block);
  const keys = rules.map((r) => r.semantics.key);
  const ask = ['scan-readonly', 'vague-ask', 'warn-confirm'];
  const safety = ['backup-first', 'trash-not-delete', 'small-batches'];

  if (!keys.includes('no-go-zones')) return { level: 'unknown', kept: keys, reason: '厂商红线缺失' };

  const askLeft = ask.filter((k) => keys.includes(k));
  const safetyLeft = safety.filter((k) => keys.includes(k));
  if (askLeft.length === 3 && safetyLeft.length === 3) return { level: 'off', kept: keys };
  if (askLeft.length === 0 && safetyLeft.length === 3) return { level: 'relaxed', kept: keys };
  if (askLeft.length === 0 && safetyLeft.length === 0) return { level: 'aggressive', kept: keys };
  return { level: 'custom', kept: keys, reason: '不是预置档位（可能手工改过）' };
}
