/**
 * 变体 B · 工作面
 *
 * 结构承诺：**三栏逐级深入**（域 → 项 → 详情），像 IDE / 邮件客户端。
 *   - 第 1 栏：四个域（身份/风格/提示词/规则）+ 档位 + 守护
 *   - 第 2 栏：该域的把手列表，带状态灯
 *   - 第 3 栏：选中把手的完整工作面（现状 / 编辑 / 差异 / 验证 / 历史）
 *
 * 适合：明确知道要改什么、要深度操作的人。
 * 与 A 的区别：A 是"问题导向"，B 是"对象导向"；B 允许停留在某个对象上反复操作。
 */
import { loadAll, api, el, GROUPS, groupOf, VERDICT, rfmt } from './shared.js';

export async function renderB(root) {
  root.innerHTML = '';
  const data = await loadAll().catch((e) => ({ error: e.message }));
  if (data.error) { root.append(el('div', { class: 'b-err' }, `读取失败：${data.error}`)); return; }

  const { overview: ov, approval, profiles, handles } = data;
  const S = { col1: 'customize', group: 'identity', handleId: handles[0]?.id ?? null, probe: null, detail: null };

  root.innerHTML = '';
  root.append(
    el('div', { class: 'b-col1', id: 'b-col1' }),
    el('div', { class: 'b-col2', id: 'b-col2' }),
    el('div', { class: 'b-col3', id: 'b-col3' }),
  );

  // ══ 第 1 栏 ══
  function renderCol1() {
    const c = document.getElementById('b-col1');
    c.innerHTML = '';
    c.append(el('div', { class: 'b-logo' }, 'wb', el('span', {}, 'console')));

    const nav = el('nav', { class: 'b-nav' });
    const item = (key, icon, label, badge) => el('button', {
      class: 'b-navitem',
      'data-on': String(S.col1 === key),
      onclick: () => { S.col1 = key; renderCol1(); renderCol2(); renderCol3(); },
    }, el('span', { class: 'b-navicon' }, icon), el('span', { class: 'b-navlabel' }, label),
    badge ? el('span', { class: 'b-navbadge' }, String(badge)) : null);

    nav.append(item('customize', '◈', '定制', handles.length));
    nav.append(item('profiles', '◐', '档位', profiles.length));
    nav.append(item('guard', '⛨', '守护', (ov?.counts?.backups ?? 0)));
    nav.append(item('boundary', '⊘', '边界', null));
    c.append(nav);

    // 底部状态
    const running = ov?.gate?.appRunning === true;
    c.append(el('div', { class: 'b-status' },
      el('div', { class: 'b-statusrow' },
        el('span', { class: 'b-dot', 'data-ok': String(ov?.health?.ok) }),
        `锚点 ${ov?.health?.anchors ?? 0}`,
        ov?.health?.anchorFailures ? el('span', { class: 'b-bad' }, ` / ${ov.health.anchorFailures} 失效`) : null),
      el('div', { class: 'b-statusrow' },
        el('span', { class: 'b-dot', 'data-run': String(running) }),
        running ? '运行中' : '未运行'),
      el('div', { class: 'b-statusrow b-dim' }, `v${ov?.version ?? '?'}`),
    ));
  }

  // ══ 第 2 栏 ══
  function renderCol2() {
    const c = document.getElementById('b-col2');
    c.innerHTML = '';

    if (S.col1 === 'customize') {
      // 域标签
      const tabs = el('div', { class: 'b-tabs' });
      for (const g of GROUPS) {
        tabs.append(el('button', {
          class: 'b-tab',
          'data-on': String(S.group === g.key),
          onclick: () => { S.group = g.key; S.handleId = handles.find(g.match)?.id ?? null; renderCol2(); renderCol3(); },
        }, g.title));
      }
      c.append(tabs);

      const g = GROUPS.find((x) => x.key === S.group) ?? GROUPS[0];
      c.append(el('div', { class: 'b-groupnote' }, g.note));

      const list = el('div', { class: 'b-list' });
      for (const h of handles.filter(g.match)) {
        const customized = (ov?.customized ?? []).some((x) => x.id === h.id);
        list.append(el('button', {
          class: 'b-item',
          'data-on': String(S.handleId === h.id),
          onclick: () => { S.handleId = h.id; renderCol2(); renderCol3(); },
        },
        el('div', { class: 'b-item-title' }, h.title),
        el('div', { class: 'b-item-sub' },
          el('span', { class: 'b-chip', 'data-risk': h.writeClass === 'vendor-file' ? 'vendor' : 'user' },
            h.writeClass === 'vendor-file' ? '厂商' : '用户'),
          h.privilege === 'elevated' ? el('span', { class: 'b-chip' }, '提权') : null,
          customized ? el('span', { class: 'b-chip b-chip-mod' }, '已改') : null,
        )));
      }
      c.append(list);
    }

    if (S.col1 === 'profiles') {
      c.append(el('div', { class: 'b-sechead' }, '专家档位'));
      const list = el('div', { class: 'b-list' });
      if (!profiles.length) list.append(el('div', { class: 'b-empty' }, '还没有档位'));
      for (const p of profiles) {
        list.append(el('div', { class: 'b-item b-item-static' },
          el('div', { class: 'b-item-title' }, p.name),
          el('div', { class: 'b-item-sub' }, `${p.covers.length} 项 · ${rfmt(p.createdAt)}`)));
      }
      c.append(list, el('div', { class: 'b-hint' }, '（原型只读，不提供采集/切换）'));
    }

    if (S.col1 === 'guard') {
      c.append(el('div', { class: 'b-sechead' }, '备份'));
      const list = el('div', { class: 'b-list' });
      for (const b of (ov?.backups ?? [])) {
        list.append(el('div', { class: 'b-item b-item-static' },
          el('div', { class: 'b-item-title' }, rfmt(b.createdAt)),
          el('div', { class: 'b-item-sub' }, `${b.entries} 项 · ${b.reason ?? ''}`)));
      }
      if (!(ov?.backups ?? []).length) list.append(el('div', { class: 'b-empty' }, '暂无备份'));
      c.append(list);
    }

    if (S.col1 === 'boundary') {
      c.append(el('div', { class: 'b-sechead' }, '边界'));
      c.append(el('div', { class: 'b-hint' }, '右侧显示"做不到的事"'));
      const list = el('div', { class: 'b-list' });
      for (const f of boundaryItems()) {
        list.append(el('button', {
          class: 'b-item', 'data-on': String(S.handleId === `boundary:${f.id}`),
          onclick: () => { S.handleId = `boundary:${f.id}`; renderCol2(); renderCol3(); },
        },
        el('div', { class: 'b-item-title' }, f.title),
        el('div', { class: 'b-item-sub' }, f.layer)));
      }
      c.append(list);
    }
  }

  // ══ 第 3 栏 ══
  async function renderCol3() {
    const c = document.getElementById('b-col3');
    c.innerHTML = '<div class="b-loading">读取中…</div>';

    if (S.col1 === 'boundary') {
      c.innerHTML = '';
      const id = String(S.handleId ?? '').replace('boundary:', '');
      const f = boundaryItems().find((x) => x.id === id) ?? boundaryItems()[0];
      c.append(boundaryDetail(f));
      return;
    }

    if (S.col1 === 'profiles' || S.col1 === 'guard') {
      c.innerHTML = '';
      c.append(el('div', { class: 'b-placeholder' },
        el('div', { class: 'b-ph-icon' }, '◫'),
        el('div', {}, S.col1 === 'profiles' ? '档位详情（原型只读）' : '守护与重放（原型只读）')));
      return;
    }

    const h = handles.find((x) => x.id === S.handleId);
    if (!h) { c.innerHTML = '<div class="b-placeholder">选择一个把手</div>'; return; }

    let probe;
    try { probe = await api(`/api/handle/${encodeURIComponent(h.id)}/probe`); }
    catch (e) { c.innerHTML = ''; c.append(el('div', { class: 'b-err' }, `探测失败：${e.message}`)); return; }

    c.innerHTML = '';
    // 头部
    c.append(el('div', { class: 'b-detail-head' },
      el('h1', {}, h.title),
      el('div', { class: 'b-detail-meta' },
        el('code', {}, h.id),
        el('span', { class: 'b-chip', 'data-risk': h.writeClass === 'vendor-file' ? 'vendor' : 'user' },
          h.writeClass === 'vendor-file' ? '厂商文件（需逐次确认）' : '用户目录'),
        el('span', { class: 'b-chip' }, h.privilege === 'elevated' ? '需提权' : '零提权'),
        el('span', { class: 'b-chip' }, h.channel),
        el('span', { class: 'b-chip' }, h.upgradeBehavior === 'survives' ? '升级存活' : '升级失效'),
      )));

    // 现状
    const kv = el('dl', { class: 'b-kv' });
    const add = (k, v) => kv.append(el('dt', {}, k), el('dd', {}, v));
    add('锚点', h.anchorPath ?? '—');
    add('验证策略', `${h.verification?.strategy} @ ${h.verification?.channel}`);
    if (probe?.state?.value !== undefined) add('当前取值', JSON.stringify(probe.state.value));
    if (probe?.state?.isActive !== undefined) add('是否生效档位', probe.state.isActive ? '是' : '否');
    if (probe?.state?.limits) {
      const L = probe.state.limits;
      add('注入上限', `${L.maxChars} 字符（当前 ${L.chars}${L.exceeded ? `, ⚠️ 超限丢弃 ${L.dropped}` : ''}）`);
    }
    if (probe?.state?.injectedChars != null) add('真正注入', `${probe.state.injectedChars} 字符`);
    if (probe?.state?.ruleCount != null) {
      add('规则数', String(probe.state.ruleCount));
      const s = probe.state.summary;
      add('动作分布', `read ${fmtDist(s.read)} · write ${fmtDist(s.write)} · delete ${fmtDist(s.delete)}`);
    }
    c.append(section('现状', kv));

    // 守卫提示
    const warns = [];
    if (h.writeClass === 'vendor-file') warns.push('这是**厂商文件**：升级可能覆盖它，且写入需显式确认。');
    if (h.id === 'personalization.identity') warns.push('该把手在**专家模式下不注入** —— 切到专家档位时"名字"会静默消失。');
    if (probe?.state?.limits?.exceeded) warns.push('当前内容已超过注入上限，超出部分**静默丢弃**。');
    if (probe?.state?.isActive === false) warns.push('该档位当前**未生效** —— 改它不会影响任何请求。');
    if (warns.length) {
      c.append(section('注意', el('div', {}, warns.map((w) => el('div', { class: 'b-warn' }, w)))));
    }

    // 编辑区（原型只读）
    c.append(section('编辑', el('div', { class: 'b-editor-ph' },
      el('div', { class: 'b-ph-icon' }, '✎'),
      el('div', {}, '原型阶段不接真实写入'),
      el('div', { class: 'b-dim' }, '正式版这里会有：编辑 → 差异预览（含 token/缓存代价）→ 应用 → 验证'))));

    // 验证
    c.append(section('验证', el('div', { class: 'b-verify-ph' },
      el('div', {}, '三态：', el('span', { class: 'b-v', 'data-v': 'effective' }, '生效'),
        el('span', { class: 'b-v', 'data-v': 'ineffective' }, '未生效'),
        el('span', { class: 'b-v', 'data-v': 'undetermined' }, '无法判定')),
      el('div', { class: 'b-dim' }, '正式版会展示证据链：基线/观测/模型/增量/MCP 干扰项，以及"为什么下不了结论"'))));
  }

  function fmtDist(d) {
    if (!d) return '—';
    return Object.entries(d).map(([k, v]) => `${k}${v === 1 ? '' : ':' + v}`).join(' ');
  }
  function section(title, body) {
    return el('section', { class: 'b-section' }, el('h2', { class: 'b-section-t' }, title), body);
  }

  renderCol1();
  renderCol2();
  await renderCol3();
}

function boundaryItems() {
  return [
    { id: 'upstream-filter', title: '流式内容过滤', layer: '上游 · 网关', evidence: 'gateway.md E 组：流式 token 级，L4 拦腰切断且 usage 清零' },
    { id: 'model-align', title: '模型自身对齐', layer: '上游 · 模型', evidence: '模型拒绝不会"先输出再切断"' },
    { id: 'managed', title: '托管策略覆盖', layer: '上游 · 服务端下发', evidence: 'securityCenter 块存在时覆盖本地 orderedRules' },
    { id: 'truncation', title: '身份文件 10 000 字符截断', layer: '客户端 · 注入前', evidence: 'authority-snapshot.js:53 Ls=1e4' },
    { id: 'expert-identity', title: '专家模式跳过 IDENTITY.md', layer: '客户端 · 模式分支', evidence: 'authority-snapshot.js:184 t.isExpert || …' },
    { id: 'model-ask', title: '提示词能否治住"模型自己问"', layer: '未知 · 待实测', evidence: '待实测 #4 —— 只能降低概率，无法保证' },
  ];
}

function boundaryDetail(f) {
  return el('div', {},
    el('div', { class: 'b-detail-head' }, el('h1', {}, f.title)),
    el('div', { class: 'b-pill' }, f.layer),
    el('div', { class: 'b-boundary-box' },
      el('div', { class: 'b-boundary-h' }, '为什么这里做不到'),
      el('div', {}, f.evidence),
      el('div', { class: 'b-dim', style: { marginTop: '12px' } },
        '这条边界会明确写在界面上，而不是让用户反复试错 —— 这是这个工具的核心价值之一。')));
}
