/**
 * 原型共享数据层 —— 真实调用本地 /api/*，不造假数据。
 *
 * 【THROWAWAY】这是 UI 原型，用于在三种结构之间做选择。选完即弃。
 * 不接真实写操作（只读），避免误改配置。
 */

const TOKEN = new URLSearchParams(location.search).get('token') ?? '';

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: {
      'X-WBC-Token': TOKEN,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { throw new Error(`HTTP ${res.status}`); }
  if (!res.ok || !json.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
  return json.data;
}

/** 一次拉齐原型需要的全部只读数据 */
export async function loadAll() {
  const [overview, approval, profiles] = await Promise.all([
    api('/api/overview').catch((e) => ({ error: e.message })),
    api('/api/approval').catch((e) => ({ error: e.message })),
    api('/api/profiles').catch(() => []),
  ]);
  const handles = overview?.health
    ? await api('/api/doctor').then((d) => d.handles).catch(() => [])
    : [];
  return { overview, approval, profiles, handles };
}

/* ── 小工具 ─────────────────────────────────────────────── */

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(9)) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** 把手按"心智分组"，不是按 type */
export const GROUPS = [
  { key: 'identity', title: '身份与人格', match: (h) => h.id.startsWith('personalization.'), risk: 'user', note: '用户目录 · 零提权 · 升级存活' },
  { key: 'style', title: '风格内容', match: (h) => h.id.startsWith('style.'), risk: 'vendor', note: '安装目录 · 需确认 · 升级疑失效' },
  { key: 'prompt', title: '提示词模板', match: (h) => h.id.startsWith('prompt.'), risk: 'vendor', note: '请求头部通道 · 标记法验证' },
  { key: 'rules', title: '行为规则', match: (h) => h.id.startsWith('rules.'), risk: 'user', note: '结构化操作 · 需重启生效' },
];

export function groupOf(h) {
  return GROUPS.find((g) => g.match(h)) ?? { key: 'other', title: '其他', risk: 'user', note: '' };
}

export const VERDICT = {
  effective: { label: '生效', color: 'var(--ok)' },
  ineffective: { label: '未生效', color: 'var(--bad)' },
  undetermined: { label: '无法判定', color: 'var(--warn)' },
};

export const rfmt = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function elById(id) { return document.getElementById(id); }

/** 底部变体切换条（prototype skill 要求） */
export function mountSwitcher(variants, current, names) {
  const bar = el('div', {
    id: 'prototype-switcher',
    style: {
      position: 'fixed', bottom: '18px', left: '50%', transform: 'translateX(-50%)',
      display: 'flex', alignItems: 'center', gap: '10px',
      padding: '8px 14px', borderRadius: '999px',
      background: 'rgba(12,14,18,.92)', border: '1px solid rgba(255,255,255,.18)',
      boxShadow: '0 8px 32px rgba(0,0,0,.55)', backdropFilter: 'blur(10px)',
      font: '500 12px/1 ui-monospace, monospace', color: '#e9edf2', zIndex: '99999',
      letterSpacing: '.3px',
    },
  });
  const go = (v) => {
    const u = new URL(location.href);
    u.searchParams.set('variant', v);
    location.href = u.toString();
  };
  const idx = variants.indexOf(current);
  bar.append(
    el('button', {
      style: { background: 'transparent', border: 'none', color: '#e9edf2', cursor: 'pointer', font: 'inherit', padding: '2px 6px', fontSize: '14px' },
      onclick: () => go(variants[(idx - 1 + variants.length) % variants.length]),
    }, '←'),
    el('span', {}, `${current} · ${names[current] ?? ''}`),
    el('span', { style: { opacity: '.35' } }, '/'),
    el('span', { style: { opacity: '.55', fontSize: '11px' } }, 'PROTOTYPE'),
    el('button', {
      style: { background: 'transparent', border: 'none', color: '#e9edf2', cursor: 'pointer', font: 'inherit', padding: '2px 6px', fontSize: '14px' },
      onclick: () => go(variants[(idx + 1) % variants.length]),
    }, '→'),
  );
  document.body.append(bar);

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'ArrowLeft') go(variants[(idx - 1 + variants.length) % variants.length]);
    if (e.key === 'ArrowRight') go(variants[(idx + 1) % variants.length]);
  });
}
