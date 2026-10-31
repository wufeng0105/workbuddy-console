/**
 * workbuddy-console · 控制台前端
 * ---------------------------------------------------------------
 * 无框架、无构建。
 * 硬约束：
 *   - 前端**永不直接触碰文件系统**，一切经本地服务端的 /api/*
 *   - 三态**不得合并**：`undetermined`（无法判定）渲染为黄色，绝不显示成成功
 *   - 厂商文件写入需显式勾选确认（铁律 5）
 */

const TOKEN = new URLSearchParams(location.search).get('token') ?? '';

/** @param {string} path @param {{method?:string, body?:any}} [opts] */
async function api(path, opts = {}) {
  const { method = 'GET', body } = opts;
  const res = await fetch(path, {
    method,
    headers: {
      'X-WBC-Token': TOKEN,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { throw new Error(`响应不是 JSON（HTTP ${res.status}）`); }
  if (!res.ok || !json.ok) {
    const err = new Error(json?.error?.message ?? `HTTP ${res.status}`);
    err.code = json?.error?.code;
    err.detail = json?.error?.detail;
    throw err;
  }
  return json.data;
}

/** @param {any} s */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** @param {string} tag @param {any} [attrs] @param {...any} kids */
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

const $ = (id) => document.getElementById(id);

/** @type {{doctor:any, selected:string|null, probe:any, plan:any, verify:any, backups:any[], draft:string|null, view:'handle'|'profile', profiles:any[], selectedProfile:string|null, profilePlan:any, profileVerify:any}} */
const S = {
  doctor: null, selected: null, probe: null, plan: null, verify: null, backups: [], draft: null,
  view: 'handle', profiles: [], selectedProfile: null, profilePlan: null, profileVerify: null,
};

/** @param {string} id */
function handleMeta(id) { return S.doctor?.handles.find((h) => h.id === id) ?? null; }

// ── 顶部 ──────────────────────────────────────────────────────
function renderTop() {
  const d = S.doctor;
  if (!d) return;
  $('meta').textContent = d.ok ? `WorkBuddy ${d.version} · 体检通过` : `WorkBuddy ${d.version} · ⚠️ 体检有问题`;
  $('where').textContent = `配置根 ${d.configRoot}`;
}

// ── 把手列表 ──────────────────────────────────────────────────
function renderList() {
  const box = $('handle-list');
  box.className = '';
  box.textContent = '';
  if (!S.doctor) return;
  for (const h of S.doctor.handles) {
    const cls = h.writeClass === 'vendor-file' ? 'badge vendor' : 'badge';
    box.append(el('button', {
      class: 'handle',
      'aria-current': String(S.view === 'handle' && S.selected === h.id),
      onclick: () => select(h.id),
    },
    el('div', { class: 't' }, h.title, el('span', { class: cls }, h.writeClass === 'vendor-file' ? '厂商文件' : '用户目录')),
    el('div', { class: 's' }, h.anchorOk ? h.anchorPath : `❌ ${h.error}`)));
  }
  renderProfiles();
}

// ── 专家档位 ──────────────────────────────────────────────────
async function loadProfiles() {
  try { S.profiles = await api('/api/profiles'); } catch { S.profiles = []; }
}

function renderProfiles() {
  const box = $('profile-list');
  if (!box) return;
  box.className = S.profiles.length ? '' : 'empty';
  box.textContent = '';
  if (!S.profiles.length) { box.textContent = '（暂无档位。先把当前人设调成想要的样子，再"存为新档位"）'; return; }
  for (const p of S.profiles) {
    box.append(el('button', {
      class: 'handle',
      'aria-current': String(S.view === 'profile' && S.selectedProfile === p.id),
      onclick: () => selectProfile(p.id),
    },
    el('div', { class: 't' }, p.name, el('span', { class: 'badge' }, `${p.covers.length} 项`)),
    el('div', { class: 's' }, p.id)));
  }
}

async function selectProfile(id) {
  S.view = 'profile';
  S.selectedProfile = id;
  S.profilePlan = null;
  S.profileVerify = null;
  renderList();
  renderProfileDetail();
}

function renderProfileDetail() {
  const p = S.profiles.find((x) => x.id === S.selectedProfile);
  const body = $('detail-body');
  $('detail-title').textContent = p ? `档位：${p.name}` : '档位';
  body.className = '';
  body.textContent = '';
  if (!p) { body.append(el('div', { class: 'empty' }, '档位不存在。')); return; }

  const kv = el('dl', { class: 'kv' });
  const add = (k, v) => kv.append(el('dt', {}, k), el('dd', {}, v));
  add('id', p.id);
  add('覆盖', p.covers.join('、'));
  add('创建', p.createdAt ?? '—');
  body.append(el('div', { class: 'card' }, el('h3', {}, '档位'), kv));

  const row = el('div', { class: 'row' },
    el('button', { class: 'primary', onclick: () => doPlanProfile() }, '预览切换'),
    el('button', { onclick: () => doApplyProfile() }, '切换到这一档'),
    el('button', { onclick: () => doVerifyProfile() }, '验证生效'),
    el('button', { class: 'danger', onclick: () => doDeleteProfile() }, '删除档位'));
  body.append(el('div', { class: 'card' }, el('h3', {}, '操作'), row, el('div', { id: 'msg' })));

  if (S.profilePlan) body.append(renderProfilePlan(S.profilePlan));
  if (S.profileVerify) body.append(renderVerify(S.profileVerify));
  body.append(renderBackups());
}

function renderProfilePlan(pl) {
  const card = el('div', { class: 'card' },
    el('h3', {}, `切换预览 · 合计修正 ${pl.expectedDeltaTokens >= 0 ? '+' : ''}${pl.expectedDeltaTokens} tokens（估算）`));
  for (const it of pl.items) {
    card.append(el('div', { class: 'muted', style: 'margin-top:8px' },
      `${it.title}　${it.handle}　${it.expectedDeltaTokens == null ? '（无法预估增量）' : `${it.expectedDeltaTokens >= 0 ? '+' : ''}${it.expectedDeltaTokens} tokens`}`));
    card.append(el('pre', { class: 'diff', html: colorDiff(it.diffText ?? '') }));
    for (const w of it.warnings) card.append(el('div', { class: 'warn' }, w));
    for (const w of (it.gate?.warnings ?? [])) card.append(el('div', { class: 'warn' }, w));
  }
  if (pl.needsConfirm) card.append(el('div', { class: 'warn' }, '含厂商文件把手：切换需要在把手页逐次确认。'));
  return card;
}

// ── 详情 ──────────────────────────────────────────────────────
async function select(id) {
  S.view = 'handle';
  S.selected = id;
  S.plan = null; S.verify = null; S.draft = null;
  renderList();
  await refreshProbe();
}

async function refreshProbe() {
  const id = S.selected;
  if (!id) return;
  $('detail-body').className = '';
  $('detail-body').textContent = '读取中…';
  try {
    S.probe = await api(`/api/handle/${encodeURIComponent(id)}/probe`);
    S.draft = null;
    renderDetail();
  } catch (e) {
    $('detail-body').className = '';
    $('detail-body').textContent = '';
    $('detail-body').append(el('div', { class: 'warn err' }, `读取失败：${e.message}`));
  }
}

function currentEditableText() {
  const st = S.probe?.state;
  if (!st) return '';
  if (st.value !== undefined) return typeof st.value === 'string' ? st.value : JSON.stringify(st.value);
  return st.text ?? '';
}

function renderDetail() {
  const id = S.selected;
  const h = handleMeta(id);
  const st = S.probe?.state ?? {};
  const body = $('detail-body');
  $('detail-title').textContent = h?.title ?? id;
  body.className = '';
  body.textContent = '';

  // ── 现状 ──
  const kv = el('dl', { class: 'kv' });
  const add = (k, v) => { kv.append(el('dt', {}, k), el('dd', {}, v)); };
  add('锚点', h?.anchorPath ?? '—');
  add('写入级别', h?.writeClass === 'vendor-file' ? '厂商文件（需逐次确认）' : '用户目录（自由写）');
  add('权限', h?.privilege === 'elevated' ? '需要提权' : '不需要提权');
  add('通道', h?.channel ?? '—');
  add('升级', h?.upgradeBehavior === 'survives' ? '存活' : h?.upgradeBehavior ?? '—');
  add('验证', `${h?.verification?.strategy ?? '—'} @ ${h?.verification?.channel ?? '—'}`);
  if (st.value !== undefined) {
    add('当前取值', `${JSON.stringify(st.value)}${st.valueValid === false ? '  ⚠️ 非法取值（App 会静默忽略）' : ''}`);
  }
  if (st.limits) {
    add('注入上限', `${st.limits.maxChars} 字符${st.limits.exceeded ? `，⚠️ 当前 ${st.limits.chars} 已超限（丢弃 ${st.limits.dropped}）` : `，当前 ${st.limits.chars}`}`);
  }
  if (st.injectedChars != null) add('真正注入', `${st.injectedChars} 字符`);
  if (st.injectedNote) add('注入说明', st.injectedNote);
  body.append(el('div', { class: 'card' }, el('h3', {}, '现状'), kv));

  // ── 专家档位模式告警 ──
  const mode = h?.id === 'personalization.identity'
    ? '⚠️ 该把手在**专家模式下不注入**：切到专家档位时"名字"会静默消失。' : null;

  // ── 编辑 ──
  const editorCard = el('div', { class: 'card' }, el('h3', {}, '编辑'));
  if (mode) editorCard.append(el('div', { class: 'warn' }, mode));

  let input;
  if (st.allowedValues) {
    input = el('select', { class: 'handle' });
    for (const v of st.allowedValues) {
      input.append(el('option', { value: v, selected: v === st.value ? '' : null }, v));
    }
  } else {
    input = el('textarea', { spellcheck: 'false' });
    input.value = currentEditableText();
  }
  input.id = 'editor';
  editorCard.append(input);

  const row = el('div', { class: 'row' });
  const note = el('span', { class: 'muted' }, '');
  const dirty = () => {
    const v = input.value;
    const base = st.value !== undefined ? String(st.value ?? '') : (st.text ?? '');
    note.textContent = v === base ? '' : '（有未预览的改动）';
  };
  input.addEventListener('input', dirty);
  if (input.tagName === 'SELECT') input.addEventListener('change', dirty);

  const vendor = h?.writeClass === 'vendor-file';
  let confirmBox = null;
  if (vendor) {
    confirmBox = el('label', { class: 'muted' });
    const cb = el('input', { type: 'checkbox' });
    confirmBox.append(cb, ' 我确认这是厂商文件，接受被升级覆盖的风险');
    confirmBox.dataset.role = 'confirm';
  }

  row.append(
    el('button', { class: 'primary', onclick: () => doPlan(input.value) }, '预览差异'),
    el('button', { onclick: () => doApply(input.value) }, '应用'),
    el('button', { onclick: () => doVerify() }, '验证生效'),
    el('button', { onclick: () => doRestoreLatest() }, '还原最近一次'),
    note,
  );
  if (confirmBox) row.append(confirmBox);
  editorCard.append(row);
  editorCard.append(el('div', { id: 'msg' }));
  body.append(editorCard);

  // ── 结果区 ──
  if (S.plan) body.append(renderPlan(S.plan));
  if (S.verify) body.append(renderVerify(S.verify));

  // ── 备份 ──
  body.append(renderBackups());
}

function renderPlan(p) {
  const card = el('div', { class: 'card' }, el('h3', {}, '差异预览'));
  const pv = p.preview ?? {};
  if (pv.valueAfter !== undefined) {
    card.append(el('div', { class: 'muted' }, `取值 ${JSON.stringify(pv.valueBefore)} → ${JSON.stringify(pv.valueAfter)}`));
  }
  if (pv.expectedDeltaTokens != null) {
    const d = pv.expectedDeltaTokens;
    card.append(el('div', { class: 'muted' }, `期望增量 ${d >= 0 ? '+' : ''}${d} tokens（估算，用于验证对照）`));
  }
  card.append(el('pre', { class: 'diff', html: colorDiff(pv.diffText ?? '（无差异）') }));
  for (const w of (pv.warnings ?? [])) card.append(el('div', { class: 'warn' }, w));
  if (p.needsConfirm) card.append(el('div', { class: 'warn' }, '这是**厂商文件**写入：apply 需要在下方勾选确认。'));
  for (const w of (p.gate?.warnings ?? [])) card.append(el('div', { class: 'warn' }, w));
  return card;
}

function renderVerify(v) {
  const card = el('div', { class: 'card' }, el('h3', {}, '验证结论'));
  card.append(el('span', { class: 'verdict', 'data-v': v.verdict },
    { effective: '✅ 生效', ineffective: '❌ 未生效', undetermined: '⚠️ 无法判定' }[v.verdict] ?? v.verdict));
  card.append(el('div', { class: 'muted', style: 'margin-top:6px' }, v.reason ?? ''));
  if (v.evidence) {
    const t = el('table', {}, el('tr', {}, el('th', {}, ''), el('th', {}, '时间'), el('th', {}, '会话'), el('th', {}, '模型'), el('th', {}, 'prompt_tokens')));
    const row = (label, x) => el('tr', {}, el('td', {}, label), el('td', {}, x.at ?? ''), el('td', {}, x.worker ?? ''), el('td', {}, x.model ?? ''), el('td', {}, String(x.promptTokens ?? '')));
    t.append(row('基线', v.evidence.baseline), row('观测', v.evidence.observed));
    card.append(t);
    card.append(el('div', { class: 'muted', style: 'margin-top:6px' },
      `实测增量 ${v.evidence.observed.promptTokens - v.evidence.baseline.promptTokens} tokens · 已排除样本 ${v.evidence.excludedSamples} 条 · 基准=${v.evidence.basis}`));
  }
  for (const w of (v.warnings ?? [])) card.append(el('div', { class: 'warn' }, w));
  return card;
}

function renderBackups() {
  const card = el('div', { class: 'card' }, el('h3', {}, '备份与还原'));
  if (!S.backups.length) { card.append(el('div', { class: 'empty' }, '（暂无备份）')); return card; }
  const t = el('table', {}, el('tr', {}, el('th', {}, '备份 id'), el('th', {}, '时间'), el('th', {}, '项'), el('th', {}, '原因'), el('th', {}, '')));
  for (const b of S.backups.slice(0, 8)) {
    t.append(el('tr', {},
      el('td', {}, b.id),
      el('td', {}, b.createdAt ?? ''),
      el('td', {}, String(b.entries)),
      el('td', {}, b.reason ?? ''),
      el('td', {}, el('button', { onclick: () => doRestore(b.id, true) }, '预演'), el('button', { onclick: () => doRestore(b.id, false) }, '还原'))));
  }
  card.append(t);
  return card;
}

/** @param {string} text */
function colorDiff(text) {
  return String(text).split('\n').map((line) => {
    const c = line[0];
    const cls = c === '+' ? 'add' : c === '-' ? 'del' : 'ctx';
    return `<span class="${cls}">${esc(line)}</span>`;
  }).join('\n');
}

/** @param {string} m @param {boolean} [err] */
function msg(m, err = false) {
  const box = $('msg');
  if (!box) return;
  box.textContent = '';
  if (m) box.append(el('div', { class: err ? 'warn err' : 'warn' }, m));
}

// ── 动作 ──────────────────────────────────────────────────────
async function doPlan(next) {
  msg('');
  try {
    S.plan = await api(`/api/handle/${encodeURIComponent(S.selected)}/plan`, { method: 'POST', body: { next } });
    S.verify = null;
    renderDetail();
  } catch (e) { msg(`预览失败 [${e.code ?? 'ERR'}] ${e.message}`, true); }
}

async function doApply(next) {
  msg('');
  const h = handleMeta(S.selected);
  let confirm = false;
  if (h?.writeClass === 'vendor-file') {
    const cb = document.querySelector('[data-role="confirm"] input');
    confirm = Boolean(cb?.checked);
    if (!confirm) { msg('厂商文件写入需要先勾选确认。', true); return; }
  }
  try {
    const r = await api(`/api/handle/${encodeURIComponent(S.selected)}/apply`, { method: 'POST', body: { next, confirm } });
    msg(`已写入。备份 ${r.backupId}（可还原）。验证策略 ${r.verification?.strategy}`);
    S.plan = null;
    await refreshProbe();
    await loadBackups();
  } catch (e) { msg(`写入失败 [${e.code ?? 'ERR'}] ${e.message}`, true); }
}

async function doVerify() {
  msg('');
  try {
    S.verify = await api(`/api/handle/${encodeURIComponent(S.selected)}/verify`, { method: 'POST', body: {} });
    renderDetail();
  } catch (e) { msg(`验证失败 [${e.code ?? 'ERR'}] ${e.message}`, true); }
}

async function doRestoreLatest() {
  if (!S.backups.length) { msg('还没有备份可还原。', true); return; }
  await doRestore(S.backups[0].id, false);
}

async function doRestore(backupId, dryRun) {
  msg('');
  try {
    const r = await api('/api/restore', { method: 'POST', body: { backupId, dryRun } });
    const changed = r.changed?.length ?? 0;
    msg(`${dryRun ? '预演' : '已还原'} ${backupId}：${changed} 项${changed ? '' : '（无漂移，未改动）'}`);
    if (!dryRun) { await refreshProbe(); await loadBackups(); }
  } catch (e) { msg(`还原失败 [${e.code ?? 'ERR'}] ${e.message}`, true); }
}

async function loadBackups() {
  try { S.backups = await api('/api/backups'); } catch { S.backups = []; }
}

// ── 档位动作 ──────────────────────────────────────────────────
async function doSaveProfile() {
  const name = prompt('新档位名称（例如：代码专家 / 写作专家）');
  if (!name || !name.trim()) return;
  try {
    const p = await api('/api/profiles/save', { method: 'POST', body: { name: name.trim() } });
    await loadProfiles();
    renderList();
    selectProfile(p.id);
  } catch (e) { alert(`保存失败：${e.message}`); }
}

async function doPlanProfile() {
  try {
    S.profilePlan = await api('/api/profiles/plan', { method: 'POST', body: { id: S.selectedProfile } });
    S.profileVerify = null;
    renderProfileDetail();
  } catch (e) { alert(`预览失败：${e.message}`); }
}

async function doApplyProfile() {
  try {
    const r = await api('/api/profiles/apply', { method: 'POST', body: { id: S.selectedProfile, confirm: false } });
    S.profilePlan = null;
    await loadBackups();
    renderProfileDetail();
    msg(`已切换：${r.written.length} 个把手；一次备份 ${r.backupId}（覆盖 ${r.files} 个文件，可整体还原）`);
  } catch (e) { msg(`切换失败 [${e.code ?? 'ERR'}] ${e.message}`, true); }
}

async function doVerifyProfile() {
  try {
    S.profileVerify = await api('/api/profiles/verify', { method: 'POST', body: { id: S.selectedProfile } });
    renderProfileDetail();
  } catch (e) { msg(`验证失败 [${e.code ?? 'ERR'}] ${e.message}`, true); }
}

async function doDeleteProfile() {
  if (!window.confirm(`删除档位「${S.selectedProfile}」？（只删源状态，不动 WorkBuddy 里的现有内容）`)) return;
  try {
    await api('/api/profiles/delete', { method: 'POST', body: { id: S.selectedProfile } });
    S.selectedProfile = null;
    S.view = 'handle';
    await loadProfiles();
    renderList();
    const first = S.doctor?.handles?.[0];
    if (first) await select(first.id);
  } catch (e) { alert(`删除失败：${e.message}`); }
}

// ── 启动 ──────────────────────────────────────────────────────
(async function boot() {
  if (!TOKEN) {
    $('detail-body').textContent = '缺少会话令牌 —— 请用启动时打印的带 token 的 URL 打开。';
    return;
  }
  try {
    S.doctor = await api('/api/doctor');
    await loadBackups();
    await loadProfiles();
    renderTop();
    renderList();
    $('save-profile').addEventListener('click', doSaveProfile);
    const first = S.doctor.handles[0];
    if (first) await select(first.id);
  } catch (e) {
    $('detail-body').className = '';
    $('detail-body').textContent = `启动失败：${e.message}`;
  }
})();
