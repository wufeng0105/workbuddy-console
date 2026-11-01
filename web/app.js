/**
 * workbuddy-console · 主应用
 *
 * 结构：顶部横向导航 + 居中内容（max-width 1200）。
 * 总览 = 任务首页（全宽）；旧五域过渡期沿用 列表+工作面 两栏，逐页重构替换。
 * 全部真实调用 /api/*，写操作走六步契约（plan → apply → verify → restore）。
 */

import {
  api, el, $, clear, esc, fmtTime, fmtNum, hasToken,
  GROUPS, VERDICT, EVENT_META, BOUNDARY,
} from './core.js';

/* ══════════════ 状态 ══════════════ */

const S = {
  nav: 'overview',         // overview | customize | profiles | guard | boundary | approval
  handleId: null,

  overview: null,
  handles: [],
  profiles: [],
  approval: null,
  drift: null,
  probes: {},              // handleId → probe 摘要（ customize 折叠卡状态徽章用）
  profileDetails: {},      // profileId → 完整档位（含 values；列表接口只给元数据）
  baseline: null,          // 最初基线元数据（GET /api/baseline）
  styleCheck: {},          // styleId → 'match' | 'changed' | 'no-baseline'（校验结果驱动「拉取」可用性）
  expanded: undefined,     // customize 展开的把手 id（null = 用户已收起；undefined = 尚未进过该页）

  // 当前把手的工作面状态
  probe: null,
  busy: false,
  flash: null,             // { type:'ok'|'err', text }

  // 档位
  profilePlan: null,
  profileVerify: null,

  // 审批
  approvalLevel: null,
  approvalPlan: null,
  approvalVerify: null,

  // 档位页
  profileExpanded: null,   // 展开的档位 id（null = 全部收起）

  // 守护
  replaySel: null,         // 漂移检测结果里勾选的把手 id 列表

  // 最近一次 apply 的期望增量（引擎内部估算，验证时对照实测）
  lastExpected: null,

  audit: [],
};

/* ══════════════ 启动 ══════════════ */

async function boot() {
  if (!hasToken()) {
    document.body.innerHTML = '<div class="boot-err">缺少会话令牌 —— 请使用启动时打印的带 token 的 URL。</div>';
    return;
  }
  // 恢复上次的展开/收起状态 —— 刷新不得把用户收起的卡片重新撑开
  try {
    const v = sessionStorage.getItem('wbc-expanded');
    if (v !== null) S.expanded = JSON.parse(v);
  } catch { /* 隐私模式忽略 */ }
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
  S.baseline = await api('/api/baseline').catch(() => ({ available: false }));
  if (!S.handleId) S.handleId = S.handles[0]?.id ?? null;
}

/* ══════════════ 渲染骨架 ══════════════ */

function render() {
  const app = $('app');
  clear(app);
  app.append(topnav(), page());
}

/* ── 壳：顶部横向导航（56px，白底发丝线下边） ── */
function topnav() {
  const running = S.overview?.gate?.appRunning;
  const item = (key, label) => el('button', {
    class: 'nav-tab',
    'data-on': String(S.nav === key),
    onclick: () => { S.nav = key; render(); },
  }, label);

  return el('header', { class: 'topnav' },
    el('div', { class: 'topnav-in' },
      el('div', { class: 'brand' },
        el('span', { class: 'brand-ico', html:
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">'
          + '<polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>' }),
        el('span', { class: 'brand-name' }, 'WorkBuddy 控制台')),
      el('nav', { class: 'nav-tabs' },
        item('overview', '总览'),
        item('customize', '个性化'),
        item('profiles', '档位'),
        item('approval', '审批'),
        item('guard', '守护'),
        item('boundary', '边界')),
      el('div', { class: 'nav-status' },
        running != null
          ? el('span', { class: `pill ${running ? 'pill-ok' : 'pill-idle'}` },
            el('span', { class: 'pill-dot' }), running ? '运行中' : '未运行')
          : null,
        el('span', { class: 'pill pill-mono pill-idle' }, `v${S.overview?.version ?? '?'}`))));
}

/* ── 内容区：总览全宽；旧五域过渡期沿用 列表+工作面 两栏 ── */
function page() {
  const wrap = el('main', { class: 'page' });
  if (S.flash) {
    wrap.append(el('div', { class: `flash flash-${S.flash.type}` }, S.flash.text));
  }
  if (S.nav === 'overview') {
    wrap.append(homeWork());
  } else if (S.nav === 'customize') {
    wrap.append(customizeWork());
  } else if (S.nav === 'profiles') {
    wrap.append(profilesWork());
  } else if (S.nav === 'approval') {
    wrap.append(approvalWork());
  } else if (S.nav === 'guard') {
    wrap.append(guardWork());
  } else if (S.nav === 'boundary') {
    wrap.append(boundaryWork());
  }
  return wrap;
}

/* ══════════════ 总览（任务首页） ══════════════ */

function homeWork() {
  const o = S.overview;
  const h = o?.health;
  const running = o?.gate?.appRunning;
  const wrap = el('div', { class: 'home' });

  // 页头问候
  wrap.append(el('section', { class: 'hero' },
    el('h1', {}, '今天要做什么？'),
    el('p', {}, '所有改动都会自动备份，并可验证是否真的生效——先选一件事开始。')));

  // 任务卡 2×2 —— 点击整卡直达对应域
  const card = (opts) => el('div', {
    class: 'task-card',
    onclick: () => { S.nav = opts.nav; render(); },
  },
  el('div', {},
    el('div', { class: 'task-h' },
      el('div', { class: 'task-t' },
        el('span', { class: 'task-ico' }, opts.ico),
        el('h2', {}, opts.title)),
      opts.badge ?? null),
    el('p', {}, opts.desc)),
  el('div', { class: 'task-f' },
    el('span', { class: 'task-go' }, el('span', {}, '进入'), el('span', { class: 'mono' }, '→'))));

  wrap.append(el('section', { class: 'task-grid' },
    card({
      nav: 'customize', ico: '✎', title: '修改个性化设置',
      badge: el('span', { class: 'pill pill-blue' }, '最高频'),
      desc: '人设、称呼、名字、回复风格、指令——改完用 token 增量证明它真的进了模型',
    }),
    card({
      nav: 'profiles', ico: '◐', title: '切换整套人设',
      badge: el('span', { class: 'pill pill-idle' },
        el('span', { class: 'mono' }, String(o?.counts?.profiles ?? 0)), ' 套已存'),
      desc: '把 SOUL + 风格 + 指令存成一套档位，一键整体切换、整体还原',
    }),
    card({
      nav: 'approval', ico: '⚙', title: '调整审批弹窗',
      desc: '让 WorkBuddy 少弹窗。规则面可可靠验证；提示词面无法保证——两面如实区分',
    }),
    card({
      nav: 'guard', ico: '⛨', title: '升级后找回定制',
      desc: '检测升级冲掉了哪些定制，一键重放，逐字节可还原',
    })));

  // 健康状态条 —— 全部来自 /api/overview 实时数据
  const anchorOk = h?.ok;
  wrap.append(el('section', { class: 'health' },
    el('div', { class: 'hs-item' },
      el('span', {}, '锚点'),
      el('span', {
        class: `pill pill-mono ${anchorOk === false ? 'pill-bad' : 'pill-ok'}`,
        title: anchorOk === false ? `${h?.anchorFailures ?? '?'} 个锚点失效，去「守护」页处理` : '全部锚点有效',
      }, anchorOk === false ? `✕ ${h?.anchorFailures ?? '?'}` : `✓ ${h?.anchors ?? '?'}`)),
    el('span', { class: 'hs-sep' }),
    el('div', { class: 'hs-item' },
      el('span', {}, '把手'),
      el('span', { class: 'hs-num' }, String(h?.handles ?? o?.counts?.handles ?? '—'))),
    el('span', { class: 'hs-sep' }),
    el('div', { class: 'hs-item' },
      el('span', {}, 'WorkBuddy'),
      el('span', { class: 'hs-run' },
        el('span', { class: 'dot', 'data-s': running ? 'ok' : 'idle' }),
        running ? '运行中' : '未运行')),
    el('span', { class: 'hs-sep' }),
    el('div', { class: 'hs-item' },
      el('span', {}, '最近备份'),
      el('span', { class: 'pill pill-mono pill-idle' },
        o?.backups?.[0] ? fmtTime(o.backups[0].createdAt) : '—'))));

  // 最近动态 —— audit 最新 5 条（engine 已倒序，recent[0] 最新）
  const rows = (o?.recent ?? []).slice(0, 5);
  const mkCls = (event) =>
    event === 'apply' ? 'mk-apply' : event === 'restore' ? 'mk-restore'
      : event === 'verify' || event === 'verify-profile' || event === 'verify-approval' ? 'mk-verify' : 'mk-neutral';
  const ledger = el('table', { class: 'ledger' },
    el('thead', {}, el('tr', {},
      el('th', { style: { width: '176px' } }, '时间'),
      el('th', { style: { width: '160px' } }, '事件'),
      el('th', {}, '对象'))),
    el('tbody', {},
      ...rows.map((r) => {
        const m = EVENT_META[r.event] ?? { label: r.event, mark: '·' };
        return el('tr', {},
          el('td', { class: 't-time' }, fmtTime(r.at)),
          el('td', {}, el('span', { class: 'ledger-evt' },
            el('span', { class: `mk ${mkCls(r.event)}` }, m.mark),
            el('span', {}, m.label))),
          el('td', {}, el('code', {}, r.handle ?? r.profile ?? r.backupId ?? '—')));
      }),
      rows.length ? null : el('tr', {},
        el('td', { colspan: '3', class: 'dim' }, '还没有操作记录'))));
  wrap.append(el('section', { class: 'panel' },
    el('div', { class: 'panel-h' },
      el('h3', {}, '最近动态'),
      el('span', { class: 'panel-note' }, '只保留本地变更台账')),
    ledger));

  // 页尾边界条 —— 诚实声明做不到的事
  const gotoBoundary = (e) => { e.preventDefault(); S.nav = 'boundary'; render(); };
  wrap.append(el('aside', { class: 'boundary-bar' },
    el('div', { class: 'boundary-in' },
      el('span', { class: 'boundary-warn' }, '⚠'),
      el('div', {},
        '有些事工具做不到：上游内容过滤、模型自身对齐、服务端托管策略——详见',
        el('a', { href: '#boundary', onclick: gotoBoundary }, '『边界』'),
        '页，那里每条都带证据出处。')),
    el('a', { href: '#boundary', class: 'boundary-go', onclick: gotoBoundary },
      el('span', {}, '查看证据'), el('span', { class: 'mono' }, '→'))));

  return wrap;
}

/* ══════════════ 个性化（向导折叠卡，设计稿 customize 页） ══════════════ */

async function loadProbes() {
  const need = S.handles.filter((h) => !S.probes[h.id]);
  await Promise.all(need.map(async (h) => {
    try { S.probes[h.id] = await api(`/api/handle/${encodeURIComponent(h.id)}/probe`); }
    catch { S.probes[h.id] = null; }
  }));
}

/** 单把手重新探测（返回探测结果，不渲染） */
async function probeOne(id) {
  try {
    S.probes[id] = await api(`/api/handle/${encodeURIComponent(id)}/probe`);
  } catch {
    S.probes[id] = null;
  }
  return S.probes[id];
}

/** 参考件「校验」：给出明确结论 —— 锚点 + 内容与本地基线对照，并把结果驱动「拉取」可用性 */
async function verifyReference(h) {
  const pr = await probeOne(h.id);
  await reloadAll();                       // 刷新锚点状态与基线对照（customized 列表）
  const cur = S.handles.find((x) => x.id === h.id) ?? h;
  const drift = S.overview?.drift;
  const hasBaseline = !!drift?.available;
  const differs = (S.overview?.customized ?? []).some((x) => x.id === h.id);
  S.styleCheck[h.id] = !hasBaseline ? 'no-baseline' : differs ? 'changed' : 'match';
  let type = 'ok';
  let msg;
  if (!pr || !cur.anchorOk) {
    type = 'err';
    msg = `校验 ${cur.title}：锚点失效 —— 文件位置或名称与预期不符（升级可能移动了目录）`;
  } else if (!hasBaseline) {
    msg = `校验 ${cur.title}：锚点正常，文件可读（${fmtNum(pr.state?.text?.length ?? 0)} 字符）；尚无本地基线可对照 —— 点「拉取」存一份`;
  } else if (differs) {
    msg = `校验 ${cur.title}：内容与本地基线有变动 —— 升级覆盖过属正常：点「拉取」把新版存为基线，或「还原」写回基线版本`;
  } else {
    msg = `校验 ${cur.title}：锚点正常，内容与本地基线一致（${fmtNum(pr.state?.text?.length ?? 0)} 字符）`;
  }
  S.flash = { type, text: msg };
  render();
  window.scrollTo(0, 0);
}

/** 参考件「拉取」：把 WorkBuddy 当前安装目录里的原厂内容存进本地基线（重放包）。
 *  由「校验」结果驱动可用性：无基线或校验变动才可点；拉取后清空校验态（再校验即一致）。 */
async function pullLatest(handleId) {
  try {
    const r = await api('/api/bundle', { method: 'POST', body: {} });
    const n = Object.keys(r.bundle?.entries ?? {}).length;
    const skipped = r.skipped?.length ?? 0;
    S.flash = { type: 'ok', text: `已把当前内容存为本地基线：收录 ${n} 项${skipped ? `（跳过 ${skipped} 项无需重放）` : ''}` };
    S.styleCheck = {};
    if (handleId) await probeOne(handleId);
    await reloadAll();
  } catch (e) {
    S.flash = { type: 'err', text: `拉取失败 [${e.code ?? 'ERR'}] ${e.message}` };
  }
  render();
}

/** 参考件还原：从本地基线把该把手的快照逐字节写回（无基线则如实报错） */
async function restoreReference(h) {
  try {
    const r = await api('/api/replay', { method: 'POST', body: { only: [h.id], confirm: true } });
    const okN = r.ok ?? r.replayed?.length ?? 0;
    S.flash = { type: 'ok', text: `已还原 ${h.id}（成功 ${okN}）　备份 ${r.backupId ?? '—'}` };
    await probeOne(h.id);
    await reloadAll();
  } catch (e) {
    S.flash = {
      type: 'err',
      text: e.code === 'NO_BUNDLE'
        ? '还没有本地基线——点「拉取最新版」先存一份原厂内容，才能还原。'
        : `还原失败 [${e.code ?? 'ERR'}] ${e.message}`,
    };
  }
  render();
}

/** 写入生效语义（只讲事实，不推验证——生效与否用户自测） */
function effectNote(h) {
  if (h.gate === 'app-must-be-closed') return '写入后需重启 WorkBuddy 生效。';
  const v = h.verification?.strategy;
  if (v === 'token-delta') return '写入后需在 WorkBuddy 新建会话才会进入模型请求（当前会话不受影响）。';
  if (v === 'marker-trace-grep') return '写入后需重启 WorkBuddy 生效（模板随启动组装进请求）。';
  if (v === 'readback-after-restart') return '写入后需重启 WorkBuddy 生效。';
  return '写入后重新进会话生效。';
}

function customizeWork() {
  const wrap = el('div', { class: 'customize' });

  // 页头（账本状态随版本走：同版一本、不可覆盖；升级出新版后在此建立新账）
  const bl = S.baseline;
  wrap.append(el('section', { class: 'hero' },
    el('h1', {}, '个性化设置'),
    el('p', {}, '每个把手：改动自动备份、验证通过才算数——可逐字节还原。'),
    bl?.available
      ? el('p', {
        class: 'dim',
        style: { marginTop: '6px', fontFamily: 'var(--mono)', fontSize: '11px' },
      }, `账本 ${bl.versionKey} · 建立于 ${fmtTime(bl.capturedAt)}${(bl.ledgers?.length ?? 0) > 1 ? ` · 共 ${bl.ledgers.length} 套账本` : ''}`)
      : el('p', { style: { marginTop: '10px' } },
        el('button', { class: 'btn btn-primary', onclick: doCaptureBaseline },
          `建立本版账本${bl?.versionKey ? `（${bl.versionKey}）` : ''}`),
        el('span', { class: 'dim', style: { marginLeft: '8px', fontSize: '12px' } }, '把当前状态固化为这一版的最初设置'))));

  // 首次进入补齐全量探测（折叠卡状态徽章需要每个把手的现状）
  if (S.handles.some((h) => !S.probes[h.id]) && !S.probesLoading) {
    S.probesLoading = true;
    queueMicrotask(async () => {
      await loadProbes();
      S.probesLoading = false;
      if (S.nav === 'customize') render();
    });
  }

  // 仅首次进入本页时给默认展开；用户「收起」（null）后不得被重新撑开
  if (S.expanded === undefined) S.expanded = S.handleId;

  let idx = 0;
  for (const g of GROUPS) {
    const hs = S.handles.filter((h) => h.id.startsWith(g.prefix));
    if (!hs.length) continue;
    const sec = el('section', { class: 'accgroup' });
    sec.append(el('div', { class: 'sec-row' },
      el('span', { class: 'sec-row-l' }, g.title),
      el('span', { class: 'sec-row-r' }, g.note)));
    for (const h of hs) sec.append(accCard(h, ++idx));
    wrap.append(sec);
  }

  return wrap;
}

function saveExpanded() {
  try { sessionStorage.setItem('wbc-expanded', JSON.stringify(S.expanded)); } catch { /* 隐私模式忽略 */ }
}

function accCard(h, idx) {
  const open = S.expanded === h.id;
  const pr = S.probes[h.id];
  const st = pr?.state ?? {};
  // 风格内容组（style.*）：厂商原厂参考件 —— 不提供编辑，只校验 + 从重放包还原
  const referenceMode = h.id.startsWith('style.');

  // ── 参考件卡片（风格内容 7 个）────────────────────────────
  if (referenceMode) {
    const chars = typeof st.text === 'string' ? st.text.length : null;
    const sha = st.sha256 ? st.sha256.slice(0, 6) : null;
    const drift = S.overview?.drift;
    const baseline = drift?.available ? `本地基线已存 ${fmtTime(drift.bundleCreatedAt)}` : '尚无本地基线';
    const sub = !pr
      ? '读取中…'
      : st.writeAccess === false
        ? '当前进程不可读/不可写（需管理员权限）'
        : `原厂风格文件 · ${chars != null ? `${fmtNum(chars)} 字符` : '—'}${sha ? ` · sha ${sha}` : ''} · ${baseline}`;
    const verifyBtn = el('button', {
      class: 'btn btn-xs',
      onclick: (e) => { e.stopPropagation(); verifyReference(h); },
    }, '校验');
    // 拉取跟版本走：无基线可点；校验一致 = 置灰（基线仍有效）；校验变动 = 可点（新版入库）
    const baselineMissing = !drift?.available;
    const checkState = S.styleCheck?.[h.id];
    const pullEnabled = baselineMissing || checkState === 'changed';
    const pullTitle = baselineMissing ? '还没有本地基线，点击建立'
      : checkState === 'changed' ? '内容与基线有变动——把当前 WorkBuddy 内容存为新基线'
        : checkState === 'match' ? '内容与本地基线一致，无需拉取'
          : '先点「校验」——一致则无需拉取，变动后才可拉取';
    const pullBtn = el('button', {
      class: 'btn btn-xs',
      ...(pullEnabled ? {} : { disabled: '' }),
      title: pullTitle,
      onclick: (e) => { e.stopPropagation(); pullLatest(h.id); },
    }, '拉取');
    const restoreBtn = el('button', {
      class: 'btn btn-xs',
      onclick: (e) => { e.stopPropagation(); restoreReference(h); },
    }, '还原');
    return el('div', { class: 'acc' },
      el('div', { class: 'acc-head', style: { cursor: 'default' } },
        el('div', { class: 'acc-id' },
          el('div', { class: 'acc-num' }, String(idx)),
          el('div', { class: 'acc-titles' },
            el('div', { class: 'acc-title-row' },
              el('h2', { class: 'acc-title' }, h.title),
              el('span', { class: 'pill pill-mono pill-idle' }, h.id.split('.').slice(1).join('.')),
              !h.anchorOk
                ? el('span', { class: 'pill pill-bad' }, '锚点失效')
                : el('span', { class: 'pill pill-ok' }, '锚点正常'),
              el('span', { class: 'pill pill-warn' }, '厂商文件 · 升级可能覆盖')),
            el('div', { class: 'acc-sub' }, sub))),
        el('div', { class: 'acc-side' }, verifyBtn, pullBtn, restoreBtn)));
  }

  // ── 常规编辑卡片 ────────────────────────────────────────
  // 状态徽章：内容/取值非空 = 已设置；空 = 未设置（"已生效"只用于验证结论，避免与"未生效"矛盾）
  const badges = [];
  if (!h.anchorOk) badges.push(el('span', { class: 'pill pill-bad' }, '锚点失效'));
  if (h.id === 'personalization.identity') badges.push(el('span', { class: 'pill pill-warn' }, '专家模式下不注入'));
  if (h.inputKind === 'rule-op') {
    if (st.ruleCount != null) badges.push(el('span', { class: 'pill pill-ok' }, `✓ ${st.ruleCount} 条规则`));
  } else if (st.value !== undefined && st.value !== null && st.value !== '') {
    badges.push(el('span', { class: 'pill pill-ok' }, '✓ 已设置'));
  } else if (typeof st.text === 'string') {
    badges.push(st.text.length
      ? el('span', { class: 'pill pill-ok' }, '✓ 已设置')
      : el('span', { class: 'pill pill-idle' }, '未设置'));
  }

  // 摘要行
  let sub;
  if (!pr) sub = '读取中…';
  else if (h.inputKind === 'rule-op') {
    const s = st.summary;
    const fmtAct = (x) => x == null ? '—'
      : typeof x === 'object' ? Object.entries(x).map(([k, v]) => `${k}:${v}`).join('/') : String(x);
    sub = s ? `当前规则：read ${fmtAct(s.read)} · write ${fmtAct(s.write)} · delete ${fmtAct(s.delete)}` : '读取中…';
  } else if (st.value !== undefined && st.value !== null && st.value !== '') {
    sub = el('span', {}, '当前取值：', el('span', { class: 'mono' }, String(st.value)));
  } else if (typeof st.text === 'string') {
    if (st.text.length) {
      // 剥离 frontmatter（开头 --- ... ---），取第一行有信息的正文
      let body = st.text;
      if (body.startsWith('---')) {
        const end = body.indexOf('\n---', 3);
        if (end !== -1) body = body.slice(body.indexOf('\n', end + 1) + 1);
      }
      const first = body.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '';
      sub = `${first.slice(0, 60)}${body.length > 60 ? '…' : ''} · ${fmtNum(st.text.length)} 字符 · 已自定义`;
    } else sub = '未设置';
  } else sub = '—';
  if (st.limits?.exceeded) sub = `内容超出上限，超出 ${fmtNum(st.limits.dropped)} 字符将静默丢弃`;
  if (st.isActive === false) sub = '该档位当前未生效 —— 改它不影响任何请求';

  const expand = () => {
    if (S.expanded === h.id) return;
    S.expanded = h.id; S.handleId = h.id;
    S.probe = null; S.flash = null;
    saveExpanded();
    render();
    loadProbe();
  };

  const head = el('div', { class: 'acc-head', onclick: open ? null : expand },
    el('div', { class: 'acc-id' },
      el('div', { class: 'acc-num' }, String(idx)),
      el('div', { class: 'acc-titles' },
        el('div', { class: 'acc-title-row' },
          el('h2', { class: 'acc-title' }, h.title),
          el('span', { class: 'pill pill-mono pill-idle' }, h.id.split('.').slice(1).join('.')),
          ...badges),
        el('div', { class: 'acc-sub' }, sub))),
    el('div', { class: 'acc-side' },
      open ? el('span', { class: 'pill pill-ok' }, el('span', { class: 'pill-dot' }), '向导进行中') : null,
      open
        ? el('button', {
          class: 'btn btn-xs',
          onclick: () => { S.expanded = null; saveExpanded(); render(); },
        }, '收起')
        : el('span', { class: 'task-go' }, el('span', {}, '编辑'), el('span', { class: 'mono' }, '→'))));

  const card = el('div', { class: 'acc', 'data-open': String(open) }, head);
  if (open) card.append(wizBody(h, st));
  return card;
}

/** 展开卡内容：编辑器 + 生效提示 + 两按钮（应用 / 还原最初设置） */
function wizBody(h, st) {
  const body = el('div', { class: 'wiz-body' });
  body.append(el('div', { class: 'step-title' }, '编辑',
    el('span', { class: 'note' }, effectNote(h))));
  body.append(editorArea(h, st));
  return body;
}

/* ══════════════ 工作面：把手（customize 向导卡内复用） ══════════════ */

function currentHandle() { return S.handles.find((h) => h.id === S.handleId) ?? null; }

async function loadProbe() {
  const h = currentHandle();
  if (!h) return;
  try {
    S.probe = await api(`/api/handle/${encodeURIComponent(h.id)}/probe`);
    S.probes[h.id] = S.probe;
  } catch (e) {
    S.probe = null;
    S.flash = { type: 'err', text: `探测失败：${e.message}` };
  }
  render();
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
    sel.addEventListener('change', () => { render(); });
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

  box.append(actions(h, getOp));
  return box;
}

/** 该把手最近一次写入的备份（apply 时 reason 里带 handle id，engine.mjs:162） */
function lastBaselineEntryFor(h) {
  if (!S.baseline?.available) return null;
  return S.baseline.entries[h.id]
    ?? (h.inputKind === 'rule-op' ? S.baseline.entries[`rules:${h.target}`] : null)
    ?? null;
}

function actions(h, getNext) {
  const row = el('div', { class: 'row' });
  // 最小按钮集：应用（备份→写入）/ 还原最初设置（基线写回，坏改的保险）
  row.append(el('button', { class: 'btn btn-primary', onclick: () => doApply(getNext) }, '应用'));
  const be = lastBaselineEntryFor(h);
  row.append(el('button', {
    class: 'btn btn-quiet',
    ...(be ? {} : { disabled: '' }),
    title: be
      ? `还原到 ${S.baseline.versionKey} 账本的最初快照（${fmtTime(S.baseline.capturedAt)} 建立）`
      : `当前版本（${S.baseline?.versionKey ?? '?'}）还没有账本——先在页首建立`,
    onclick: be ? () => doRestoreBaseline(h) : null,
  }, '还原'));
  if (h.writeClass === 'vendor-file') {
    const cb = el('input', { type: 'checkbox', id: 'confirm-vendor' });
    row.append(el('label', { class: 'check check-warn' }, cb, el('span', {}, '我确认这是厂商文件')));
  }
  return row;
}

function colorDiff(text) {
  return String(text).split('\n').map((l) => {
    const c = l[0];
    const cls = c === '+' ? 'add' : c === '-' ? 'del' : 'ctx';
    return `<span class="${cls}">${esc(l)}</span>`;
  }).join('\n');
}

function verifyView(v, expected = null) {
  const box = el('div', {});
  const meta = VERDICT[v.verdict] ?? { label: v.verdict, mark: '·' };
  box.append(el('div', { class: 'verdict verdict-' + v.verdict },
    el('span', { class: 'verdict-mark' }, meta.mark),
    el('span', { class: 'verdict-label' }, meta.label),
    el('span', { class: 'verdict-reason' }, v.reason ?? '')));

  const delta = v.evidence
    ? (v.evidence.observed?.promptTokens ?? 0) - (v.evidence.baseline?.promptTokens ?? 0)
    : null;

  // 期望 Δ（apply 内部估算）与实测 Δ 对照 —— token-delta 验证的判据核心
  if (expected != null && delta != null) {
    box.append(el('div', { class: 'plan-line' },
      el('span', { class: 'dim' }, '判据对照'),
      el('code', {}, `期望 Δ${expected >= 0 ? '+' : ''}${expected}`),
      el('code', { class: delta > 0 ? 'hl' : 'bad' }, `实测 Δ${delta >= 0 ? '+' : ''}${delta}`),
      Math.sign(delta) === Math.sign(expected) && Math.abs(delta - expected) <= Math.max(20, Math.abs(expected) * 0.5)
        ? el('span', { class: 'tag tag-ok' }, '方向与量级一致')
        : el('span', { class: 'tag tag-warn' }, '与期望偏差较大 · 看下方证据')));
  }

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
    S.flash = { type: 'ok', text: `已写入 ${r.handle}　备份 ${r.backupId}（还原最初设置可一键回到最初）` };
    await reloadAll();
    await loadProbeQuiet();
    render();
  } catch (e) {
    S.flash = { type: 'err', text: `写入失败 [${e.code ?? 'ERR'}] ${e.message}` };
    render();
  } finally { S.busy = false; }
}

/** 建立当前版本的账本（缺失时才捕获；升级出新版后在此立新账，旧账不动） */
async function doCaptureBaseline() {
  S.busy = true; S.flash = null;
  try {
    const r = await api('/api/baseline/capture', { method: 'POST', body: {} });
    S.flash = r.note
      ? { type: 'ok', text: r.note }
      : { type: 'ok', text: `账本 ${r.versionKey} 已建立：收录 ${Object.keys(r.entries ?? {}).length} 项` };
    await reloadAll();
  } catch (e) {
    S.flash = { type: 'err', text: `建立账本失败 [${e.code ?? 'ERR'}] ${e.message}` };
  }
  render();
}

/** 还原最初设置：把当前版本账本的快照写回（后端负责备份 + 闸门） */
async function doRestoreBaseline(h) {
  S.busy = true; S.flash = null;
  try {
    const r = await api('/api/baseline/restore', { method: 'POST', body: { id: h.id } });
    S.flash = r.changed
      ? { type: 'ok', text: `已还原 ${h.title} 到最初设置　备份 ${r.backupId}` }
      : { type: 'ok', text: `${h.title} 与最初基线一致，无需改动` };
    await reloadAll();
    await loadProbes();
    await loadProbeQuiet();
  } catch (e) {
    S.flash = { type: 'err', text: `还原失败 [${e.code ?? 'ERR'}] ${e.message}` };
  }
  render();
}

async function loadProbeQuiet() {
  const h = currentHandle();
  if (!h) return;
  try {
    S.probe = await api(`/api/handle/${encodeURIComponent(h.id)}/probe`);
    S.probes[h.id] = S.probe;
  } catch { /* ignore */ }
}

async function doRestore(backupId) {
  try {
    const r = await api('/api/restore', { method: 'POST', body: { backupId } });
    S.flash = { type: 'ok', text: `已还原 ${backupId}：${r.changed.length} 项发生变化` };
    await reloadAll();
    S.probes = {};          // 还原后所有把手现状可能变化，全部重探
    await loadProbes();
    await loadProbeQuiet();
    render();
  } catch (e) {
    S.flash = { type: 'err', text: `还原失败 ${e.message}` };
    render();
  }
}

/* ══════════════ 审批（向导，设计稿 approval 页） ══════════════ */

function approvalWork() {
  const a = S.approval;
  const wrap = el('div', { class: 'approval' });
  if (!a) {
    wrap.append(el('div', { class: 'empty' }, '读取中…'));
    return wrap;
  }

  // 页头
  wrap.append(el('section', { class: 'hero hero-row' },
    el('div', {},
      el('h1', {}, '审批自动同意'),
      el('p', {}, '一个目标，两面：规则面可可靠验证；提示词面只能降低概率——两面如实区分。'))));

  // 双面可信度卡（当前状态，全部实时数据）
  const pending = a.rules?.pending ?? {};
  const faces = el('section', { class: 'faces', style: { margin: '0 0 24px' } });
  faces.append(el('div', { class: 'face face-ok' },
    el('div', { class: 'face-h' }, '规则面 · 宿主弹窗审批', el('span', { class: 'badge badge-ok' }, '✓ 可可靠验证')),
    el('div', { class: 'face-b ap-num' },
      el('span', {}, el('span', { class: 'k' }, 'read= '), el('span', { class: 'v' }, `ask ${pending.readAsk ?? 0}`)),
      el('span', {}, el('span', { class: 'k' }, 'write= '), el('span', { class: 'v' }, `ask ${pending.writeAsk ?? 0}`)),
      el('span', {}, el('span', { class: 'k' }, 'delete= '), el('span', { class: 'v' }, `ask ${pending.deleteAsk ?? 0}`))),
    el('div', { class: 'face-n' }, '✓ 重启后回读可验证：规则是否被启动逻辑抹掉。')));
  faces.append(el('div', { class: 'face face-warn' },
    el('div', { class: 'face-h' }, '提示词面 · 模型自己问', el('span', { class: 'badge badge-warn' }, '⚠ 无法保证')),
    el('div', { class: 'face-b ap-num' },
      ...(a.prompts ?? []).map((p) => el('span', {},
        el('span', { class: 'k' }, `${p.handle.replace('prompt.welcomemode-', '')}= `),
        el('span', { class: 'v' }, p.level?.level ?? '?')))),
    el('div', { class: 'face-n' }, '⚠ 即使文本进了请求，也证明不了模型不再自己问——那取决于模型自身对齐。')));
  wrap.append(faces);

  // 档位选择（点卡片 = 选中并生成双面预览）
  wrap.append(el('div', { class: 'sec-row' },
    el('span', { class: 'sec-row-l' }, '档位选择'),
    el('span', { class: 'sec-row-r' }, '点卡片选中 → 自动生成双面预览 → 应用并逐面验证')));
  const lvGrid = el('section', { class: 'lvl-grid' });
  for (const lv of (a.levels ?? [])) lvGrid.append(levelCard(lv));
  wrap.append(lvGrid);

  // 步骤条
  const step = S.approvalVerify ? 3 : S.approvalPlan ? 2 : 1;
  const astep = (n, label) => {
    const s = step > n ? 'done' : step === n ? 'cur' : 'todo';
    return el('div', { class: 'astep-item', 'data-s': s },
      el('div', { class: 'astep-dot' }, s === 'done' ? '✓' : String(n)),
      el('div', { class: 'astep-label' }, label));
  };
  wrap.append(el('div', { class: 'astep' },
    astep(1, '选档位'), el('div', { class: 'astep-line' }),
    astep(2, '双面预览与确认'), el('div', { class: 'astep-line' }),
    astep(3, '应用并逐面验证')));

  // 步骤 2 · 双面预览
  if (S.approvalPlan) {
    const pp = S.approvalPlan;
    const panel = el('div', { class: 'pw-panel' });
    panel.append(el('div', { class: 'step-title' }, `步骤 2 · 双面改动预览（${pp.level}）`,
      el('span', { class: 'note' }, '两面影响与信度不同，确认后一起应用')));
    const fgrid = el('div', { class: 'faces', style: { margin: '0 0 12px' } });
    for (const f of pp.faces) {
      fgrid.append(el('div', { class: `face face-${f.certainty === 'reliable' ? 'ok' : f.certainty === 'uncertain' ? 'warn' : 'idle'}` },
        el('div', { class: 'face-h' }, f.title,
          el('span', { class: `badge badge-${f.certainty === 'reliable' ? 'ok' : f.certainty === 'uncertain' ? 'warn' : 'idle'}` },
            f.certainty === 'reliable' ? '✓ 可可靠验证' : f.certainty === 'uncertain' ? '⚠ 无法保证' : '不涉及')),
        el('div', { class: 'face-b' }, f.detail),
        el('div', { class: 'face-n' }, f.note ?? '')));
    }
    panel.append(fgrid);
    panel.append(el('div', { class: 'warn' },
      '两面都需要重启 WorkBuddy 才生效。执行写入后系统将自动生成还原快照并锁定回滚点。'));
    const ck = el('input', { type: 'checkbox', id: 'approval-confirm' });
    const btns = el('div', { class: 'row', style: { marginTop: '0' } },
      el('button', { class: 'btn', onclick: () => { S.approvalPlan = null; render(); } }, '返回修改'),
      el('button', { class: 'btn btn-primary', onclick: doApplyApprovalSel }, '应用变更并进入验证'));
    panel.append(el('div', { class: 'row', style: { justifyContent: 'space-between' } },
      el('label', { class: 'check' }, ck, el('span', {}, '已勾选确认：了解两面的信度差异，接受该档位的行为变化')),
      btns));
    wrap.append(panel);
  }

  // 步骤 3 · 验证结论
  if (S.approvalVerify) {
    const panel = el('div', { class: 'pw-panel' });
    panel.append(el('div', { class: 'step-title' }, '步骤 3 · 验证结论',
      el('span', { class: 'note' }, '三态：生效 / 未生效 / 无法判定 —— 无法判定永不显示为成功')));
    panel.append(verifyView(S.approvalVerify));
    wrap.append(panel);
  }

  return wrap;
}

function levelCard(lv) {
  const sel = S.approvalLevel === lv.id;
  const meta = {
    off: { badge: el('span', { class: 'pill pill-idle' }, '原厂严格'), footR: 'read/write/del = ask', footP: 'strict' },
    relaxed: { badge: el('span', { class: 'pill pill-blue' }, '推荐'), footR: 'write = allow（删除仍确认）', footP: 'relaxed' },
    full: { badge: el('span', { class: 'pill pill-bad' }, '全开放'), footR: 'all = allow', footP: 'bypass' },
  }[lv.id] ?? { badge: null, footR: '—', footP: '—' };
  const desc = lv.id === 'off' ? '原厂（什么都会问）。全规则防御：每一次文件修改都会弹审批，模型对每类操作都会给出确认要求。'
    : lv.id === 'relaxed' ? '放宽（推荐）：写入不再问，删除仍确认。消除编辑流程中的冗余询问，仍保留兜底。'
      : '完全放开：读写删都不问，模型全自主执行。';
  const card = el('div', {
    class: 'lvl-card', 'data-sel': String(sel),
    onclick: () => { S.approvalLevel = lv.id; S.approvalPlan = null; S.approvalVerify = null; render(); doPlanApproval(lv.id); },
  },
  el('div', { class: 'lvl-h' },
    el('div', { class: 'lvl-radio' }),
    el('span', { class: 'lvl-title' }, lv.id),
    meta.badge),
  el('div', { class: 'lvl-desc' }, desc),
  lv.id === 'full' ? el('div', { class: 'lvl-warn' },
    '规则面：删除不会问，也不会自动留备份。提示词面：完全放开控制。') : null,
  el('div', { class: 'lvl-foot' },
    el('span', {}, `规则: ${meta.footR}`),
    el('span', {}, `提示词: ${meta.footP}`)));
  return card;
}

async function doPlanApproval(level) {
  try {
    S.approvalPlan = await api('/api/approval/plan', { method: 'POST', body: { level } });
    S.approvalVerify = null;
    render();
  } catch (e) {
    S.flash = { type: 'err', text: `预览失败：${e.message}` };
    render();
  }
}

async function doApplyApprovalSel() {
  if (!$('approval-confirm')?.checked) {
    S.flash = { type: 'err', text: '应用前需要先勾选确认。' };
    render();
    return;
  }
  const level = S.approvalLevel;
  try {
    const r = await api('/api/approval/apply', { method: 'POST', body: { level, confirm: true } });
    S.flash = { type: 'ok', text: `已应用 ${r.level}：成功 ${r.ok} / 失败 ${r.failed}　备份 ${r.backupId ?? '—'}　需重启 WorkBuddy` };
    S.approvalPlan = null;
    await reloadAll();
    render();
    await doVerifyApproval(level);
  } catch (e) {
    S.flash = { type: 'err', text: `应用失败 [${e.code ?? 'ERR'}] ${e.message}` };
    render();
  }
}

async function doVerifyApproval(level) {
  try {
    S.approvalVerify = await api('/api/approval/verify', { method: 'POST', body: { level } });
    render();
  } catch (e) {
    S.flash = { type: 'err', text: `验证失败：${e.message}` };
    render();
  }
}

/* ══════════════ 档位（卡墙，设计稿 profiles 页） ══════════════ */

/** 摘录：剥 frontmatter，取前 n 字符 */
function excerpt(text, n = 80) {
  if (typeof text !== 'string' || !text.length) return '';
  let body = text;
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end !== -1) body = body.slice(body.indexOf('\n', end + 1) + 1);
  }
  const lines = body.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  const joined = lines.join(' ').trim();
  return joined.length > n ? `${joined.slice(0, n)}…` : joined;
}

function profilesWork() {
  const wrap = el('div', { class: 'profiles' });
  // 「最近切换」从台账推断 —— 台账只能证明切换发生过，不能保证此后未被改动
  const lastApplied = [...S.audit].reverse().find((r) => r.event === 'apply-profile');

  // 懒加载各档位完整内容（列表接口只给元数据）
  if (S.profiles.some((p) => !S.profileDetails[p.id]) && !S.profileDetailsLoading) {
    S.profileDetailsLoading = true;
    queueMicrotask(async () => {
      await Promise.all(S.profiles.map(async (p) => {
        if (S.profileDetails[p.id]) return;
        try { S.profileDetails[p.id] = await api(`/api/profiles/${encodeURIComponent(p.id)}`); }
        catch { S.profileDetails[p.id] = null; }
      }));
      S.profileDetailsLoading = false;
      if (S.nav === 'profiles') render();
    });
  }

  // 页头
  wrap.append(el('section', { class: 'hero hero-row' },
    el('div', {},
      el('div', { class: 'acc-title-row' },
        el('h1', {}, '专家档位'),
        el('span', { class: 'pill pill-idle' }, `${S.profiles.length} 套配置档`)),
      el('p', {}, '把 SOUL + 风格 + 指令存成一套，一键整体切换——一次备份、一条审计、整体还原。')),
    el('button', { class: 'btn btn-primary', onclick: saveProfile }, '＋ 把当前状态存为新档位')));

  // 长条折叠卡（与个性化一致：收起一行看清，展开看详情与操作）
  const strips = el('section', {});
  if (!S.profiles.length) {
    strips.append(el('div', { class: 'empty' },
      '还没有档位。先在「个性化」把人设调成想要的样子，再点右上角「存为新档位」。'));
  }
  S.profiles.forEach((p, i) => strips.append(profileStrip(p, i + 1, lastApplied, S.profileDetails[p.id])));
  wrap.append(strips);

  // 切换预览面板
  if (S.profilePlan) {
    const pp = S.profilePlan;
    const panel = el('div', { class: 'pw-panel' });
    panel.append(el('div', { class: 'step-title' }, `切换预览 · ${pp.id}`,
      el('span', { class: 'note' }, '整体事务：一次备份覆盖全部目标文件'),
      el('span', {
        class: 'pill pill-mono pill-blue',
      }, `合计 Δ${pp.expectedDeltaTokens >= 0 ? '+' : ''}${pp.expectedDeltaTokens} tokens`)));
    for (const it of pp.items) {
      panel.append(el('div', { class: 'plan-line' },
        el('code', {}, it.handle),
        el('span', { class: 'dim' }, it.expectedDeltaTokens == null ? '无法预估' : `Δ${it.expectedDeltaTokens >= 0 ? '+' : ''}${it.expectedDeltaTokens} tokens`)));
      if (it.diffText) panel.append(el('pre', { class: 'diff', html: colorDiff(it.diffText) }));
    }
    panel.append(el('div', { class: 'row' },
      el('button', { class: 'btn btn-primary', onclick: () => doApplyProfile(pp.id) }, '确认切换'),
      el('button', { class: 'btn', onclick: () => { S.profilePlan = null; render(); } }, '取消')));
    wrap.append(panel);
  }

  // 验证结论面板
  if (S.profileVerify) {
    const panel = el('div', { class: 'pw-panel' });
    panel.append(el('div', { class: 'step-title' }, '档位验证结论',
      el('span', { class: 'note' }, '三态结论：生效 / 未生效 / 无法判定')));
    panel.append(verifyView(S.profileVerify));
    wrap.append(panel);
  }

  // 事务保障（蓝条）
  wrap.append(el('div', { class: 'callout', style: { marginTop: '24px' } },
    el('strong', {}, '事务级切换保障　'),
    '切换是一次事务：一次备份覆盖全部目标文件，一条审计记录，整体可还原——不存在「切到一半」。'));

  // 生效判定须知（黄条）
  wrap.append(el('aside', { class: 'boundary-bar', style: { marginTop: '16px' } },
    el('div', { class: 'boundary-in' },
      el('span', { class: 'boundary-warn' }, '⚠'),
      el('div', {},
        el('strong', {}, '生效判定须知　'),
        '切换后需在 WorkBuddy 新建会话并发一条消息才会生效——无新会话时如实显示「无法判定」，不会误报「未生效」。')),
    lastApplied
      ? el('a', {
        href: '#', class: 'boundary-go',
        onclick: (e) => { e.preventDefault(); doVerifyProfile(lastApplied.profile); },
      }, el('span', {}, '验证最近切换的档'), el('span', { class: 'mono' }, '→'))
      : null));

  return wrap;
}

function profileStrip(p, idx, lastApplied, detail) {
  const active = lastApplied?.profile === p.id;
  const open = S.profileExpanded === p.id;
  // 引擎存的是扁平字符串表：values[handleId] = 内容（engine.mjs:295）
  const v = detail?.values ?? {};
  const valOf = (pid) => (typeof v[pid] === 'string' ? v[pid] : '');
  const soulId = p.covers.find((c) => c.endsWith('.soul'));
  const styleId = p.covers.find((c) => c.includes('tone'));
  const promptId = p.covers.find((c) => c.includes('prompt'));
  const full = p.covers.length >= S.handles.filter((h) => h.id.startsWith('personalization.')).length;
  const styleVal = styleId ? valOf(styleId) : '';

  const toggle = () => { S.profileExpanded = open ? null : p.id; render(); };

  const head = el('div', { class: 'acc-head', onclick: open ? null : toggle },
    el('div', { class: 'acc-id' },
      el('div', { class: 'acc-num' }, String(idx)),
      el('div', { class: 'acc-titles' },
        el('div', { class: 'acc-title-row' },
          el('h2', { class: 'acc-title' }, p.name),
          el('span', { class: 'pill pill-mono pill-idle' }, p.id),
          active
            ? el('span', { class: 'pill pill-ok' }, '✓ 最近切换')
            : el('span', { class: 'pill pill-idle' }, '未激活')),
        el('div', { class: 'acc-sub' },
          `覆盖 ${p.covers.length} 项把手（${p.covers.map((c) => c.split('.').slice(1).join('.') || c).join(' / ')}）`
          + (styleVal ? ` · 风格 ${styleVal}` : ' · 未设风格')))),
    el('div', { class: 'acc-side' },
      open ? el('span', { class: 'pill pill-ok' }, el('span', { class: 'pill-dot' }), '已展开') : null,
      open
        ? el('button', { class: 'btn btn-xs', onclick: () => { S.profileExpanded = null; render(); } }, '收起')
        : el('span', { class: 'task-go' }, el('span', {}, '详情'), el('span', { class: 'mono' }, '→'))));

  const strip = el('div', { class: 'acc', 'data-open': String(open), 'data-active': String(active) }, head);
  if (open) {
    const body = el('div', { class: 'wiz-body' });
    body.append(
      el('div', { class: 'pw-label' }, 'SOUL 人设'),
      el('div', { class: 'pw-quote' },
        soulId && valOf(soulId) ? excerpt(valOf(soulId), 200) : el('span', { class: 'empty-q' }, '（未收录）')),
      el('div', { class: 'pw-label' }, '风格'),
      styleVal
        ? el('div', {}, el('span', { class: 'pw-style-pill' }, styleVal))
        : el('div', { class: 'pw-quote' }, el('span', { class: 'empty-q' }, '（未收录）')),
      el('div', { class: 'pw-label' }, '指令'),
      el('div', { class: 'pw-quote' },
        promptId && valOf(promptId) ? excerpt(valOf(promptId), 200) : el('span', { class: 'empty-q' }, '（未收录）')),
      el('div', { class: 'pw-covers' },
        el('span', {}, `覆盖 ${p.covers.length} 项把手`),
        el('span', { class: full ? 'full' : 'dim' }, full ? '完整覆盖' : '标准套')),
      el('div', { class: 'pw-chips' },
        ...p.covers.map((c) => el('span', { class: 'chip' }, c.split('.').slice(1).join('.') || c))),
      el('div', { class: 'row' },
        active
          ? el('button', { class: 'btn btn-primary', onclick: () => doVerifyProfile(p.id) }, '✓ 验证这一档')
          : el('button', { class: 'btn btn-primary', onclick: () => doPlanProfile(p.id) }, '切换到这一档'),
        el('button', { class: 'btn btn-danger', onclick: () => doDeleteProfile(p.id) }, '删除')));
    strip.append(body);
  }
  return strip;
}

async function saveProfile() {
  const name = prompt('新档位名称（例如：代码专家 / 写作专家）');
  if (!name?.trim()) return;
  try {
    const p = await api('/api/profiles/save', { method: 'POST', body: { name: name.trim() } });
    S.flash = { type: 'ok', text: `已采集档位 ${p.id}（覆盖 ${Object.keys(p.values).length} 个把手）` };
    await reloadAll();
    render();
  } catch (e) {
    S.flash = { type: 'err', text: `保存失败：${e.message}` };
    render();
  }
}

async function doPlanProfile(id) {
  try {
    S.profilePlan = { id, ...(await api('/api/profiles/plan', { method: 'POST', body: { id } })) };
    S.profileVerify = null;
    render();
  } catch (e) { S.flash = { type: 'err', text: `预览失败：${e.message}` }; render(); }
}
async function doApplyProfile(id) {
  try {
    const r = await api('/api/profiles/apply', { method: 'POST', body: { id, confirm: true } });
    S.flash = { type: 'ok', text: `已切换 ${r.profile}：${r.written.length} 个把手　备份 ${r.backupId}` };
    S.profilePlan = null; S.profileVerify = null;
    S.probes = {};
    await reloadAll();
    await loadProbes();
    render();
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
    S.profilePlan = null; S.profileVerify = null;
    await reloadAll(); render();
  } catch (e) { S.flash = { type: 'err', text: `删除失败：${e.message}` }; render(); }
}

/* ══════════════ 守护（三步向导，设计稿 guard 页） ══════════════ */

function guardWork() {
  const d = S.drift;
  const wrap = el('div', { class: 'guard' });
  const bundleOk = !!(d && d.ok);
  const needN = d?.needReplay?.length ?? 0;
  if (bundleOk && S.replaySel === null) S.replaySel = [...d.needReplay];

  // 页头
  wrap.append(el('section', { class: 'hero hero-row' },
    el('div', {},
      el('div', { class: 'acc-title-row' },
        el('h1', {}, '守护 · 升级与备份'),
        el('span', { class: 'pill pill-blue pill-mono' }, 'REPLAY & DRIFT')),
      el('p', {}, 'WorkBuddy 升级会整体替换安装目录与插件缓存版本目录——重放包让你在升级后把定制原样灌回去。')),
    el('div', { class: 'row', style: { marginTop: '0' } },
      el('button', {
        class: 'btn',
        onclick: () => document.getElementById('guard-timeline')?.scrollIntoView({ behavior: 'smooth' }),
      }, '快照归档'),
      el('button', { class: 'btn btn-primary', onclick: doBundle }, '新建重放包'))));

  // 步骤条
  const astep = (n, label, badge, sub) => {
    const s = step(n) === 'cur' ? 'cur' : step(n);
    return el('div', { class: 'astep-item', 'data-s': s },
      el('div', { class: 'astep-dot' }, s === 'done' ? '✓' : String(n)),
      el('div', { class: 'astep-text' },
        el('div', { class: 'astep-label' }, label, badge),
        sub ? el('div', { class: 'astep-sub' }, sub) : null));
  };
  function step(n) {
    if (n === 1) return bundleOk ? 'done' : 'cur';
    if (n === 2) return bundleOk ? (needN ? 'cur' : 'done') : 'todo';
    return 'todo';
  }
  wrap.append(el('div', { class: 'astep' },
    astep(1, '建重放包',
      bundleOk ? el('span', { class: 'pill pill-ok' }, '已完成') : null,
      bundleOk ? `${fmtTime(d.bundleCreatedAt)} · ${d.results?.length ?? 0} 项把手` : '写入前先采集基线'),
    el('div', { class: 'astep-line' }),
    astep(2, '漂移检测',
      bundleOk && needN ? el('span', { class: 'pill pill-warn' }, '发现漂移') : null,
      bundleOk ? (needN ? `${needN} 项与当前安装环境比对不一致` : '全部一致') : '与当前安装环境比对差异'),
    el('div', { class: 'astep-line' }),
    astep(3, '重放', null, '逐字节写回并按哈希核验')));

  // 步骤 2 · 漂移检测结果
  if (bundleOk) {
    const panel = el('div', { class: 'panel', style: { marginBottom: '20px' } });
    panel.append(el('div', { class: 'panel-h' },
      el('h3', {}, '步骤 2 · 漂移检测结果'),
      el('div', { class: 'panel-note' },
        `重放包建于 ${fmtTime(d.bundleCreatedAt)}`,
        el('span', { class: 'pill pill-mono pill-idle' }, `快照版本 v${d.bundleVersion}`),
        d.versionChanged
          ? el('span', { class: 'pill pill-warn pill-mono' }, `检测到当前 v${d.currentVersion}`)
          : el('span', { class: 'pill pill-ok pill-mono' }, '版本一致'))));

    const body = el('div', { style: { padding: '16px 20px' } });
    body.append(el('div', { class: 'drift-sum' },
      el('span', {}, `${d.results.length} 项定制中 ${needN ? el('strong', {}, `${needN} 项需要重放`) : '无需重放'}（其余 ${d.results.length - needN} 项保持原样未被冲掉）`),
      el('span', { style: { display: 'flex', gap: '8px' } },
        needN ? el('span', { class: 'pill pill-warn' }, `${needN} 项漂移`) : null,
        el('span', { class: 'pill pill-ok' }, `${d.results.length - needN} 项一致`))));

    const t = el('table', { class: 'evt', style: { marginTop: '14px' } },
      el('tr', {}, el('th', { style: { width: '40px' } }, ''), el('th', {}, '把手'), el('th', {}, '状态'), el('th', {}, '说明')));
    for (const r of (d.results ?? [])) {
      const checked = S.replaySel?.includes(r.id);
      const cb = el('input', {
        type: 'checkbox',
        ...(checked ? { checked: '' } : {}),
        onchange: (e) => {
          S.replaySel = e.target.checked
            ? [...(S.replaySel ?? []), r.id]
            : (S.replaySel ?? []).filter((x) => x !== r.id);
          render();
        },
      });
      t.append(el('tr', {},
        el('td', {}, r.kind === 'unchanged' ? null : cb),
        el('td', {}, el('code', { class: 'sm' }, r.id)),
        el('td', {}, r.kind === 'unchanged'
          ? el('span', { class: 'pill pill-ok pill-mono' }, 'unchanged')
          : el('span', { class: 'pill pill-warn pill-mono' }, r.kind)),
        el('td', { class: 'dim' }, r.detail ?? (r.kind === 'unchanged' ? '定制仍在，无需重放' : ''))));
    }
    body.append(t);

    body.append(el('div', { class: 'row', style: { justifyContent: 'space-between' } },
      el('span', { class: 'step-foot-note' }, `已勾选 ${S.replaySel?.length ?? 0} 项待修复变更`),
      el('div', { class: 'row', style: { marginTop: '0' } },
        el('button', { class: 'btn', onclick: doRedetect }, '重新检测'),
        el('button', {
          class: 'btn',
          disabled: !(S.replaySel?.length > 0) ? '' : null,
          onclick: doReplaySel,
        }, `仅重放选中项（${S.replaySel?.length ?? 0}）`),
        needN ? el('button', { class: 'btn btn-primary', onclick: doReplay }, `重放全部（${needN} 项）`) : null)));
    panel.append(body);
    wrap.append(panel);
  } else {
    wrap.append(el('div', { class: 'callout callout-warn', style: { marginBottom: '20px' } },
      d?.reason ?? '还没有重放包 —— 无法判断升级后定制是否还在。',
      el('div', { class: 'row' },
        el('button', { class: 'btn btn-primary', onclick: doBundle }, '建立重放包'))));
  }

  // 备份时间线
  const backups = S.overview?.backups ?? [];
  const tlPanel = el('section', { class: 'panel', id: 'guard-timeline', style: { marginBottom: '20px' } });
  tlPanel.append(el('div', { class: 'panel-h' },
    el('div', {},
      el('h3', {}, '备份时间线'),
      el('div', { class: 'panel-note' }, '历史自动备份切片，每次写操作前均自动生成快照')),
    el('span', { class: 'pill pill-mono pill-idle' }, `SNAPSHOT_CHAIN: ${backups.length} NODES`)));
  const tlBody = el('div', { style: { padding: '16px 20px' } });
  if (backups.length) {
    tlBody.append(el('div', { class: 'tl' },
      ...backups.map((b, i) => el('div', { class: 'tl-row', 'data-latest': String(i === 0) },
        el('span', { class: 'tl-dot' }),
        el('span', { class: 'tl-time' }, fmtTime(b.createdAt)),
        el('span', { class: 'pill pill-idle pill-mono' }, `${b.entries} 项`),
        el('span', { class: 'tl-reason' }, b.reason ?? ''),
        el('span', { class: 'tl-sha' }, `sha: ${b.id.split('-')[1] ?? b.id}`),
        el('button', { class: 'btn btn-xs', onclick: () => doRestore(b.id) }, '还原')))));
  } else {
    tlBody.append(el('div', { class: 'dim' }, '暂无备份'));
  }
  tlPanel.append(tlBody);
  wrap.append(tlPanel);

  // 操作台账
  const auditPanel = el('section', { class: 'panel', style: { marginBottom: '20px' } });
  auditPanel.append(el('div', { class: 'panel-h' },
    el('div', {},
      el('h3', {}, '操作台账'),
      el('div', { class: 'panel-note' }, '本地审计记录，精确记录每次写入与还原动作')),
    el('span', { class: 'pill pill-mono pill-idle' }, `AUDIT_LEDGER: ${S.audit.length} ENTRIES`)));
  const auditBody = el('div', { style: { padding: '6px 20px 16px' } });
  auditBody.append(auditTable(S.audit.slice(0, 40)));
  auditPanel.append(auditBody);
  wrap.append(auditPanel);

  // 底部诚实声明
  wrap.append(el('div', { class: 'callout callout-soft' },
    '重放失败会如实报告（ok / failed / partial），不允许把部分成功说成完成。还原是逐字节回写：sha256 不一致会报 INTEGRITY 错误而不是静默继续。'));

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

async function doRedetect() {
  await reloadAll();
  S.replaySel = null;
  render();
}

async function doReplaySel() {
  if (!S.replaySel?.length) return;
  try {
    const r = await api('/api/replay', { method: 'POST', body: { only: [...S.replaySel], confirm: true } });
    S.flash = {
      type: r.failed > 0 ? 'err' : 'ok',
      text: `重放完成：成功 ${r.ok} / 失败 ${r.failed}　备份 ${r.backupId}`,
    };
    await reloadAll(); render();
  } catch (e) { S.flash = { type: 'err', text: `重放失败 [${e.code ?? 'ERR'}] ${e.message}` }; render(); }
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

/* ══════════════ 边界（卡墙，设计稿 boundary 页） ══════════════ */

function boundaryWork() {
  const wrap = el('div', { class: 'boundary' });

  // 页头 + 状态统计
  const nHandled = BOUNDARY.filter((b) => b.can).length;
  const nPending = BOUNDARY.filter((b) => b.layer.includes('待实测')).length;
  const nBlocked = BOUNDARY.length - nHandled - nPending;
  wrap.append(el('section', { class: 'hero hero-row' },
    el('div', {},
      el('h1', {}, '边界 · 工具做不到的事'),
      el('p', {}, '每条都带证据出处。把这些写清楚，是为了让你不用反复试错——一个诚实说「做不到」的地方，比一个假装万能的工具更有用。')),
    el('div', { class: 'bd-tags', style: { paddingTop: '6px' } },
      nBlocked ? el('span', { class: 'pill pill-bad' }, `${nBlocked} 不可达`) : null,
      nHandled ? el('span', { class: 'pill pill-ok' }, `${nHandled} 工具已处理`) : null,
      nPending ? el('span', { class: 'pill pill-warn' }, `${nPending} 待实测`) : null)));

  // 卡墙
  const grid = el('section', { class: 'bd-grid' });
  for (const b of BOUNDARY) {
    const pending = b.layer.includes('待实测');
    grid.append(el('div', { class: 'bd-card' },
      el('div', { class: 'bd-h' },
        el('span', { class: 'bd-title' }, b.title),
        el('div', { class: 'bd-tags' },
          pending
            ? el('span', { class: 'pill pill-warn' }, '未知 · 待实测')
            : b.can
              ? el('span', { class: 'pill pill-ok' }, '工具已处理')
              : el('span', { class: 'pill pill-bad' }, '不可达'),
          el('span', { class: 'pill pill-idle pill-mono' }, b.layer))),
      el('div', { class: 'bd-why' }, b.why),
      el('div', { class: 'bd-ev' },
        el('div', { class: 'lab' }, '证据出处'),
        el('code', {}, b.evidence)),
      b.can && b.how ? el('div', { class: 'bd-how' }, `✓ 工具处理：${b.how}`) : null));
  }
  wrap.append(grid);

  // 透明度原则
  wrap.append(el('div', { class: 'bd-principle' },
    el('div', { class: 'ico' }, '🛡'),
    el('div', { class: 'tx' },
      el('b', {}, '透明度原则与边界治理'),
      el('span', {}, '所有不可达项与已处理项均与客户端探针及证据出处联动；不为技术限制制造虚假生效保证。')),
    el('button', {
      class: 'btn',
      onclick: () => { S.nav = 'overview'; render(); },
    }, '返回总览')));

  return wrap;
}

/* ══════════════ 工具 ══════════════ */


boot();
