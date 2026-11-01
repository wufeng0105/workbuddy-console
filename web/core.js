/**
 * workbuddy-console · 前端核心
 * 令牌、API、DOM 工具、常量。无框架、无构建。
 */

// 令牌从 URL 读一次，**立刻从地址栏抹掉**。
// 为什么：?token= 会留在浏览器历史、可能被截图/分享/扩展读到。
// 读进内存后用 history.replaceState 清掉，刷新时从 sessionStorage 恢复。
// 这只是降低暴露面，不是加密——本地工具，威胁模型就是"别让令牌随手可见"。
const TOKEN = (() => {
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    try { sessionStorage.setItem('wbc-token', fromUrl); } catch { /* 隐私模式忽略 */ }
    const u = new URL(location.href);
    u.searchParams.delete('token');
    history.replaceState(null, '', u.pathname + (u.search === '?' ? '' : u.search) + u.hash);
    return fromUrl;
  }
  try { return sessionStorage.getItem('wbc-token') ?? ''; } catch { return ''; }
})();

export function hasToken() { return TOKEN.length > 0; }

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: {
      'X-WBC-Token': TOKEN,
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { throw new Error(`HTTP ${res.status}`); }
  if (!res.ok || !json.ok) {
    const e = new Error(json?.error?.message ?? `HTTP ${res.status}`);
    e.code = json?.error?.code;
    e.detail = json?.error?.detail;
    throw e;
  }
  return json.data;
}

/* ── DOM ─────────────────────────────────────────────────── */

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, String(v));
  }
  appendKids(n, kids);
  return n;
}
function appendKids(n, kids) {
  for (const k of kids.flat(9)) {
    if (k === null || k === undefined || k === false || k === '') continue;
    n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export const $ = (id) => document.getElementById(id);
export const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* ── 格式化 ───────────────────────────────────────────────── */

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export const fmtNum = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—');

/* ── 常量 ─────────────────────────────────────────────────── */

/** 把手按"心智"分组，不按数据结构 */
export const GROUPS = [
  { key: 'identity', title: '身份与人格', prefix: 'personalization.', note: '用户目录 · 零提权 · 升级存活' },
  { key: 'style', title: '风格内容', prefix: 'style.', note: '安装目录 · 原厂参考件 · 升级可能覆盖' },
  { key: 'prompt', title: '提示词模板', prefix: 'prompt.', note: '请求头部通道 · 标记法验证' },
  { key: 'rules', title: '行为规则', prefix: 'rules.', note: '结构化操作 · 需重启生效' },
];

export function groupOf(h) {
  return GROUPS.find((g) => h.id.startsWith(g.prefix)) ?? { key: 'other', title: '其他', note: '' };
}

export const VERDICT = {
  effective: { label: '生效', mark: '✓' },
  ineffective: { label: '未生效', mark: '✕' },
  undetermined: { label: '无法判定', mark: '?' },
};

export const EVENT_META = {
  apply: { label: '写入', mark: '✎' },
  'apply-profile': { label: '切换档位', mark: '◐' },
  'apply-approval': { label: '应用审批档', mark: '⚙' },
  verify: { label: '验证', mark: '✓' },
  'verify-profile': { label: '验证档位', mark: '✓' },
  'verify-approval': { label: '验证审批', mark: '✓' },
  restore: { label: '还原', mark: '↩' },
  replay: { label: '重放', mark: '⟳' },
};

/** 边界清单 —— 产品"诚实说做不到"的地方，这是核心价值之一 */
export const BOUNDARY = [
  {
    id: 'upstream-filter', title: '流式内容过滤', layer: '上游 · 网关',
    why: '服务端在流式输出中做 token 级过滤：模型已正常生成的内容会被拦腰切断，且 usage 清零。',
    evidence: 'gateway.md E 组实测：L1–L3 放行，L4 触发 content_filter',
    can: false,
  },
  {
    id: 'model-align', title: '模型自身对齐', layer: '上游 · 模型',
    why: '模型拒绝时会直接不给内容，而不是"先输出再切断"。这与网关过滤是两回事。',
    evidence: 'finish_reason 与输出形态可区分二者',
    can: false,
  },
  {
    id: 'managed', title: '托管策略覆盖', layer: '上游 · 服务端下发',
    why: '服务端在产品配置里下发 securityCenter 块时，会覆盖本地规则矩阵与审批开关。',
    evidence: 'toManagedOrderedRules / assistedApprovalDisabled',
    can: false,
  },
  {
    id: 'truncation', title: '身份文件 10 000 字符截断', layer: '客户端 · 注入前',
    why: 'SOUL/USER/IDENTITY 在注入前逐文件截断到 10 000 字符，超出部分静默丢弃 —— 文件写了 ≠ 模型看到了。',
    evidence: 'authority-snapshot.js:53 Ls=1e4 + :184 truncateContent',
    can: true,
    how: '工具会在编辑时告警，并按截断后文本计算期望增量。',
  },
  {
    id: 'expert-identity', title: '专家模式跳过 IDENTITY.md', layer: '客户端 · 模式分支',
    why: '切到专家档位时，IDENTITY.md 不读不注入 —— "名字"会静默消失。SOUL/USER 两模式都注入。',
    evidence: 'authority-snapshot.js:184 t.isExpert || …',
    can: true,
    how: '该把手会标注模式条件。',
  },
  {
    id: 'model-ask', title: '提示词能否治住"模型自己问"', layer: '未知 · 待实测',
    why: '改提示词只能降低"模型在回答里自己问"的概率，无法保证 —— 若来自模型自身对齐，改了也没用。',
    evidence: '待实测 #4',
    can: false,
  },
];
