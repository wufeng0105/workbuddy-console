/**
 * 残余表机检（残余 R45 的"机械半边"）。
 *
 * 为什么存在：`DOC-OUTLINE.md` 的「已知残余」是本工程**唯一登记处**，
 * 但状态词全靠人改 —— 已经连续漏改两次（R9/R8 由独立审计抓出；R27/R28/R29/R31 由 Lead 复核发现）。
 * 一旦状态词过期，这张表的全部结论都不可信。
 *
 * 能机械化的部分（本脚本）：表格结构、编号唯一且连续、已兑现必须给出可复核的凭据、
 * 跨篇引用的编号都有定义。**"状态词符不符实"机械不了**（那要靠纪律与独立复核），
 * 所以本脚本的通过**不等于**表是对的——它只挡住"结构性地不可信"。
 *
 * 用法：node scripts/check-residuals.mjs [DOC-OUTLINE.md]
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const FILE = process.argv[2] ?? 'DOC-OUTLINE.md';
const abs = path.isAbsolute(FILE) ? FILE : path.join(REPO, FILE);
const text = fs.readFileSync(abs, 'utf8');
/**
 * ⚠️ 必须按 `\r?\n` 切并且**去掉行尾的 `\r`**：本仓库的文档是 CRLF。
 * 第一版写 `split('\n')`，每行尾部留着 `\r`，而 `.` 不匹配 `\r`、`$` 又不认它 ⇒
 * 带内容的行**整批匹配不上**（46 行只解析出 5 行），机检自己变成了空转。
 */
const lines = text.split(/\r?\n/).map((l) => l.replace(/\r$/, ''));

const failures = [];
const fail = (msg) => failures.push(msg);

// ── ① 解析残余表 ─────────────────────────────────────────────
const rows = [];
for (let i = 0; i < lines.length; i += 1) {
  const m = /^\|\s*(R\d+b?)\s*\|/.exec(lines[i]);
  if (!m) continue;
  /**
   * ⚠️ 数单元格前必须先把**转义竖线** `\|` 换掉：那是单元格**内容**，不是分隔符。
   * 第一版直接 `split('|')`，于是 R15（它的复核命令里含 `\|`）被误报"6 列"。
   */
  const cells = lines[i].replace(/\\\|/g, '\u0000').split('|').slice(1, -1).map((c) => c.trim());
  rows.push({ id: m[1], line: i + 1, cells });
}

if (rows.length === 0) fail('没有解析到任何残余行 —— 表头格式变了？');

// ── ② 每行五列 ───────────────────────────────────────────────
for (const r of rows) {
  if (r.cells.length !== 5) fail(`${r.id}（第 ${r.line} 行）列数应为 5，实际 ${r.cells.length} —— 表格结构被破坏`);
}

// ── ③ 编号唯一 ───────────────────────────────────────────────
const seen = new Map();
for (const r of rows) {
  if (seen.has(r.id)) fail(`${r.id} 出现了两次（第 ${seen.get(r.id)} 行与第 ${r.line} 行）—— 编号必须唯一`);
  seen.set(r.id, r.line);
}

// ── ④ 数字编号连续（`b` 后缀是同一条的补充说明，不占号）────────
const nums = [...new Set(rows.map((r) => Number(/^R(\d+)/.exec(r.id)[1])))].sort((a, b) => a - b);
const max = nums.at(-1);
const missing = [];
for (let i = 1; i <= max; i += 1) if (!nums.includes(i)) missing.push(`R${i}`);
if (missing.length) fail(`编号不连续，缺：${missing.join('、')} —— 要么补上，要么说明为什么跳号`);

// ── ⑤ 状态词与凭据 ───────────────────────────────────────────
/**
 * 允许的状态词。
 *
 * 文档原本声明"只有三个"（未兑现 / 已兑现 / 不可判），但表长到 46 条以后出现了三类新情况，
 * 三个词表达不了，硬塞进去会丢信息：
 *   · 已裁定：差距**存在**，但我们**决定不修**（知情接受 / 平台边界 / 不是缺陷）——
 *     它既不是"未兑现"（那会像是待办），也不是"不可判"（那会说成验不了）；
 *   · 部分兑现：一条残余里只有一半被治住（例如 R45 的机械半边做了、纪律半边没做）；
 *   · 潜伏：这条路用户**走不到**（本机不可达），所以不排期——不同于"验不了"。
 * 词表扩大**不是放宽**：每个词都有明确含义，含糊话仍然会被拒。
 */
const KNOWN = ['未兑现', '已兑现', '不可判', '已裁定', '部分兑现', '潜伏'];
for (const r of rows) {
  const status = (r.cells[2] ?? '').replace(/\*\*/g, '').trim();
  if (!status) { fail(`${r.id} 没有状态词`); continue; }
  const head = KNOWN.find((k) => status.startsWith(k));
  if (!head) {
    fail(`${r.id} 的状态词「${status}」不在允许集里（${KNOWN.join(' / ')}）—— 状态词只有这几个，别的都是含糊话`);
    continue;
  }
  const evidence = r.cells[4] ?? '';
  /**
   * `已兑现` 的意思就是"有一条会变红的断言或一条能跑的命令"。
   * 所以这一行**必须**给出可复核的凭据（反引号里的命令 / 断言名），否则就是空口声明。
   */
  if (head === '已兑现' && !/`[^`]+`/.test(evidence)) {
    fail(`${r.id} 标了「已兑现」，但凭据栏没有可复核的命令或断言名（反引号里的那种）—— 「已兑现」的意思是"有会变红的断言"`);
  }
}

// ── ⑥ 跨篇引用的编号必须有定义 ───────────────────────────────
const docs = ['DOC-OUTLINE.md', 'AGENTS.md', 'README.md', 'docs/product.md', 'docs/framework.md',
  'docs/verification.md', 'docs/handles.md', 'docs/recon-amendments.md', 'docs/ledger.md',
  'web/README.md', 'src/README.md'];
const defined = new Set(rows.map((r) => r.id));
const referenced = new Set();
for (const d of docs) {
  const p = path.join(REPO, d);
  if (!fs.existsSync(p)) continue;
  for (const m of fs.readFileSync(p, 'utf8').matchAll(/\bR(\d{1,2})b?\b/g)) {
    referenced.add(`R${m[1]}`);
    if (m[0].endsWith('b') ) referenced.add(m[0]);
  }
}
const unknown = [...referenced].filter((id) => !defined.has(id) && !defined.has(`${id}b`));
if (unknown.length) fail(`这些编号被引用了却没有定义：${unknown.sort().join('、')}`);

// ── 报告 ────────────────────────────────────────────────────
const okCount = rows.filter((r) => (r.cells[2] ?? '').replace(/\*\*/g, '').trim().startsWith('已兑现')).length;
console.log(`残余表机检（${FILE}）`);
console.log(`  条目 ${rows.length}（已兑现 ${okCount}）｜编号连续到 R${max}｜跨篇引用 ${referenced.size} 个`);
if (failures.length) {
  console.log(`\n❌ 不通过 ${failures.length} 条：`);
  for (const f of failures) console.log(`   · ${f}`);
  console.log('\n注：本脚本通过**不等于**残余表是对的 —— "状态词与实际是否相符"机械不了（残余 R45）。');
  process.exit(1);
}
console.log('  ✅ 结构、编号、状态词、凭据、跨篇引用全部合规');
console.log('  注：这只保证表**结构性地可信**；"状态词与实际是否相符"要靠纪律与独立复核（残余 R45）。');
