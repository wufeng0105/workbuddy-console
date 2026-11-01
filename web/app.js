/**
 * workbuddy-console · 主应用
 *
 * 结构：三栏（域导航 → 项列表 → 工作面），浅色仪表盘。
 * 全部真实调用 /api/*，写操作走六步契约（plan → apply → verify → restore）。
 */

import {
  api, el, $, clear, esc, fmtTime, fmtAgo, fmtNum, hasToken,
  GROUPS, groupOf, VERDICT, EVENT_META, BOUNDARY,
} from './core.js';

/* ══════════════ 状态 ══════════════ */

const S = {
  nav: 'customize',        // customize | profiles | guard | boundary | approval
  group: 'identity',
  handleId: null,
  boundaryId: null,

  overview: null,
  handles: [],
  profiles: [],
  approval: null,
  drift: null,

  // 当前把手的工作面状态
  probe: null,
  plan: null,
  verify: null,
  draft: null,
  busy: false,
  flash: null,             // { type:'ok'|'err', text }

  // 档位
  selectedProfile: null,
  profilePlan: null,
  profileVerify: null,

  audit: [],
};

/* ══════════════ 启动 ══════════════ */

async function boot() {
  if (!hasToken()) {
    document.body.innerHTML = '<div class="boot-err">缺少会话令牌 —— 请使用启动时打印的带 token 的 URL。</div>';
    return;
  }
  try {
    await reloadAll();
    render();
    // 首屏自动加载当前把手的现状 —— 否则编辑器会永远停在"读取中"
    await loadProbe();
  } catch (e) {
    document.body.innerHTML = '';
    document.body.append(el('div', { class: 'boot-err' }, `启动失败：${e.message}`));
  }
}

async function reloadAll() {
  const [overview, doctor, profiles, approval, drift, audit] = await Promise.all([
    api('/api/overview').catch(() => null),
    api('/api/doctor').catch(() => null),
    api('/api/profiles').catch(() => []),
    api('/api/approval').catch(() => null),
    api('/api/drift').catch(() => null),
    api('/api/audit?limit=60').catch(() => []),
  ]);
  S.overview = overview;
  S.handles = doctor?.handles ?? [];
  S.profiles = profiles ?? [];
  S.approval = approval;
  S.drift = drift;
  S.audit = audit ?? [];
  if (!S.handleId) S.handleId = S.handles[0]?.id ?? null;
}

/* ══════════════ 渲染骨架 ══════════════ */

function render() {
  const app = $('app');
  clear(app);
  app.append(rail(), sidebar(), main());
  renderSwitcherIfProto();
}

/* ── 第 1 栏：域导航 ── */
function rail() {
  const nav = el('nav', { class: 'rail' });

  const item = (key, mark, label, badge) => el('button', {
    class: 'rail-item',
    'data-on': String(S.nav === key),
    title: label,
    onclick: () => { S.nav = key; render(); },
  },
  el('span', { class: 'rail-mark' }, mark),
  el('span', { class: 'rail-label' }, label),
  badge ? el('span', { class: 'rail-badge' }, String(badge)) : null);

  nav.append(
    item('customize', '◈', '定制', S.handles.length),
    item('approval', '⚙', '审批', null),
    item('profiles', '◐', '档位', S.profiles.length),
    item('guard', '⛨', '守护', S.overview?.counts?.backups ?? 0),
    item('boundary', '⊘', '边界', null),
  );

  const h = S.overview?.health;
  const running = S.overview?.gate?.appRunning;
  nav.append(el('div', { class: 'rail-foot' },
    el('div', { class: 'rail-stat', title: `锚点 ${h?.anchors ?? 0} 个，失效 ${h?.anchorFailures ?? 0} 个` },
      el('span', { class: 'dot', 'data-s': h?.ok ? 'ok' : 'bad' }),
      el('span', {}, `${h?.anchors ?? 0}`)),
    el('div', { class: 'rail-stat', title: running ? 'WorkBuddy 运行中' : 'WorkBuddy 未运行' },
      el('span', { class: 'dot', 'data-s': running ? 'warn' : 'idle' }),
      el('span', {}, running ? '运行' : '空闲')),
    el('div', { class: 'rail-ver' }, `v${S.overview?.version ?? '?'}`),
  ));

  return nav;
}

/* ── 第 2 栏：列表 ── */
function sidebar() {
  const box = el('div', { class: 'side' });
  if (S.nav === 'customize') {
    const tabs = el('div', { class: 'tabs' });
    for (const g of GROUPS) {
      tabs.append(el('button', {
        class: 'tab',
        'data-on': String(S.group === g.key),
        onclick: () => {
          S.group = g.key;
          S.handleId = S.handles.find((h) => h.id.startsWith(g.prefix))?.id ?? null;
          S.probe = null; S.plan = null; S.verify = null;
          render();
        },
      }, g.title));
    }
    box.append(tabs);

    const g = GROUPS.find((x) => x.key === S.group) ?? GROUPS[0];
    box.append(el('div', { class: 'side-note' }, g.note));

    const list = el('div', { class: 'side-list' });
    const hs = S.handles.filter((h) => h.id.startsWith(g.prefix));
    for (const h of hs) {
      const modified = (S.overview?.customized ?? []).some((x) => x.id === h.id);
      list.append(el('button', {
        class: 'side-item',
        'data-on': String(S.handleId === h.id),
        onclick: () => {
          if (S.handleId === h.id) return;
          S.handleId = h.id; S.probe = null; S.plan = null; S.verify = null; S.draft = null; S.flash = null;
          render();
          loadProbe();
        },
      },
      el('div', { class: 'side-title' }, h.title),
      el('div', { class: 'side-meta' },
        el('span', { class: 'chip', 'data-risk': h.writeClass === 'vendor-file' ? 'vendor' : 'user' },
          h.writeClass === 'vendor-file' ? '厂商' : '用户'),
        h.privilege === 'elevated' ? el('span', { class: 'chip' }, '提权') : null,
        modified ? el('span', { class: 'chip chip-mod' }, '已改') : null,
        !h.anchorOk ? el('span', { class: 'chip chip-bad' }, '锚点失效') : null,
      )));
    }
    if (!hs.length) list.append(el('div', { class: 'side-empty' }, '这一组没有把手'));
    box.append(list);
  }

  if (S.nav === 'approval') {
    box.append(el('div', { class: 'side-head' }, '审批档位'));
    const list = el('div', { class: 'side-list' });
    const pending = S.approval?.rules?.pending;
    const total = (pending?.readAsk ?? 0) + (pending?.writeAsk ?? 0) + (pending?.deleteAsk ?? 0);
    list.append(el('div', { class: 'side-item side-item-static' },
      el('div', { class: 'side-title' }, '当前会弹审批'),
      el('div', { class: 'side-meta' },
        el('span', { class: 'chip' }, `write=ask ${pending?.writeAsk ?? 0}`),
        el('span', { class: 'chip' }, `delete=ask ${pending?.deleteAsk ?? 0}`)),
      el('div', { class: 'side-sub' }, total ? `共 ${total} 条规则仍会询问` : '全部放行')));
    for (const p of (S.approval?.prompts ?? [])) {
      list.append(el('div', { class: 'side-item side-item-static' },
        el('div', { class: 'side-title' }, p.handle.replace('prompt.welcomemode-', '模板 · ')),
        el('div', { class: 'side-meta' },
          el('span', { class: 'chip', 'data-risk': 'vendor' }, `档位 ${p.level?.level ?? '?'}`))));
    }
    box.append(list);
  }

  if (S.nav === 'profiles') {
    box.append(el('div', { class: 'side-head' }, '专家档位'));
    const list = el('div', { class: 'side-list' });
    if (!S.profiles.length) {
      list.append(el('div', { class: 'side-empty' }, '还没有档位'));
    }
    for (const p of S.profiles) {
      list.append(el('button', {
        class: 'side-item',
        'data-on': String(S.selectedProfile === p.id),
        onclick: () => {
          S.selectedProfile = p.id; S.profilePlan = null; S.profileVerify = null;
          render();
        },
      },
      el('div', { class: 'side-title' }, p.name),
      el('div', { class: 'side-meta' },
        el('span', { class: 'chip' }, `${p.covers.length} 项`),
        el('span', { class: 'chip' }, fmtAgo(p.createdAt)))));
    }
    box.append(list);
    box.append(el('div', { class: 'side-actions' },
      el('button', { class: 'btn btn-wide', onclick: saveProfile }, '把当前状态存为新档位')));
  }

  if (S.nav === 'guard') {
    box.append(el('div', { class: 'side-head' }, '备份'));
    const list = el('div', { class: 'side-list' });
    for (const b of (S.overview?.backups ?? [])) {
      list.append(el('div', { class: 'side-item side-item-static' },
        el('div', { class: 'side-title' }, fmtTime(b.createdAt)),
        el('div', { class: 'side-meta' },
          el('span', { class: 'chip' }, `${b.entries} 项`),
          el('span', { class: 'chip' }, b.reason ?? ''),
        )));
    }
    if (!(S.overview?.backups ?? []).length) list.append(el('div', { class: 'side-empty' }, '暂无备份'));
    box.append(list);
  }

  if (S.nav === 'boundary') {
    box.append(el('div', { class: 'side-head' }, '边界'));
    const list = el('div', { class: 'side-list' });
    for (const b of BOUNDARY) {
      list.append(el('button', {
        class: 'side-item',
        'data-on': String(S.boundaryId === b.id),
        onclick: () => { S.boundaryId = b.id; render(); },
      },
      el('div', { class: 'side-title' }, b.title),
      el('div', { class: 'side-meta' },
        el('span', { class: 'chip', 'data-risk': b.can ? 'user' : 'vendor' }, b.can ? '已处理' : '不可达'),
        el('span', { class: 'chip' }, b.layer))));
    }
    box.append(list);
  }

  return box;
}

/* ── 第 3 栏：工作面 ── */
function main() {
  const m = el('main', { class: 'main' });
  if (S.flash) {
    m.append(el('div', { class: `flash flash-${S.flash.type}` }, S.flash.text));
  }
  if (S.nav === 'customize') {
    m.append(handleWork());
    // 切换把手后若还没探测过，异步补上（避免每次 sync 渲染都发请求）
    if (S.handleId && !S.probe && !S.probeLoading) {
      S.probeLoading = true;
      queueMicrotask(() => { S.probeLoading = false; loadProbe(); });
    }
  }
  else if (S.nav === 'approval') m.append(approvalWork());
  else if (S.nav === 'profiles') m.append(profileWork());
  else if (S.nav === 'guard') m.append(guardWork());
  else if (S.nav === 'boundary') m.append(boundaryWork());
  return m;
}

/* ══════════════ 工作面：把手 ══════════════ */

function currentHandle() { return S.handles.find((h) => h.id === S.handleId) ?? null; }

async function loadProbe() {
  const h = currentHandle();
  if (!h) return;
  try {
    S.probe = await api(`/api/handle/${encodeURIComponent(h.id)}/probe`);
  } catch (e) {
    S.probe = null;
    S.flash = { type: 'err', text: `探测失败：${e.message}` };
  }
  render();
}

function handleWork() {
  const h = currentHandle();
  if (!h) return el('div', { class: 'empty' }, '左侧选择一个把手');

  const wrap = el('div', { class: 'work' });

  // 头
  wrap.append(el('header', { class: 'work-head' },
    el('h1', {}, h.title),
    el('div', { class: 'work-meta' },
      el('code', {}, h.id),
      el('span', { class: 'chip', 'data-risk': h.writeClass === 'vendor-file' ? 'vendor' : 'user' },
        h.writeClass === 'vendor-file' ? '厂商文件' : '用户目录'),
      el('span', { class: 'chip' }, h.privilege === 'elevated' ? '需提权' : '零提权'),
      el('span', { class: 'chip' }, h.channel),
      el('span', { class: 'chip' }, h.upgradeBehavior === 'survives' ? '升级存活' : '升级失效'),
      el('span', { class: 'chip' }, h.gate === 'none' ? '无闸门' : h.gate === 'app-must-be-closed' ? '需停机' : '需新会话'),
    )));

  // 现状
  const kv = el('dl', { class: 'kv' });
  const addKV = (k, v, cls) => kv.append(el('dt', {}, k), el('dd', { class: cls ?? '' }, v));
  addKV('锚点', h.anchorPath ?? '—');
  addKV('验证', `${h.verification?.strategy} @ ${h.verification?.channel}`);
  const st = S.probe?.state;
  if (st) {
    if (st.value !== undefined) addKV('当前取值', JSON.stringify(st.value), st.valueValid === false ? 'bad' : '');
    if (st.isActive !== undefined) addKV('是否生效档位', st.isActive ? '是' : '否（改它不影响请求）', st.isActive ? '' : 'warn');
    if (st.limits) {
      const L = st.limits;
      addKV('注入上限', `${fmtNum(L.maxChars)} 字符（当前 ${fmtNum(L.chars)}${L.exceeded ? `，超限丢弃 ${fmtNum(L.dropped)}` : ''}）`, L.exceeded ? 'warn' : '');
    }
    if (st.injectedChars != null) addKV('真正注入', `${fmtNum(st.injectedChars)} 字符`);
    if (st.ruleCount != null) {
      addKV('规则数', fmtNum(st.ruleCount));
      if (st.summary) addKV('动作分布', `read ${d3(st.summary.read)} · write ${d3(st.summary.write)} · delete ${d3(st.summary.delete)}`);
    }
    if (st.writeAccess === false) addKV('可写性', '当前进程不可写（需管理员权限）', 'bad');
  } else {
    addKV('状态', '读取中…', 'dim');
  }
  wrap.append(section('现状', kv));

  // 警告
  const warns = [];
  if (h.writeClass === 'vendor-file') warns.push('厂商文件：升级可能覆盖它；写入需显式确认。');
  if (h.id === 'personalization.identity') warns.push('该把手在专家模式下不注入 —— 切档位时"名字"会静默消失。');
  if (st?.limits?.exceeded) warns.push('内容已超过注入上限，超出部分静默丢弃。');
  if (st?.isActive === false) warns.push('该档位当前未生效，改它不会影响任何请求。');
  if (h.gate === 'app-must-be-closed') warns.push('要求 WorkBuddy 已退出才能写入（否则拒绝，而不是写了不生效）。');
  if (warns.length) wrap.append(section('注意', el('div', {}, warns.map((w) => el('div', { class: 'warn' }, w)))));

  // 编辑器
  wrap.append(section('编辑', editorArea(h, st)));

  // 结果
  if (S.plan) wrap.append(section('差异预览', planView(S.plan)));
  if (S.verify) wrap.append(section('验证结论', verifyView(S.verify)));

  return wrap;
}

function d3(d) {
  if (!d) return '—';
  return Object.entries(d).map(([k, v]) => `${k}:${v}`).join(' ');
}

function editorArea(h, st) {
  const box = el('div', {});
  if (!st) return el('div', { class: 'dim' }, '读取中…');

  // 规则矩阵：结构化操作
  if (h.inputKind === 'rule-op') return rulesEditor(h, st);

  // 枚举：下拉
  if (st.allowedValues) {
    const sel = el('select', { class: 'input', id: 'editor' });
    for (const v of st.allowedValues) sel.append(el('option', { value: v, selected: v === st.value ? '' : null }, v));
    sel.addEventListener('change', () => { S.plan = null; S.verify = null; render(); });
    const row = el('div', { class: 'row' }, sel);
    row.append(actions(h, () => $('editor').value));
    box.append(row);
    return box;
  }

  // 文本
  const ta = el('textarea', { class: 'input input-text', id: 'editor', spellcheck: 'false' });
  ta.value = st.text ?? '';
  const hint = el('div', { class: 'editor-hint' },
    el('span', {}, `${fmtNum(ta.value.length)} 字符`),
    st.limits ? el('span', { class: st.limits.exceeded ? 'warn-t' : '' }, ` / 上限 ${fmtNum(st.limits.maxChars)}`) : null,
  );
  ta.addEventListener('input', () => {
    const L = ta.value.length;
    clear(hint);
    hint.append(
      el('span', { class: st.limits && L > st.limits.maxChars ? 'warn-t' : '' }, `${fmtNum(L)} 字符`),
      st.limits ? el('span', {}, ` / 上限 ${fmtNum(st.limits.maxChars)}`) : null,
    );
    if (st.limits && L > st.limits.maxChars) {
      hint.append(el('span', { class: 'warn-t' }, `　超出 ${fmtNum(L - st.limits.maxChars)} 字符将静默丢弃`));
    }
  });
  box.append(ta, hint);
  box.append(actions(h, () => $('editor').value));
  return box;
}

function rulesEditor(h, st) {
  const box = el('div', {});
  box.append(el('div', { class: 'dim' }, '规则矩阵是结构化操作：选择「从什么改成什么」，工具会批量应用并给出命中数。'));

  const from = el('select', { class: 'input input-sm' },
    ...['ask', 'allow', 'deny'].map((v) => el('option', { value: v, selected: v === 'ask' ? '' : null }, v)));
  const to = el('select', { class: 'input input-sm' },
    ...['allow', 'ask', 'deny'].map((v) => el('option', { value: v, selected: v === 'allow' ? '' : null }, v)));
  const acts = el('div', { class: 'checks' });
  for (const a of ['read', 'write', 'delete']) {
    const cb = el('input', { type: 'checkbox', id: `act-${a}`, checked: a !== 'delete' ? '' : null });
    acts.append(el('label', { class: 'check' }, cb, el('span', {}, a)));
  }

  box.append(el('div', { class: 'row row-wrap' },
    el('span', { class: 'dim' }, '把'), from, el('span', { class: 'dim' }, '改成'), to,
    el('span', { class: 'dim' }, '作用动作：'), acts));

  box.append(el('div', { class: 'row' },
    ...['read', 'write', 'delete'].map((a) => null)));

  const getOp = () => {
    const actions = ['read', 'write', 'delete'].filter((a) => $(`act-${a}`)?.checked);
    return { from: $('editor-from')?.value ?? from.value, to: to.value, actions };
  };

  from.id = 'editor-from';
  to.id = 'editor-to';

  const row = el('div', { class: 'row' });
  row.append(
    el('button', { class: 'btn', onclick: () => doPlan(getOp) }, '预览差异'),
    el('button', { class: 'btn btn-primary', onclick: () => doApply(getOp) }, '应用'),
    el('button', { class: 'btn', onclick: () => doVerify() }, '验证生效'),
  );
  box.append(row);
  return box;
}

function actions(h, getNext) {
  const row = el('div', { class: 'row' });
  row.append(
    el('button', { class: 'btn', onclick: () => doPlan(getNext) }, '预览差异'),
    el('button', { class: 'btn btn-primary', onclick: () => doApply(getNext) }, '应用并验证'),
    el('button', { class: 'btn', onclick: () => doVerify() }, '验证生效'),
    el('button', { class: 'btn btn-quiet', onclick: restoreLatest }, '还原最近一次'),
  );
  if (h.writeClass === 'vendor-file') {
    const cb = el('input', { type: 'checkbox', id: 'confirm-vendor' });
    row.append(el('label', { class: 'check check-warn' }, cb, el('span', {}, '我确认这是厂商文件')));
  }
  return row;
}

function planView(p) {
  const box = el('div', {});
  const pv = p.preview ?? {};
  if (pv.valueAfter !== undefined) {
    box.append(el('div', { class: 'plan-line' },
      el('span', { class: 'dim' }, '取值'),
      el('code', {}, JSON.stringify(pv.valueBefore)),
      el('span', { class: 'arrow' }, '→'),
      el('code', { class: 'hl' }, JSON.stringify(pv.valueAfter))));
  }
  if (pv.op) {
    box.append(el('div', { class: 'plan-line' },
      el('span', { class: 'dim' }, '操作'),
      el('code', {}, `${pv.op.actions.join('/')} = ${pv.op.from} → ${pv.op.to}`),
      el('span', { class: 'dim' }, `命中 ${pv.changed} 条`)));
  }
  if (pv.expectedDeltaTokens != null) {
    const d = pv.expectedDeltaTokens;
    box.append(el('div', { class: 'plan-line' },
      el('span', { class: 'dim' }, '期望增量'),
      el('code', { class: d > 0 ? 'hl' : '' }, `${d >= 0 ? '+' : ''}${d} tokens`),
      el('span', { class: 'dim' }, '（估算，用于验证对照）')));
  }
  if (pv.diffText) box.append(el('pre', { class: 'diff', html: colorDiff(pv.diffText) }));
  for (const w of (pv.warnings ?? [])) box.append(el('div', { class: 'warn' }, w));
  for (const w of (p.gate?.warnings ?? [])) box.append(el('div', { class: 'warn warn-soft' }, w));
  if (p.needsConfirm) box.append(el('div', { class: 'warn' }, '厂商文件写入：应用时需要勾选确认。'));
  return box;
}

function colorDiff(text) {
  return String(text).split('\n').map((l) => {
    const c = l[0];
    const cls = c === '+' ? 'add' : c === '-' ? 'del' : 'ctx';
    return `<span class="${cls}">${esc(l)}</span>`;
  }).join('\n');
}

function verifyView(v) {
  const box = el('div', {});
  const meta = VERDICT[v.verdict] ?? { label: v.verdict, mark: '·' };
  box.append(el('div', { class: 'verdict verdict-' + v.verdict },
    el('span', { class: 'verdict-mark' }, meta.mark),
    el('span', { class: 'verdict-label' }, meta.label),
    el('span', { class: 'verdict-reason' }, v.reason ?? '')));

  if (v.evidence) {
    const t = el('table', { class: 'evt' },
      el('tr', {}, el('th', {}, ''), el('th', {}, '时间'), el('th', {}, '会话'), el('th', {}, '模型'), el('th', {}, 'prompt_tokens'), el('th', {}, 'MCP')));
    const row = (label, x, mcp) => el('tr', {},
      el('td', { class: 'dim' }, label),
      el('td', {}, x.at ?? '—'),
      el('td', {}, x.worker ?? '—'),
      el('td', {}, x.model ?? '—'),
      el('td', { class: 'num' }, fmtNum(x.promptTokens)),
      el('td', { class: 'num' }, mcp == null ? '—' : String(mcp)));
    const mcp = v.evidence.mcpToolCount;
    t.append(row('基线', v.evidence.baseline, mcp?.baseline));
    t.append(row('观测', v.evidence.observed, mcp?.observed));
    box.append(t);

    const delta = (v.evidence.observed?.promptTokens ?? 0) - (v.evidence.baseline?.promptTokens ?? 0);
    box.append(el('div', { class: 'plan-line' },
      el('span', { class: 'dim' }, '实测增量'),
      el('code', { class: delta > 0 ? 'hl' : 'bad' }, `${delta >= 0 ? '+' : ''}${delta} tokens`),
      mcp && mcp.comparable === false
        ? el('span', { class: 'tag tag-warn' }, 'MCP 不可比 · 不能归因')
        : el('span', { class: 'tag tag-ok' }, 'MCP 一致'),
    ));
  }
  for (const w of (v.warnings ?? [])) box.append(el('div', { class: 'warn' }, w));
  if (v.hint) box.append(el('div', { class: 'hint' }, v.hint));
  return box;
}

/* ══════════════ 动作 ══════════════ */

async function doPlan(getNext) {
  const h = currentHandle();
  if (!h) return;
  S.busy = true; S.flash = null;
  try {
    const next = getNext();
    S.plan = await api(`/api/handle/${encodeURIComponent(h.id)}/plan`, { method: 'POST', body: { next } });
    S.verify = null;
    render();
  } catch (e) {
    S.flash = { type: 'err', text: `预览失败 [${e.code ?? 'ERR'}] ${e.message}` };
    render();
  } finally { S.busy = false; }
}

async function doApply(getNext) {
  const h = currentHandle();
  if (!h) return;
  const vendor = h.writeClass === 'vendor-file';
  if (vendor && !$('confirm-vendor')?.checked) {
    S.flash = { type: 'err', text: '厂商文件写入需要先勾选确认。' };
    render();
    return;
  }
  S.busy = true; S.flash = null;
  try {
    const next = getNext();
    const r = await api(`/api/handle/${encodeURIComponent(h.id)}/apply`, {
      method: 'POST',
      body: { next, confirm: vendor },
    });
    S.flash = { type: 'ok', text: `已写入 ${r.handle}　备份 ${r.backupId}（可还原）　验证策略 ${r.verification?.strategy}` };
    S.plan = null;
    await reloadAll();
    await loadProbeQuiet();
    // 写入后自动跑一次验证
    await doVerify(true);
  } catch (e) {
    S.flash = { type: 'err', text: `写入失败 [${e.code ?? 'ERR'}] ${e.message}` };
    render();
  } finally { S.busy = false; }
}

async function loadProbeQuiet() {
  const h = currentHandle();
  if (!h) return;
  try { S.probe = await api(`/api/handle/${encodeURIComponent(h.id)}/probe`); } catch { /* ignore */ }
}

async function doVerify(silent) {
  const h = currentHandle();
  if (!h) return;
  if (!silent) S.flash = null;
  try {
    S.verify = await api(`/api/handle/${encodeURIComponent(h.id)}/verify`, { method: 'POST', body: {} });
  } catch (e) {
    S.flash = { type: 'err', text: `验证失败 [${e.code ?? 'ERR'}] ${e.message}` };
  }
  render();
}

async function restoreLatest() {
  const b = S.overview?.backups?.[0];
  if (!b) { S.flash = { type: 'err', text: '还没有备份可还原。' }; render(); return; }
  await doRestore(b.id);
}

async function doRestore(backupId) {
  try {
    const r = await api('/api/restore', { method: 'POST', body: { backupId } });
    S.flash = { type: 'ok', text: `已还原 ${backupId}：${r.changed.length} 项发生变化` };
    await reloadAll();
    await loadProbeQuiet();
    render();
  } catch (e) {
    S.flash = { type: 'err', text: `还原失败 ${e.message}` };
    render();
  }
}

/* ══════════════ 工作面：审批 ══════════════ */

function approvalWork() {
  const wrap = el('div', { class: 'work' });
  wrap.append(el('header', { class: 'work-head' }, el('h1', {}, '审批自动同意')));

  const a = S.approval;
  if (!a) return el('div', { class: 'dim' }, '读取中…');

  wrap.append(el('div', { class: 'callout' },
    '这个功能分两面，可信度**根本不同** —— 工具会如实区分，而不是笼统说"已完成"。'));

  const faces = el('div', { class: 'faces' });
  faces.append(el('div', { class: 'face face-ok' },
    el('div', { class: 'face-h' }, '规则面 · 宿主弹窗审批', el('span', { class: 'badge badge-ok' }, '可可靠验证')),
    el('div', { class: 'face-b' },
      `read=ask ${a.rules?.pending?.readAsk ?? 0}　write=ask ${a.rules?.pending?.writeAsk ?? 0}　delete=ask ${a.rules?.pending?.deleteAsk ?? 0}`),
    el('div', { class: 'face-n' }, '重启后回读可验证：规则是否被启动逻辑抹掉。')));
  faces.append(el('div', { class: 'face face-warn' },
    el('div', { class: 'face-h' }, '提示词面 · 模型自己问', el('span', { class: 'badge badge-warn' }, '无法保证')),
    el('div', { class: 'face-b' },
      (a.prompts ?? []).map((p) => `${p.handle.replace('prompt.welcomemode-', '')}: ${p.level?.level ?? '?'}`).join('　')),
    el('div', { class: 'face-n' }, '即使文本进了请求，也证明不了模型不再自己问 —— 那取决于模型自身对齐。')));
  wrap.append(faces);

  wrap.append(section('三个档位', el('div', { class: 'levels' },
    ...(a.levels ?? []).map((lv) => el('div', { class: 'level' },
      el('div', { class: 'level-h' }, el('code', {}, lv.id), el('span', {}, lv.title)),
      el('div', { class: 'level-d' },
        lv.id === 'off' ? '不做任何改动' :
        lv.id === 'relaxed' ? '规则面放开 read/write，delete 仍确认；提示词面去掉 3 条强制询问，保留红线与安全网' :
        '规则面三动作全放开；提示词面额外去掉 3 条安全网 —— 删除既不会问，也不会自己留备份'))))));

  wrap.append(section('预览与操作', el('div', {},
    el('div', { class: 'row row-wrap' },
      el('select', { class: 'input input-sm', id: 'approval-level' },
        ...(a.levels ?? []).map((lv) => el('option', { value: lv.id }, `${lv.id} · ${lv.title}`))),
      el('button', { class: 'btn', onclick: doPlanApproval }, '预览'),
      el('button', { class: 'btn btn-primary', onclick: doApplyApproval }, '应用'),
      el('button', { class: 'btn', onclick: doVerifyApproval }, '验证'),
    ),
    el('div', { class: 'hint' }, '应用后两个面都需要**重启 WorkBuddy** 才生效。'),
    S.approvalPlanBox ?? '',
    S.approvalVerifyBox ?? '',
  )));

  // 边界说明
  wrap.append(section('为什么永远无法完全验证', el('div', { class: 'callout callout-warn' },
    '规则面能可靠验证（重启后回读）；提示词面只能验证"文本进了请求"，无法验证"模型不再自己问"。')));
  return wrap;
}

async function doPlanApproval() {
  const level = $('approval-level')?.value;
  try {
    const p = await api('/api/approval/plan', { method: 'POST', body: { level } });
    const box = el('div', { class: 'plan-box' });
    box.append(el('div', { class: 'plan-line' }, el('span', { class: 'dim' }, '档位'), el('code', {}, p.level), el('span', {}, p.title)));
    for (const f of p.faces) {
      box.append(el('div', { class: `face face-${f.certainty === 'reliable' ? 'ok' : f.certainty === 'uncertain' ? 'warn' : 'idle'}` },
        el('div', { class: 'face-h' }, f.title,
          el('span', { class: `badge badge-${f.certainty === 'reliable' ? 'ok' : f.certainty === 'uncertain' ? 'warn' : 'idle'}` },
            f.certainty === 'reliable' ? '可可靠验证' : f.certainty === 'uncertain' ? '无法保证' : '不涉及')),
        el('div', { class: 'face-b' }, f.detail),
        el('div', { class: 'face-n' }, f.note ?? '')));
    }
    S.approvalPlanBox = box;
    S.approvalVerifyBox = null;
    render();
  } catch (e) {
    S.flash = { type: 'err', text: `预览失败：${e.message}` };
    render();
  }
}

async function doApplyApproval() {
  const level = $('approval-level')?.value;
  try {
    const r = await api('/api/approval/apply', { method: 'POST', body: { level, confirm: true } });
    S.flash = { type: 'ok', text: `已应用 ${r.level}：成功 ${r.ok} / 失败 ${r.failed}　备份 ${r.backupId ?? '—'}　需重启 WorkBuddy` };
    await reloadAll();
    render();
  } catch (e) {
    S.flash = { type: 'err', text: `应用失败 [${e.code ?? 'ERR'}] ${e.message}` };
    render();
  }
}

async function doVerifyApproval() {
  const level = $('approval-level')?.value;
  try {
    const v = await api('/api/approval/verify', { method: 'POST', body: { level } });
    const box = el('div', {});
    box.append(verifyView(v));
    S.approvalVerifyBox = box;
    render();
  } catch (e) {
    S.flash = { type: 'err', text: `验证失败：${e.message}` };
    render();
  }
}

/* ══════════════ 工作面：档位 ══════════════ */

function profileWork() {
  const wrap = el('div', { class: 'work' });
  const p = S.profiles.find((x) => x.id === S.selectedProfile);
  wrap.append(el('header', { class: 'work-head' }, el('h1', {}, p ? `档位 · ${p.name}` : '专家档位')));

  if (!p) {
    wrap.append(el('div', { class: 'empty' },
      S.profiles.length ? '左侧选择一个档位' : '还没有档位。先在「定制」里把人设调成想要的样子，再点左下角「存为新档位」。'));
    return wrap;
  }

  const kv = el('dl', { class: 'kv' });
  kv.append(el('dt', {}, 'id'), el('dd', {}, p.id));
  kv.append(el('dt', {}, '覆盖'), el('dd', {}, p.covers.join('、')));
  kv.append(el('dt', {}, '创建'), el('dd', {}, fmtTime(p.createdAt)));
  wrap.append(section('档位信息', kv));

  wrap.append(section('操作', el('div', {},
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: () => doPlanProfile(p.id) }, '预览切换'),
      el('button', { class: 'btn btn-primary', onclick: () => doApplyProfile(p.id) }, '切换到这一档'),
      el('button', { class: 'btn', onclick: () => doVerifyProfile(p.id) }, '验证生效'),
      el('button', { class: 'btn btn-danger', onclick: () => doDeleteProfile(p.id) }, '删除档位'),
    ),
    el('div', { class: 'hint' }, '切换是一次事务：所有把手共用一个备份，可整体还原。'))));

  if (S.profilePlan) {
    const box = el('div', {});
    box.append(el('div', { class: 'plan-line' },
      el('span', { class: 'dim' }, '合计修正'),
      el('code', { class: 'hl' }, `${S.profilePlan.expectedDeltaTokens >= 0 ? '+' : ''}${S.profilePlan.expectedDeltaTokens} tokens`)));
    for (const it of S.profilePlan.items) {
      box.append(el('div', { class: 'plan-line' }, el('code', {}, it.handle),
        el('span', { class: 'dim' }, it.expectedDeltaTokens == null ? '无法预估' : `${it.expectedDeltaTokens >= 0 ? '+' : ''}${it.expectedDeltaTokens} tokens`)));
      if (it.diffText) box.append(el('pre', { class: 'diff', html: colorDiff(it.diffText) }));
    }
    wrap.append(section('切换预览', box));
  }
  if (S.profileVerify) wrap.append(section('验证结论', verifyView(S.profileVerify)));
  return wrap;
}

async function saveProfile() {
  const name = prompt('新档位名称（例如：代码专家 / 写作专家）');
  if (!name?.trim()) return;
  try {
    const p = await api('/api/profiles/save', { method: 'POST', body: { name: name.trim() } });
    S.flash = { type: 'ok', text: `已采集档位 ${p.id}（覆盖 ${Object.keys(p.values).length} 个把手）` };
    await reloadAll();
    S.selectedProfile = p.id;
    render();
  } catch (e) {
    S.flash = { type: 'err', text: `保存失败：${e.message}` };
    render();
  }
}

async function doPlanProfile(id) {
  try {
    S.profilePlan = await api('/api/profiles/plan', { method: 'POST', body: { id } });
    S.profileVerify = null;
    render();
  } catch (e) { S.flash = { type: 'err', text: `预览失败：${e.message}` }; render(); }
}
async function doApplyProfile(id) {
  try {
    const r = await api('/api/profiles/apply', { method: 'POST', body: { id, confirm: true } });
    S.flash = { type: 'ok', text: `已切换 ${r.profile}：${r.written.length} 个把手　备份 ${r.backupId}` };
    await reloadAll(); render();
  } catch (e) { S.flash = { type: 'err', text: `切换失败 [${e.code ?? 'ERR'}] ${e.message}` }; render(); }
}
async function doVerifyProfile(id) {
  try {
    S.profileVerify = await api('/api/profiles/verify', { method: 'POST', body: { id } });
    render();
  } catch (e) { S.flash = { type: 'err', text: `验证失败：${e.message}` }; render(); }
}
async function doDeleteProfile(id) {
  if (!confirm(`删除档位「${id}」？（只删源状态，不动 WorkBuddy 里的现有内容）`)) return;
  try {
    await api('/api/profiles/delete', { method: 'POST', body: { id } });
    S.selectedProfile = null; S.profilePlan = null; S.profileVerify = null;
    await reloadAll(); render();
  } catch (e) { S.flash = { type: 'err', text: `删除失败：${e.message}` }; render(); }
}

/* ══════════════ 工作面：守护 ══════════════ */

function guardWork() {
  const wrap = el('div', { class: 'work' });
  wrap.append(el('header', { class: 'work-head' }, el('h1', {}, '守护 · 备份与升级')));

  const d = S.drift;
  // 漂移
  const driftBox = el('div', {});
  if (!d || !d.ok) {
    driftBox.append(el('div', { class: 'callout callout-warn' },
      d?.reason ?? '还没有重放包 —— 无法判断升级后定制是否还在。',
      el('div', { class: 'row', style: { marginTop: '12px' } },
        el('button', { class: 'btn btn-primary', onclick: doBundle }, '建立重放包'))));
  } else {
    driftBox.append(el('div', { class: 'plan-line' },
      el('span', { class: 'dim' }, '重放包'),
      el('code', {}, fmtTime(d.bundleCreatedAt)),
      el('span', { class: 'dim' }, `v${d.bundleVersion}`),
      d.versionChanged ? el('span', { class: 'tag tag-warn' }, `当前 v${d.currentVersion}`) : el('span', { class: 'tag tag-ok' }, '版本一致')));
    if (d.needReplay?.length) {
      driftBox.append(el('div', { class: 'warn' }, `${d.needReplay.length} 项定制需要重放：${d.needReplay.join('、')}`));
      driftBox.append(el('div', { class: 'row' },
        el('button', { class: 'btn btn-primary', onclick: doReplay }, '重放全部'),
        el('button', { class: 'btn', onclick: doBundle }, '重新建包')));
    } else {
      driftBox.append(el('div', { class: 'ok-line' }, '✅ 所有定制都在，无需重放'));
      driftBox.append(el('div', { class: 'row' }, el('button', { class: 'btn', onclick: doBundle }, '重建重放包')));
    }
    const t = el('table', { class: 'evt' }, el('tr', {}, el('th', {}, '把手'), el('th', {}, '状态'), el('th', {}, '说明')));
    for (const r of (d.results ?? [])) {
      t.append(el('tr', {},
        el('td', {}, r.id),
        el('td', { class: r.kind === 'unchanged' ? 'ok-t' : r.severity === 'error' ? 'bad-t' : 'warn-t' }, r.kind),
        el('td', { class: 'dim' }, r.detail ?? '')));
    }
    driftBox.append(t);
  }
  wrap.append(section('升级漂移', driftBox));

  // 备份
  const backups = S.overview?.backups ?? [];
  wrap.append(section(`备份（${backups.length}）`, el('div', {},
    backups.length
      ? el('table', { class: 'evt' },
        el('tr', {}, el('th', {}, '时间'), el('th', {}, '项'), el('th', {}, '原因'), el('th', {}, '')),
        ...backups.map((b) => el('tr', {},
          el('td', {}, fmtTime(b.createdAt)),
          el('td', { class: 'num' }, String(b.entries)),
          el('td', { class: 'dim' }, b.reason ?? ''),
          el('td', {}, el('button', { class: 'btn btn-xs', onclick: () => doRestore(b.id) }, '还原')))))
      : el('div', { class: 'dim' }, '暂无备份'))));

  // 台账
  wrap.append(section(`操作记录（${S.audit.length}）`, auditTable(S.audit.slice(0, 40))));
  return wrap;
}

function auditTable(rows) {
  const t = el('table', { class: 'evt' },
    el('tr', {}, el('th', {}, '时间'), el('th', {}, '事件'), el('th', {}, '对象'), el('th', {}, '结论'), el('th', {}, '说明')));
  for (const r of rows) {
    const m = EVENT_META[r.event] ?? { label: r.event, mark: '·' };
    t.append(el('tr', {},
      el('td', { class: 'dim' }, fmtTime(r.at)),
      el('td', {}, el('span', { class: 'evt-mark' }, m.mark), m.label),
      el('td', {}, el('code', { class: 'sm' }, r.handle ?? r.profile ?? r.backupId ?? '—')),
      el('td', {}, r.verdict ? el('span', { class: `vt vt-${r.verdict}` }, VERDICT[r.verdict]?.label ?? r.verdict) : el('span', { class: 'dim' }, '—')),
      el('td', { class: 'dim' }, (r.reason ?? '').slice(0, 80))));
  }
  return t;
}

async function doBundle() {
  try {
    const r = await api('/api/bundle', { method: 'POST', body: {} });
    S.flash = { type: 'ok', text: `重放包已建立：收录 ${Object.keys(r.bundle.entries).length} 项` };
    await reloadAll(); render();
  } catch (e) { S.flash = { type: 'err', text: `建包失败：${e.message}` }; render(); }
}

async function doReplay() {
  try {
    const r = await api('/api/replay', { method: 'POST', body: { confirm: true } });
    S.flash = {
      type: r.failed > 0 ? 'err' : 'ok',
      text: `重放完成：成功 ${r.ok} / 失败 ${r.failed}　备份 ${r.backupId}`,
    };
    await reloadAll(); render();
  } catch (e) { S.flash = { type: 'err', text: `重放失败 [${e.code ?? 'ERR'}] ${e.message}` }; render(); }
}

/* ══════════════ 工作面：边界 ══════════════ */

function boundaryWork() {
  const wrap = el('div', { class: 'work' });
  const b = BOUNDARY.find((x) => x.id === S.boundaryId) ?? BOUNDARY[0];
  wrap.append(el('header', { class: 'work-head' }, el('h1', {}, b.title),
    el('div', { class: 'work-meta' },
      el('span', { class: 'chip', 'data-risk': b.can ? 'user' : 'vendor' }, b.can ? '工具已处理' : '无法绕过'),
      el('span', { class: 'chip' }, b.layer))));

  wrap.append(section('为什么', el('div', { class: 'callout' }, b.why)));
  wrap.append(section('证据', el('div', { class: 'kv' }, el('dt', {}, '出处'), el('dd', {}, b.evidence))));
  if (b.can) wrap.append(section('工具做了什么', el('div', { class: 'ok-line' }, b.how)));

  wrap.append(section('全部边界', el('div', {}, ...BOUNDARY.map((x) => el('button', {
    class: 'boundary-item',
    'data-on': String(x.id === b.id),
    onclick: () => { S.boundaryId = x.id; render(); },
  },
  el('span', { class: 'boundary-mark' }, x.can ? '✓' : '⊘'),
  el('span', { class: 'boundary-title' }, x.title),
  el('span', { class: 'boundary-layer' }, x.layer))))));

  wrap.append(el('div', { class: 'callout callout-soft' },
    '把这些写清楚，是为了让你不用反复试错 —— 一个诚实说"做不到"的地方，比一个假装万能的工具更有用。'));
  return wrap;
}

/* ══════════════ 工具 ══════════════ */

function section(title, body) {
  return el('section', { class: 'sec' },
    el('h2', { class: 'sec-h' }, title),
    el('div', { class: 'sec-b' }, body));
}

function renderSwitcherIfProto() { /* 正式版无切换条 */ }

boot();
