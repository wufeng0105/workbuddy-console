/**
 * 变体 A · 体检台
 *
 * 结构承诺：**首屏是一个"健康判定"**，不是列表。
 *   - 顶部：一句话结论（一切正常 / N 项要处理）
 *   - 主体：问题卡片流（按严重度排序），点开才看到细节
 *   - 侧栏极窄：只放"域"入口，不展开
 *
 * 适合：想快速知道"有没有异常"、偶尔进来检查一次的人。
 * 与 B 的区别：B 以"我要改什么"为轴，A 以"哪里不对"为轴。
 */
import { loadAll, el, groupOf, GROUPS, VERDICT, rfmt } from './shared.js';

export async function renderA(root) {
  root.innerHTML = '';
  root.append(el('div', { class: 'a-loading' }, '正在体检…'));

  let data;
  try { data = await loadAll(); } catch (e) {
    root.innerHTML = '';
    root.append(el('div', { class: 'a-err' }, `读取失败：${e.message}`));
    return;
  }
  const { overview: ov, approval, profiles, handles } = data;
  root.innerHTML = '';

  // ── 顶部：结论 ──
  const todoCount = (ov?.todos ?? []).length;
  const healthy = ov?.health?.ok && todoCount === 0;
  const running = ov?.gate?.appRunning === true;

  const head = el('header', { class: 'a-head' },
    el('div', { class: 'a-brand' }, 'workbuddy-console'),
    el('div', { class: 'a-verdict', 'data-ok': String(healthy) },
      el('span', { class: 'a-dot' }),
      el('span', {}, healthy ? '一切正常' : `${todoCount} 项需要处理`)),
    el('div', { class: 'a-meta' },
      `WorkBuddy ${ov?.version ?? '?'}`,
      el('span', { class: 'a-sep' }, '·'),
      `锚点 ${ov?.health?.anchors ?? 0} 个${ov?.health?.anchorFailures ? ` / ${ov.health.anchorFailures} 失效` : ''}`,
      el('span', { class: 'a-sep' }, '·'),
      running ? '应用运行中（写操作会拒绝）' : '应用未运行'),
  );
  root.append(head);

  // ── 指标条 ──
  root.append(el('div', { class: 'a-metrics' },
    metric('把手', ov?.counts?.handles ?? handles.length),
    metric('档位', ov?.counts?.profiles ?? profiles.length),
    metric('备份', ov?.counts?.backups ?? 0),
    metric('台账', ov?.counts?.audit ?? 0),
    metric('已改过', (ov?.customized ?? []).length),
  ));

  // ── 问题卡片流 ──
  const feed = el('div', { class: 'a-feed' });

  for (const t of (ov?.todos ?? [])) {
    feed.append(card({
      sev: t.severity,
      title: t.title,
      body: t.detail,
      tag: t.kind === 'replay' ? '需重放' : t.kind === 'anchor' ? '锚点' : t.kind,
    }));
  }

  // 升级状态卡
  if (ov?.drift?.available) {
    const d = ov.drift;
    if (d.needReplay > 0) {
      feed.append(card({ sev: 'warn', title: `升级后有 ${d.needReplay} 项定制不在了`, body: `${d.bundleVersion} → ${d.currentVersion}`, tag: '版本' }));
    } else if (d.versionChanged) {
      feed.append(card({ sev: 'info', title: '版本变了，但定制都还在', body: `${d.bundleVersion} → ${d.currentVersion}`, tag: '版本' }));
    }
  } else if (ov?.drift && !ov.drift.available) {
    feed.append(card({ sev: 'info', title: '还没有重放包', body: '无法判断升级后定制是否还在 —— 建议建一个', tag: '版本' }));
  }

  // 闸门卡
  if (running) {
    feed.append(card({
      sev: 'info',
      title: 'WorkBuddy 正在运行',
      body: '要求停机的把手（提示词模板、行为规则）会拒绝写入，而不是写了不生效。',
      tag: '闸门',
    }));
  }

  // 审批档位卡
  if (approval && !approval.error) {
    const askTotal = (approval.rules?.pending?.readAsk ?? 0) + (approval.rules?.pending?.writeAsk ?? 0) + (approval.rules?.pending?.deleteAsk ?? 0);
    const cur = approval.prompts?.[0]?.level?.level ?? '?';
    feed.append(card({
      sev: askTotal > 0 ? 'info' : 'ok',
      title: askTotal > 0 ? `还有 ${askTotal} 条规则会弹审批` : '规则面已全放开',
      body: `提示词面档位：${cur}　·　write=ask ${approval.rules?.pending?.writeAsk ?? 0} / delete=ask ${approval.rules?.pending?.deleteAsk ?? 0}`,
      tag: '审批',
      expand: () => renderApprovalDetail(approval),
    }));
  }

  // 已改过的把手
  if ((ov?.customized ?? []).length) {
    for (const c of ov.customized) {
      feed.append(card({
        sev: 'info',
        title: `已定制：${c.title}`,
        body: c.path,
        tag: '定制',
      }));
    }
  }

  // 无重放包 → 未知
  if ((ov?.unknown ?? []).length && !(ov?.customized ?? []).length) {
    feed.append(card({
      sev: 'info',
      title: `${ov.unknown.length} 个把手的状态未知`,
      body: '没有重放包基线，无法判断是否被改过 —— 不猜。建重放包后可判定。',
      tag: '未知',
    }));
  }

  if (!feed.children.length) {
    feed.append(el('div', { class: 'a-empty' }, '没有任何需要注意的问题。'));
  }
  root.append(feed);

  // ── 最近改动 ──
  if ((ov?.recent ?? []).length) {
    const recent = el('section', { class: 'a-recent' }, el('h2', {}, '最近改动'));
    const list = el('div', { class: 'a-timeline' });
    for (const r of ov.recent.slice(0, 8)) {
      list.append(el('div', { class: 'a-tli' },
        el('span', { class: 'a-tlt' }, rfmt(r.at)),
        el('span', { class: 'a-tle' }, r.event),
        el('span', { class: 'a-tlh' }, r.handle ?? r.profile ?? r.backupId ?? ''),
        r.verdict ? el('span', { class: 'a-tlv', 'data-v': r.verdict }, VERDICT[r.verdict]?.label ?? r.verdict) : null,
      ));
    }
    recent.append(list);
    root.append(recent);
  }

  // ── 极窄侧栏：域入口 ──
  const rail = el('nav', { class: 'a-rail' });
  for (const g of GROUPS) {
    const n = handles.filter(g.match).length;
    rail.append(el('a', { href: '#', title: g.note, onclick: (e) => { e.preventDefault(); alert(`${g.title}\n${n} 个把手\n\n${g.note}\n\n（原型只读，不进入编辑）`); } },
      el('span', { class: 'a-rail-n' }, String(n)),
      el('span', { class: 'a-rail-t' }, g.title),
    ));
  }
  root.append(rail);
}

function metric(k, v) {
  return el('div', { class: 'a-metric' },
    el('div', { class: 'a-metric-v' }, String(v)),
    el('div', { class: 'a-metric-k' }, k));
}

function card({ sev = 'info', title, body, tag, expand }) {
  const c = el('article', { class: 'a-card', 'data-sev': sev },
    el('div', { class: 'a-card-tag' }, tag ?? ''),
    el('h3', { class: 'a-card-title' }, title),
    body ? el('p', { class: 'a-card-body' }, body) : null,
  );
  if (expand) {
    c.classList.add('a-card-clickable');
    c.addEventListener('click', () => {
      const old = c.querySelector('.a-card-expand');
      if (old) { old.remove(); return; }
      c.append(el('div', { class: 'a-card-expand' }, expand()));
    });
  }
  return c;
}

function renderApprovalDetail(approval) {
  const box = el('div', {});
  box.append(el('div', { class: 'a-face a-face-reliable' },
    el('strong', {}, '规则面（宿主弹窗）'),
    el('span', { class: 'a-badge' }, '✅ 可可靠验证'),
    el('div', {}, `read=ask ${approval.rules?.pending?.readAsk ?? 0} · write=ask ${approval.rules?.pending?.writeAsk ?? 0} · delete=ask ${approval.rules?.pending?.deleteAsk ?? 0}`),
  ));
  box.append(el('div', { class: 'a-face a-face-uncertain' },
    el('strong', {}, '提示词面（模型自己问）'),
    el('span', { class: 'a-badge' }, '⚠️ 无法保证'),
    el('div', {}, approval.prompts?.map((p) => `${p.handle.replace('prompt.welcomemode-', '')}: ${p.level?.level ?? '?'}`).join('　')),
    el('div', { class: 'a-face-note' }, '即使文本进了请求，也证明不了模型不再自己问 —— 这取决于模型自身对齐。'),
  ));
  return box;
}
