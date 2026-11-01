/**
 * 变体 C · 流水账
 *
 * 结构承诺：**页面主体是一条无限延伸的时间线**，不是列表、不是分栏。
 *   - 所有事件（apply / verify / restore / replay / 备份）按时间倒序混排
 *   - 左侧时间轴 + 右侧事件内容，可展开看证据
 *   - 顶部只有极简状态条 + 搜索/筛选
 *   - "当前配置"入口很小，藏在顶栏
 *
 * 适合：想审计"我改过什么、哪次没生效、怎么回退"的人。
 * 与 A/B 的区别：A/B 都是"静态对象视角"，C 是"时间视角" —— 配置是事件的结果。
 */
import { loadAll, el, VERDICT, rfmt } from './shared.js';

const EVENT_META = {
  apply: { icon: '✎', label: '写入', color: 'var(--accent)' },
  'apply-profile': { icon: '◐', label: '切换档位', color: 'var(--accent)' },
  'apply-approval': { icon: '⚙', label: '应用审批档', color: 'var(--accent)' },
  verify: { icon: '✓', label: '验证', color: 'var(--fg-dim)' },
  'verify-profile': { icon: '✓', label: '验证档位', color: 'var(--fg-dim)' },
  'verify-approval': { icon: '✓', label: '验证审批', color: 'var(--fg-dim)' },
  restore: { icon: '↩', label: '还原', color: 'var(--warn)' },
  replay: { icon: '⟳', label: '重放', color: 'var(--warn)' },
  bundle: { icon: '⛨', label: '建包', color: 'var(--fg-faint)' },
};

export async function renderC(root) {
  root.innerHTML = '<div class="c-loading">读取中…</div>';
  const data = await loadAll().catch((e) => ({ error: e.message }));
  if (data.error) { root.innerHTML = ''; root.append(el('div', { class: 'c-err' }, `读取失败：${data.error}`)); return; }

  const { overview: ov, approval, profiles, handles } = data;
  let filter = 'all';
  let query = '';

  root.innerHTML = '';

  // ══ 顶栏（极简）══
  const running = ov?.gate?.appRunning === true;
  const bar = el('header', { class: 'c-bar' },
    el('div', { class: 'c-brand' }, 'workbuddy-console', el('span', { class: 'c-brand-sub' }, '时间线')),
    el('div', { class: 'c-barmid' },
      el('input', {
        class: 'c-search', type: 'search', placeholder: '搜索把手 / 事件 / 原因…',
        oninput: (e) => { query = e.target.value.trim(); renderFeed(); },
      }),
      el('div', { class: 'c-filters' },
        ...['all', 'apply', 'verify', 'restore', 'replay'].map((k) =>
          el('button', { class: 'c-filter', 'data-on': String(filter === k), onclick: () => { filter = k; syncFilters(); renderFeed(); } },
            k === 'all' ? '全部' : (EVENT_META[k]?.label ?? k)))),
    ),
    el('div', { class: 'c-barright' },
      el('span', { class: 'c-pill', 'data-ok': String(ov?.health?.ok) },
        el('span', { class: 'c-dot' }), ov?.health?.ok ? '健康' : `${ov?.health?.anchorFailures ?? 0} 锚点失效`),
      el('span', { class: 'c-pill', 'data-run': String(running) }, running ? '运行中' : '未运行'),
      el('span', { class: 'c-pill' }, `v${ov?.version ?? '?'}`),
    ),
  );
  root.append(bar);

  // ══ 左侧摘要（窄）══
  const side = el('aside', { class: 'c-side' });
  side.append(el('div', { class: 'c-sideblock' },
    el('div', { class: 'c-sidenum' }, String(ov?.counts?.audit ?? 0)),
    el('div', { class: 'c-sidelabel' }, '条记录')));
  side.append(el('div', { class: 'c-sideblock' },
    el('div', { class: 'c-sidenum' }, String(ov?.counts?.backups ?? 0)),
    el('div', { class: 'c-sidelabel' }, '个备份')));
  side.append(el('div', { class: 'c-sideblock' },
    el('div', { class: 'c-sidenum' }, String((ov?.customized ?? []).length)),
    el('div', { class: 'c-sidelabel' }, '项已定制')));

  if (ov?.drift?.available && ov.drift.needReplay > 0) {
    side.append(el('div', { class: 'c-sideblock c-sidewarn' },
      el('div', { class: 'c-sidenum' }, String(ov.drift.needReplay)),
      el('div', { class: 'c-sidelabel' }, '项待重放')));
  }

  side.append(el('div', { class: 'c-sidefoot' },
    el('a', { href: '#', onclick: (e) => { e.preventDefault(); showConfigSnapshot(); } }, '当前配置快照 →')));
  root.append(side);

  // ══ 时间线主体 ══
  const main = el('main', { class: 'c-main' });
  const feed = el('div', { class: 'c-feed', id: 'c-feed' });
  main.append(feed);
  root.append(main);

  function syncFilters() {
    for (const b of bar.querySelectorAll('.c-filter')) {
      const label = b.textContent;
      b.dataset.on = String(
        (filter === 'all' && label === '全部')
        || (filter !== 'all' && label === (EVENT_META[filter]?.label ?? filter)),
      );
    }
  }

  function renderFeed() {
    feed.innerHTML = '';

    // 构造事件流：台账 + 备份（还原也是事件）
    let events = (ov?.recent ?? []).map((r) => ({ ...r, _kind: 'audit' }));
    // 全量台账需要单独接口；原型里用 overview.recent 已够展示

    if (filter !== 'all') {
      events = events.filter((e) => e.event === filter || (filter === 'apply' && String(e.event).startsWith('apply')));
    }
    if (query) {
      const q = query.toLowerCase();
      events = events.filter((e) => JSON.stringify(e).toLowerCase().includes(q));
    }

    if (!events.length) {
      feed.append(el('div', { class: 'c-empty' }, query || filter !== 'all' ? '没有匹配的记录' : '还没有任何操作记录'));
      return;
    }

    for (const e of events) {
      const meta = EVENT_META[e.event] ?? { icon: '·', label: e.event, color: 'var(--fg-faint)' };
      const node = el('article', { class: 'c-event', 'data-kind': String(e.event).split('-')[0] },
        el('div', { class: 'c-evt-rail' },
          el('div', { class: 'c-evt-dot', style: { color: meta.color } }, meta.icon),
          el('div', { class: 'c-evt-line' })),
        el('div', { class: 'c-evt-body' },
          el('div', { class: 'c-evt-head' },
            el('span', { class: 'c-evt-label', style: { color: meta.color } }, meta.label),
            el('span', { class: 'c-evt-time' }, rfmt(e.at)),
            e.verdict ? el('span', { class: 'c-evt-verdict', 'data-v': e.verdict }, VERDICT[e.verdict]?.label ?? e.verdict) : null),
          el('div', { class: 'c-evt-main' },
            e.handle ? el('code', {}, e.handle) : null,
            e.profile ? el('code', {}, e.profile) : null,
            e.backupId ? el('span', { class: 'c-evt-backup' }, `备份 ${e.backupId}`) : null),
          e.reason ? el('div', { class: 'c-evt-reason' }, e.reason) : null,
          el('div', { class: 'c-evt-foot' },
            e.auto !== undefined ? el('span', { class: 'c-tag' }, e.auto ? '自动对照' : '手工输入') : null,
            e.actor ? el('span', { class: 'c-tag' }, e.actor) : null),
        ));
      // 预览阶段：点击展开一条说明
      node.addEventListener('click', () => {
        const old = node.querySelector('.c-evt-expand');
        if (old) { old.remove(); return; }
        node.querySelector('.c-evt-body').append(el('div', { class: 'c-evt-expand' },
          el('pre', { class: 'c-json' }, JSON.stringify(e, null, 2))));
      });
      feed.append(node);
    }
  }

  function showConfigSnapshot() {
    main.innerHTML = '';
    const back = el('button', { class: 'c-back', onclick: () => { main.innerHTML = ''; main.append(feed); renderFeed(); } }, '← 回到时间线');
    main.append(back);

    main.append(el('h1', { class: 'c-snaph' }, '当前配置快照'));
    main.append(el('p', { class: 'c-snapp' }, '这是"时间线"的另一面 —— 事件累积的结果。'));

    const grid = el('div', { class: 'c-snapgrid' });
    const groups = ['personalization', 'style', 'prompt', 'rules'];
    for (const g of groups) {
      const hs = handles.filter((h) => h.id.startsWith(g));
      const box = el('div', { class: 'c-snapbox' },
        el('h2', {}, g === 'personalization' ? '身份与人格' : g === 'style' ? '风格内容' : g === 'prompt' ? '提示词模板' : '行为规则'),
        el('div', { class: 'c-snapcount' }, `${hs.length} 个把手`));
      for (const h of hs) {
        const mod = (ov?.customized ?? []).some((x) => x.id === h.id);
        box.append(el('div', { class: 'c-snaprow' },
          el('span', { class: 'c-snapname' }, h.title),
          mod ? el('span', { class: 'c-tag c-tag-mod' }, '已改') : el('span', { class: 'c-tag' }, '原厂')));
      }
      grid.append(box);
    }
    main.append(grid);
  }

  renderFeed();
}
