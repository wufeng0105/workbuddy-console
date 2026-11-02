/**
 * 前端自测 —— 零依赖、无浏览器、无服务端。
 *
 * 为什么要有它：前端的两个 P0 缺陷（`S.busy` 粘滞、probe 失败自激）都属"改回去也看不出来"
 * 的那一类——它们不报错、不抛异常，只是让界面安静地失去功能。没有断言守着，
 * 下一次重构（尤其是重写 render 或改守卫条件）极容易把它们带回来。
 *
 * 做法：在 Node 里执行**真实的** `web/app.js`，用一个极小的 DOM stub 顶替浏览器。
 * 不引入 jsdom、不启 Chrome、不碰网络——符合项目"零依赖、零外网、依赖树越小越易审计"的姿态。
 *
 * 运行：node --test test/frontend.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.join(HERE, '..', 'web', 'app.js');
const CORE_JS = path.join(HERE, '..', 'web', 'core.js');

/* ══════════════ 最小 DOM stub ══════════════ */
/*
 * 只实现 app.js 真正用到的那一小部分：createElement / 文本节点 / append / 属性 /
 * querySelector(All) / getElementById / classList / dataset / addEventListener / click。
 *
 * 刻意**不**做完整 DOM：越像浏览器，越容易掩盖"这段代码只有真浏览器才跑得对"的事实。
 * 我们要测的是状态机与守卫条件，不是渲染保真度。
 */

class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.listeners = {};
    this._text = '';
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.id = '';
  }

  get className() { return this.attributes.class ?? ''; }
  set className(v) { this.attributes.class = v; }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'id') this.id = String(v);
    if (k === 'class') this.attributes.class = String(v);
    if (k === 'disabled') this.disabled = true;
    if (k === 'checked') this.checked = true;
    if (k === 'value') this.value = String(v);
    if (k === 'title') this.attributes.title = String(v);
  }
  removeAttribute(k) { delete this.attributes[k]; }

  append(...kids) {
    for (const k of kids) {
      if (k === null || k === undefined || k === false || k === '') continue;
      if (k instanceof StubNode) { k.parentNode = this; this.children.push(k); }
      else { const t = new StubNode('#text'); t._text = String(k); t.parentNode = this; this.children.push(t); }
    }
  }
  appendChild(k) { this.append(k); return k; }
  removeChild(k) {
    const i = this.children.indexOf(k);
    if (i >= 0) this.children.splice(i, 1);
    return k;
  }
  get firstChild() { return this.children[0] ?? null; }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) {
    const l = this.listeners[type];
    if (l) this.listeners[type] = l.filter((x) => x !== fn);
  }
  /** 派发事件（真实浏览器行为；测试模拟"用户输入"必须走它，否则 input 监听不会被触发） */
  dispatchEvent(ev) {
    const type = typeof ev === 'string' ? ev : ev?.type;
    const event = typeof ev === 'string' ? { type, target: this } : { target: this, ...ev };
    for (const fn of this.listeners[type] ?? []) fn(event);
    return true;
  }
  /** 触发 click（含 onclick 属性） */
  click() {
    const ev = { target: this, preventDefault() {}, stopPropagation() {} };
    for (const fn of this.listeners.click ?? []) fn(ev);
    const oc = this.attributes.onclick;
    if (typeof oc === 'function') oc(ev);
  }

  /** 文本内容：自身文本 + 所有后代文本 */
  get textContent() {
    if (this.tagName === '#TEXT') return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) { this.children = []; this._text = String(v); }
  get innerHTML() { return this._html ?? ''; }
  set innerHTML(v) { this._html = String(v); this.children = []; }

  get classList() {
    const self = this;
    return {
      contains: (c) => self.className.split(/\s+/).includes(c),
      add: (c) => { if (!self.classList.contains(c)) self.className = `${self.className} ${c}`.trim(); },
      remove: (c) => { self.className = self.className.split(/\s+/).filter((x) => x !== c).join(' '); },
      toggle: (c) => { self.classList.contains(c) ? self.classList.remove(c) : self.classList.add(c); },
    };
  }

  /** 深度优先遍历 */
  *walk() {
    for (const c of this.children) {
      if (c instanceof StubNode) { yield c; yield* c.walk(); }
    }
  }

  matches(sel) {
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
      if (!m) return false;
      const [, k, v] = m;
      const has = Object.prototype.hasOwnProperty.call(this.attributes, k);
      return v === undefined ? has : has && this.attributes[k] === v;
    }
    return this.tagName === sel.toUpperCase();
  }

  querySelectorAll(sel) {
    const parts = String(sel).split(/\s+/).filter(Boolean);
    let pool = [...this.walk()];
    for (const p of parts) pool = pool.filter((n) => n.matches(p));
    return pool;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

class StubDocument {
  constructor() {
    this.documentElement = new StubNode('html');
    this.body = new StubNode('body');
    this.head = new StubNode('head');
    this.documentElement.append(this.body, this.head);
    this._byId = new Map();
  }
  createElement(tag) { return new StubNode(tag); }
  createTextNode(t) { const n = new StubNode('#text'); n._text = String(t); return n; }
  getElementById(id) {
    if (this._byId.has(id)) {
      const n = this._byId.get(id);
      // 已被移出文档的不再返回（模拟真实 getElementById）
      let cur = n;
      while (cur) { if (cur === this.body) return n; cur = cur.parentNode; }
      this._byId.delete(id);
    }
    return this.body.querySelectorAll(`#${id}`)[0] ?? null;
  }
  registerId(node) { if (node.id) this._byId.set(node.id, node); }
  querySelector(sel) { return this.body.querySelector(sel); }
  querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
}

/* ══════════════ 安装全局、加载真实 app.js ══════════════ */

/** @type {{apiCalls: Array<{path:string, opts:any}>, mode:string, respond:(p:string,a:any)=>any}} */
let H;

function makeHarness({ mode = 'ok', overview = {}, handles = [], profiles = [], probeOverride = null, drift = null, audit = null } = {}) {
  const doc = new StubDocument();
  const apiCalls = [];

  const respond = (p, opts) => {
    if (mode === 'down') {
      const e = new Error('缺少或错误的会话令牌');
      e.code = 'UNAUTHORIZED';
      throw e;
    }
    if (p === '/api/overview') return overview;
    if (p === '/api/doctor') return { version: '5.9.3', anchors: [], handles };
    if (p === '/api/profiles') return profiles;
    if (p === '/api/approval') return { levels: [], prompts: [], rules: null };
    if (p === '/api/drift') return drift ?? { ok: false, reason: 'no bundle', results: [], needReplay: [] };
    if (p.startsWith('/api/audit')) return audit ?? [];
    if (p === '/api/baseline') return { available: true, versionKey: '5.9.3(t)', capturedAt: '2026-11-01T00:00:00Z', entries: {}, ledgers: [] };
    if (p.includes('/probe')) {
      if (mode === 'probe-down') { const e = new Error('probe 失败'); e.code = 'EPERM'; throw e; }
      const id = decodeURIComponent(/\/api\/handle\/([^/]+)\/probe/.exec(p)?.[1] ?? '');
      // probeOverride：让用例能构造"枚举型 / 规则型"的探针结果（默认那个只像纯文本把手）
      if (probeOverride && probeOverride[id]) return probeOverride[id];
      return { handle: { id, title: `把手 ${id}`, writeClass: 'user-data' }, state: { exists: true, text: 'x', bytes: 1, sha256: 'ab', tokens: { tokens: 1 } } };
    }
    if (p.startsWith('/api/profiles/')) {
      if (mode === 'detail-down') { const e = new Error('detail 失败'); e.code = 'ERR'; throw e; }
      return { id: 'p1', name: 'p1', values: {} };
    }
    return {};
  };

  // 全局注入（app.js / core.js 直接引用这些全局）
  globalThis.document = doc;
  globalThis.Node = StubNode;          // core.js 的 appendKids 用 `k instanceof Node` 判断节点
  globalThis.window = { scrollTo() {}, location: { href: 'http://127.0.0.1:1/', search: '?token=T', pathname: '/' } };
  globalThis.location = globalThis.window.location;
  globalThis.history = { replaceState() {} };
  globalThis.sessionStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
  };
  globalThis.fetch = async (p, opts = {}) => {
    apiCalls.push({ path: p, opts });
    const data = respond(p, opts);
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  return { doc, apiCalls, mode, handles };
}

/** 每次测试都重新加载模块（模块顶层会读 location / sessionStorage） */
async function loadApp(harnessOpts) {
  H = makeHarness(harnessOpts);
  // 关掉自动 boot：测试要自己控制启动时机（并让 boot 能重复调用）
  globalThis.process = globalThis.process ?? {};
  globalThis.process.env = globalThis.process.env ?? {};
  globalThis.process.env.WBC_NO_AUTOBOOT = '1';
  // sessionStorage 必须逐测试清零：否则上一条测试留下的 'wbc-expanded' / 页签会串到本条，
  // 让"渲染了但内容不对"看起来像"没渲染"（这条曾让 T16 的新断言误报）。
  globalThis.sessionStorage._m.clear();
  const bust = `?t=${Math.random().toString(36).slice(2)}`;
  const app = await import(`${pathToFileURL(APP_JS).href}${bust}`);
  H.app = app;
  return { app, H };
}

/** app.js 的 boot() 是启动入口：它渲染到 #app */
async function boot() {
  const root = new StubNode('div');
  root.id = 'app';
  H.doc.body.append(root);
  H.doc.registerId(root);
  await H.app.boot();
  await new Promise((r) => setTimeout(r, 60));   // 让 queueMicrotask / 首屏异步加载落地
  return root;
}

const readHead = () => fs.readFileSync(APP_JS, 'utf8');
/* ══════════════ 静态结构断言（不需要跑起来） ══════════════ */

test('P0/T11：S.busy 只允许一处置位、一处复位，且复位在 finally 里', () => {
  const src = readHead();
  const sets = src.match(/S\.busy\s*=\s*true/g) ?? [];
  const resets = src.match(/S\.busy\s*=\s*false/g) ?? [];
  assert.equal(sets.length, 1, `S.busy=true 应只出现 1 次（实际 ${sets.length} 次）——分散置位是 D4 的成因`);
  assert.equal(resets.length, 1, `S.busy=false 应只出现 1 次（实际 ${resets.length} 次）——复位点分散必然漏配`);
  assert.match(
    src,
    /finally\s*\{[\s\S]{0,120}S\.busy\s*=\s*false/,
    'S.busy 的复位必须在 finally 里，否则抛异常就会永久锁死界面',
  );
});

test('P0/T11：三个会置忙的函数都走 runBusy 包装', () => {
  const src = readHead();
  for (const fn of ['doApply', 'doCaptureBaseline', 'doRestoreBaseline']) {
    const body = new RegExp(`async function ${fn}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(src);
    assert.ok(body, `找不到 ${fn}`);
    assert.match(body[1], /runBusy\(/, `${fn} 必须经 runBusy 包装，否则它自己置忙就会漏复位`);
  }
});

/** 去掉注释，只留可执行代码 —— 静态断言必须只看代码，否则会被"注释里举的反例"误导 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')     // 块注释
    .replace(/^[ \t]*\/\/.*$/gm, '');      // 行注释
}

test('P0/T12：probe 失败必须是独立态，不得再写成 null', () => {
  const code = stripComments(readHead());
  assert.doesNotMatch(code, /S\.probes\[[^\]]*\]\s*=\s*null/, 'S.probes 不许用 null 表示失败（D1 成因）');
  assert.doesNotMatch(code, /S\.profileDetails\[[^\]]*\]\s*=\s*null/, 'S.profileDetails 同理');
  assert.match(code, /FAILED/, '必须有一个专门的失败标记');
  assert.match(code, /probeNeedsLoad/, '守卫必须区分"未加载"与"失败"');
});

/* ══════════════ 行为断言（执行真实 app.js） ══════════════ */

test('P0/回归：「编辑 → 点应用」必须把**用户输入的内容**发出去，不能被 render 冲掉', async () => {
  /**
   * 真实用户报告（2026-11-02）：
   *   在 SOUL.md 编辑器里加了内容 → 点「应用」→ 提示「已写入 … 备份 null」→ 内容没变。
   *
   * 根因：`runBusy` 在 `fn()` **之前**调了 `render()`。
   * `render()` 会用"上次探测到的内容"重建界面，把 textarea 里未保存的编辑**冲掉**；
   * 随后 `getNext()` 读到的是原文 → 后端正确地判成 noop → 备份 null。
   *
   * 这条断言直接盯住"发出去的 next 是不是用户打的字"。
   */
  const handles = [
    { id: 'personalization.soul', title: '人设设定（SOUL.md）', writeClass: 'user-data', anchorOk: true, inputKind: undefined },
  ];
  await loadApp({ mode: 'ok', handles });
  const root = await boot();

  // 进「个性化」并展开 SOUL 卡
  const nav = root.querySelectorAll('.nav-tab').find((b) => b.textContent.trim() === '个性化');
  nav.click();
  await new Promise((r) => setTimeout(r, 80));
  const card = root.querySelectorAll('.acc').find((c) => (c.querySelector('.acc-title')?.textContent ?? '').includes('SOUL'));
  assert.ok(card, '找不到 SOUL 卡');
  if (card.dataset.open !== 'true') card.querySelector('.acc-head').click();
  await new Promise((r) => setTimeout(r, 120));

  const ta = root.querySelectorAll('#editor')[0];
  assert.ok(ta, '找不到编辑器（#editor）');

  // 模拟用户输入（追加一段）——必须派发 input 事件，否则草稿不会被记录
  const TYPED = `${ta.value}\n\n- 我手动加的这一行必须真的写进去`;
  ta.value = TYPED;
  ta.dispatchEvent({ type: 'input' });

  // 清空请求记录，只观察点「应用」之后发了什么
  H.apiCalls.length = 0;
  const applyBtn = root.querySelectorAll('.btn-primary').find((b) => b.textContent.trim() === '应用');
  assert.ok(applyBtn, '找不到「应用」按钮');
  applyBtn.click();
  await new Promise((r) => setTimeout(r, 120));

  const applyCall = H.apiCalls.find((c) => /\/apply$/.test(c.path));
  assert.ok(applyCall, '没有发出 apply 请求');
  // 注意：web/core.js 的 api() 传给 fetch 的 body 是 JSON **字符串**，不是对象。
  // 直接 opts.body.next 会拿到 undefined —— 我第一次就是这么误判的。
  const raw = applyCall.opts?.body;
  const sent = typeof raw === 'string' ? JSON.parse(raw).next : raw?.next;
  assert.equal(
    sent, TYPED,
    `发出去的必须是用户打的那份文本。实际发出: ${JSON.stringify(String(sent).slice(0, 80))}`,
  );
});

test('P0/回归：noop 时不许显示「已写入 … 备份 null」', () => {
  /**
   * noop 分支的 backupId 是 null，但 flash 文案硬拼了 `备份 ${r.backupId}`
   * → 用户看到「已写入 personalization.soul　备份 null」，既像成功又像出错。
   */
  const code = stripComments(readHead());
  assert.match(code, /r\.noop/, 'doApply 必须识别 noop 并单独提示');

  // 「已写入 … 备份 …」这句必须排在 noop 判断之后，否则 noop 也会走这句
  const body = /async function doApply[\s\S]*?\n\}/.exec(code)?.[0] ?? '';
  const noopAt = body.indexOf('r.noop');
  const bannerAt = body.indexOf('已写入 ');
  assert.ok(noopAt >= 0, 'doApply 里必须有 noop 分支');
  assert.ok(bannerAt > noopAt, '「已写入 … 备份 …」必须排在 noop 判断之后（否则 noop 也走这句）');
});

test('P0/回归：render 不得冲掉**枚举下拉**的选择（同一类缺陷的另一个面）', async () => {
  /**
   * 与 textarea 完全同源的问题：`render()` 按"探测到的值"重建 `<select>`，
   * 用户刚选的档位会被弹回去，随后「应用」写回去的是旧值。
   * 只给 textarea 打补丁就会漏掉这一面 —— 所以要一条断言钉住。
   */
  const handles = [
    { id: 'personalization.tone-style', title: '回复风格', writeClass: 'user-data', anchorOk: true },
  ];
  await loadApp({
    mode: 'ok',
    handles,
    // 探针要返回 allowedValues 才会渲染成下拉
    probeOverride: {
      'personalization.tone-style': {
        handle: { id: 'personalization.tone-style', title: '回复风格', writeClass: 'user-data' },
        state: { exists: true, value: 'efficient', allowedValues: ['efficient', 'professional', 'creative'], text: '', bytes: 0 },
      },
    },
  });
  const root = await boot();
  const nav = root.querySelectorAll('.nav-tab').find((b) => b.textContent.trim() === '个性化');
  nav.click();
  await new Promise((r) => setTimeout(r, 100));
  const card = root.querySelectorAll('.acc').find((c) => (c.querySelector('.acc-title')?.textContent ?? '').includes('回复风格'));
  assert.ok(card, '找不到 toneStyle 卡');
  if (card.dataset.open !== 'true') card.querySelector('.acc-head').click();
  await new Promise((r) => setTimeout(r, 120));

  const sel = root.querySelectorAll('#editor')[0];
  assert.ok(sel, '找不到下拉');
  sel.value = 'professional';
  sel.dispatchEvent({ type: 'change' });

  // 触发一次 render（模拟进度刷新 / 导航往返 / 错误提示）
  const overviewTab = root.querySelectorAll('.nav-tab').find((b) => b.textContent.trim() === '总览');
  overviewTab.click();
  await new Promise((r) => setTimeout(r, 40));
  nav.click();
  await new Promise((r) => setTimeout(r, 60));
  const card2 = root.querySelectorAll('.acc').find((c) => (c.querySelector('.acc-title')?.textContent ?? '').includes('回复风格'));
  if (card2 && card2.dataset.open !== 'true') card2.querySelector('.acc-head').click();
  await new Promise((r) => setTimeout(r, 120));

  const selAfter = root.querySelectorAll('#editor')[0];
  assert.equal(selAfter?.value, 'professional',
    'render 之后下拉必须还是用户选的 professional；被弹回 efficient 说明选择被冲掉了');
});

test('P0/回归：render 不得冲掉**勾选框**状态（规则动作 / 厂商确认）', async () => {
  const handles = [
    { id: 'rules.file', title: '规则 · 文件路径', writeClass: 'user-data', anchorOk: true, inputKind: 'rule-op' },
  ];
  await loadApp({
    mode: 'ok',
    handles,
    probeOverride: {
      'rules.file': {
        handle: { id: 'rules.file', title: '规则 · 文件路径', writeClass: 'user-data', inputKind: 'rule-op' },
        state: { exists: true, ruleCount: 3, summary: { read: 'ask', write: 'ask', delete: 'ask' }, text: '{}', bytes: 2 },
      },
    },
  });
  const root = await boot();
  root.querySelectorAll('.nav-tab').find((b) => b.textContent.trim() === '个性化').click();
  await new Promise((r) => setTimeout(r, 100));
  const card = root.querySelectorAll('.acc').find((c) => (c.querySelector('.acc-title')?.textContent ?? '').includes('规则'));
  if (card && card.dataset.open !== 'true') card.querySelector('.acc-head').click();
  await new Promise((r) => setTimeout(r, 120));

  const del = root.querySelectorAll('#act-delete')[0];
  assert.ok(del, '找不到 act-delete 勾选框');
  del.checked = true;
  del.dispatchEvent({ type: 'change' });

  // 触发 render
  root.querySelectorAll('.nav-tab').find((b) => b.textContent.trim() === '总览').click();
  await new Promise((r) => setTimeout(r, 40));
  root.querySelectorAll('.nav-tab').find((b) => b.textContent.trim() === '个性化').click();
  await new Promise((r) => setTimeout(r, 60));
  const card2 = root.querySelectorAll('.acc').find((c) => (c.querySelector('.acc-title')?.textContent ?? '').includes('规则'));
  if (card2 && card2.dataset.open !== 'true') card2.querySelector('.acc-head').click();
  await new Promise((r) => setTimeout(r, 120));

  const delAfter = root.querySelectorAll('#act-delete')[0];
  assert.equal(delAfter?.checked, true,
    'render 之后勾选必须还在；被重置为未勾说明用户的选择被冲掉了');
});

/* ══════════════ 四条不变量的守卫（六大域通读后补） ══════════════ */

test('I1：审批确认勾选框必须跨 render 存活（第 5 个输入面）', () => {
  /**
   * 通读发现：`approval-confirm` 与厂商确认勾选框是同一类，但当时只保护了后者。
   * 后果：用户勾了确认，一次重渲染又回到未勾 → 点「应用变更」被自己写的守卫拦下
   * （"应用前需要先勾选确认"），用户会以为按钮坏了。
   */
  const code = stripComments(readHead());
  const idx = code.indexOf("id: 'approval-confirm'");
  assert.ok(idx >= 0, '找不到 approval-confirm 控件');
  // 取控件定义之后的一小段（不用正则定界，避免匹配符号写错）
  const near = code.slice(idx, idx + 320);
  assert.match(near, /recallField/, 'approval-confirm 必须用 recallField 取初值');
  assert.match(near, /rememberField/, 'approval-confirm 必须用 rememberField 存值');
});

test('I1：所有 setAttribute 式的输入面都在保全名单里', () => {
  // 反例检查：新加一个勾选框/下拉时，若忘了接 recallField，这里会提醒
  const code = stripComments(readHead());
  const ids = [...code.matchAll(/id:\s*'((?:act-|confirm-|approval-|editor)[\w-]*)'/g)].map((m) => m[1]);
  const unique = [...new Set(ids)];
  const missing = [];
  for (const id of unique) {
    // 每个受控输入的创建点附近都应当出现 recallField
    const near = new RegExp(`id: '${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'[\\s\\S]{0,600}?recallField`).test(code);
    if (!near) missing.push(id);
  }
  assert.deepEqual(missing, [],
    `这些输入控件没有接输入保全（render 会冲掉用户的值）：${missing.join('、')}`);
});

test('I2：写事务必须走 runBusy（防双击双写）', () => {
  /**
   * 通读发现：审批应用、重放（全部/选中）都是**写事务**（落盘 + 建备份），
   * 当时都没走 runBusy → 连点两下就写两遍、建两份备份。
   */
  const code = stripComments(readHead());
  for (const fn of ['doApplyApprovalSel', 'doReplaySel', 'doReplay', 'doApply', 'doCaptureBaseline', 'doRestoreBaseline', 'doRestore']) {
    const body = new RegExp(`(?:async )?function ${fn}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(code);
    assert.ok(body, `找不到 ${fn}`);
    assert.match(body[1], /runBusy\(/, `${fn} 会写盘，必须经 runBusy 包住（否则双击写两次）`);
  }
});

test('I3：render 不得修改状态（渲染必须是纯的）', async () => {
  /**
   * 反例：`guardWork()` 曾写 `if (bundleOk && S.replaySel === null) S.replaySel = [...d.needReplay]`
   * —— 渲染时顺手初始化状态。后果是数据刷新后选中集合残留旧 id，
   * 「仅重放选中项」会把已经不需要重放的项送上去。
   *
   * 用行为验证而不是静态检查：静态分不清"渲染时执行"和"事件处理器里执行"。
   */
  const handles = [
    { id: 'personalization.soul', title: '人设设定（SOUL.md）', writeClass: 'user-data', anchorOk: true },
  ];
  await loadApp({
    mode: 'ok',
    handles,
    drift: { ok: true, bundleCreatedAt: '2026-11-01T00:00:00Z', bundleVersion: '5.9.3', currentVersion: '5.9.3', versionChanged: false, needReplay: ['prompt.welcomemode-code'], results: [{ id: 'prompt.welcomemode-code', kind: 'vendor-restored', detail: '被替换' }] },
    audit: [],
  });
  const { app } = H;
  const root = await boot();

  // 进守护页（渲染它在旧代码里会改状态）
  root.querySelectorAll('.nav-tab').find((b) => b.textContent.trim() === '守护').click();
  await new Promise((r) => setTimeout(r, 80));

  const snap = () => JSON.stringify({
    replaySel: app.__state.replaySel,
    expanded: app.__state.expanded,
    profileExpanded: app.__state.profileExpanded,
    approvalLevel: app.__state.approvalLevel,
    nav: app.__state.nav,
  });

  /**
   * 关键：必须把 `replaySel` 手动置回 null 再渲染。
   *
   * 第一版漏了这一步，导致断言**抓不到**那个违反（空转）：
   * 进守护页时的第一次 render 就已经把 null 初始化掉了，
   * 之后无论渲染多少次，值都不再变 —— 快照对比自然相等。
   *
   * 正确姿势：把状态摆到"渲染前还需要初始化"的位置，再看渲染会不会动它。
   */
  app.__state.replaySel = null;
  const before = snap();
  app.render();
  app.render();          // 渲染两次更要稳定
  const after = snap();

  assert.equal(after, before, 'render 前后状态必须完全一致（渲染函数不许改状态）');
  assert.ok(root.querySelector('.ledger') || root.textContent.includes('守护'), '守护页应已渲染');
});

test('I4：三态色映射完整（effective/ineffective/undetermined 各有独立 class）', () => {
  const code = stripComments(readHead());
  for (const [verdict, cls] of [['effective', 'mk-ok'], ['ineffective', 'mk-bad'], ['undetermined', 'mk-warn']]) {
    assert.match(code, new RegExp(`${verdict}[^\\n]*${cls}|${cls}[^\\n]*${verdict}`),
      `${verdict} 必须有独立的颜色 class（当前配 ${cls}）`);
  }
});

test('I5：不许用原生 prompt/confirm（无头环境会阻塞页面）', () => {
  /**
   * 原生弹窗在自动化/CDP 环境里会阻塞整个页面（表现是"点了没反应"），
   * 且无法表达"这是危险操作"的语气。统一换成站内 dialog()。
   */
  const code = stripComments(readHead());
  assert.doesNotMatch(code, /\bwindow\.confirm\s*\(/, '不许用 window.confirm');
  assert.doesNotMatch(code, /(^|[^.\w])prompt\s*\(/, '不许用裸 prompt()');
  assert.doesNotMatch(code, /(^|[^.\w])confirm\s*\(/, '不许用裸 confirm()');
  assert.match(code, /function dialog\(/, '必须提供站内 dialog 实现');
  assert.match(code, /askText|askConfirm/, '必须有 askText/askConfirm 便捷封装');
});

test('I6：探测缓存必须有有效期（否则页面一直显示外部已改的旧值）', () => {
  /**
   * 探测结果存在内存里，若没有有效期，页面开着时文件被外部改了，
   * 界面会一直显示旧值——用户会照着一个过期的"当前内容"去改，
   * 这直接违反状态契约（运行时才是数据源）。
   */
  const code = stripComments(readHead());
  assert.match(code, /PROBE_TTL_MS\s*=/, '必须有探测缓存的 TTL 常量');
  assert.match(code, /function probeNeedsRefresh/, '必须有"需要刷新"的判据');
  assert.match(code, /refreshStaleProbes/, '必须有刷新过期缓存的实现');
  const guard = /function probeNeedsRefresh[\s\S]{0,260}/.exec(code);
  assert.ok(guard, '找不到 probeNeedsRefresh');
  assert.match(guard[0], /probeFailed/, '失败态必须排除在自动刷新之外（避免退回 D1 的自激）');
});

test('I3 补：悬空引用必须在数据刷新时收敛（不是渲染期）', () => {
  const code = stripComments(readHead());
  const body = /async function reloadAll\([\s\S]*?\n\}/.exec(code)?.[0] ?? '';
  assert.ok(body, '找不到 reloadAll');
  assert.match(body, /S\.profileExpanded\s*=\s*null/, 'reloadAll 必须收敛悬空的 profileExpanded');
  assert.match(body, /S\.expanded\s*=\s*undefined/, 'reloadAll 必须收敛悬空的 expanded');
});

test('I7：厂商参考件必须能"只读查看"（不能编辑 ≠ 不能看）', () => {
  /**
   * `style.*` 是厂商原厂参考件，按设计不提供编辑（写它要提权 + 逐次确认）——
   * 但原来这七张卡**只能看一行摘要**（字符数 + sha），`acc-head` 还是 `cursor: default`，
   * 用户想确认"当前生效的风格到底写了什么"时无处可看。
   *
   * 现在：卡头可点，展开后是**只读**全文（能复制、不能改）。
   */
  const code = stripComments(readHead());
  // 按"从 if (referenceMode) 到它的收尾"整段取（正则定界不稳：分支里有嵌套大括号）
  const startIdx = code.indexOf('if (referenceMode) {');
  assert.ok(startIdx > 0, '找不到 referenceMode 分支');
  const refBlock = code.slice(startIdx, startIdx + 6000);
  assert.match(refBlock, /onclick: refToggle/, '参考件卡的卡头必须可点击（否则永远看不到内容）');
  assert.match(refBlock, /read-only-text/, '必须有只读内容区');
  // 只读：只看**只读区那一段**（refBody 的内容），不是整个分支 ——
  // 分支里还有厂商确认勾选框（el('input')），那是**另一个**控件，不属于只读区。
  const bodyStart = refBlock.indexOf('const refBody');
  const bodyEnd = refBlock.indexOf('const refToggle');
  assert.ok(bodyStart > 0 && bodyEnd > bodyStart, '找不到只读区构造段');
  const readOnly = refBlock.slice(bodyStart, bodyEnd);
  assert.doesNotMatch(readOnly, /el\('textarea'/, '只读区不许用 textarea（会被当成可编辑）');
  assert.doesNotMatch(readOnly, /el\('input'/, '只读区不许用 input');
  assert.match(readOnly, /el\('pre'/, '只读区用 <pre> 保留原文换行');
});

test('P0/T12：API 全 401 时，一轮渲染不得自激重排（曾经的 401 次）', async () => {
  const { } = await loadApp({ mode: 'down' });
  const root = await boot();
  const hitsAfterBoot = H.apiCalls.length;
  assert.ok(hitsAfterBoot > 0, '启动至少应发一次请求');

  // 再等两轮事件循环：若守卫仍把失败当"待加载"，这里会疯狂增长
  await new Promise((r) => setTimeout(r, 120));
  const hitsAfterWait = H.apiCalls.length;
  assert.ok(
    hitsAfterWait - hitsAfterBoot < 20,
    `失败后仍在重排：等待期间多发了 ${hitsAfterWait - hitsAfterBoot} 个请求（D1 复发）`,
  );
  assert.ok(root.querySelector('.flash-err') || root.querySelector('.topnav'), '界面应仍然渲染出壳');
});

test('P0/T12：probe 单点失败会被"记住"，不会无限重拉', async () => {
  const handles = [
    { id: 'personalization.soul', title: 'SOUL', writeClass: 'user-data', anchorOk: true },
  ];
  await loadApp({ mode: 'probe-down', handles });
  await boot();
  const probeCalls = () => H.apiCalls.filter((c) => c.path.includes('/probe')).length;
  const first = probeCalls();
  await new Promise((r) => setTimeout(r, 150));
  const second = probeCalls();
  assert.equal(second, first, `probe 被重复调用 ${second - first} 次——失败没有被记住（D1 复发）`);
});

test('P0/T13：overview 取不到时，健康状态不得显示为绿色成功', async () => {
  await loadApp({ mode: 'down' });
  const root = await boot();
  const pills = root.querySelectorAll('.pill');
  const greens = pills.filter((p) => p.classList.contains('pill-ok'));
  assert.equal(greens.length, 0, `失败时不许有绿色成功徽章（实际 ${greens.length} 个）——铁律 6：无法判定不得显示成成功`);
  const html = root.textContent;
  assert.ok(!/✓ \?/.test(html), '不得再出现 "✓ ?" 这种"成功但值是未知"的写法');
});

test('P0/T13：加载失败必须明说，不得伪装成空态', async () => {
  await loadApp({ mode: 'down' });
  const root = await boot();
  assert.ok(root.querySelector('.flash-err'), '失败必须有红色横幅');
  const text = root.textContent;
  assert.ok(/没读到|失败/.test(text), '文案必须明说取不到数据，而不是让用户以为"本来就是空的"');
});

test('P2/T16：最近动态里 verify 事件必须按 verdict 分色，不得一律涂绿', async () => {
  /**
   * ⚠️ 这条断言曾经是**空转**的（由独立复核抓出，见 .zhll/gates/wp6-verify.log [C20]）：
   * 旧版只 grep 源码里 `ineffective` 和 `mk-bad` 的字面共存，**根本不走渲染路径**——
   * 把 `const m = mkOf(r)` 换成硬编码 `mk-ok`（也就是 D7 原样复发），测试照样全绿。
   *
   * 现在改成真渲染：喂三条不同 verdict 的审计记录，读渲染出来的 class。
   */
  const audit = [
    { at: '2026-11-01T01:00:00Z', event: 'verify', handle: 'personalization.soul', verdict: 'effective' },
    { at: '2026-11-01T01:01:00Z', event: 'verify', handle: 'personalization.user', verdict: 'ineffective' },
    { at: '2026-11-01T01:02:00Z', event: 'verify', handle: 'personalization.identity', verdict: 'undetermined' },
  ];
  await loadApp({
    mode: 'ok',
    overview: {
      version: '5.9.3', configRoot: 'c', storeRoot: 's',
      health: { ok: true, anchors: 11, anchorFailures: 0, handles: 18 },
      gate: { appRunning: false }, drift: { available: false },
      customized: [], unknown: [], todos: [], recent: audit, backups: [], counts: {},
    },
    handles: [],
  });
  const root = await boot();

  // 找「最近动态」表格里的三个标记
  // 若 boot 后不在总览页（例如 sessionStorage 里存着上次的页签），先点回总览
  if (!root.querySelector('.ledger')) {
    const nav = root.querySelectorAll('.nav-tab').find((b) => b.textContent.trim() === '总览');
    if (nav) { nav.click(); await new Promise((r) => setTimeout(r, 30)); }
  }
  /**
   * 选择器说明：本 stub 的 querySelectorAll 只支持**简单选择器序列**
   * （`.a` / `#id` / `tag` / `[attr]`），对 `A B` 这种后代组合只做"逐级过滤"，
   * 并非真正的后代匹配。所以这里直接按 class 取，再自己判断归属，
   * 避免"选择器不匹配"被误读成"渲染没发生"。
   */
  const allMarks = root.querySelectorAll('.mk');
  const marks = allMarks.filter((m) => {
    // 只取最近动态表格里的（祖先链上要有 .ledger-evt，且再上面是 .ledger）
    let p = m.parentNode;
    let sawEvt = false;
    while (p) {
      if (p.classList.contains('ledger-evt')) sawEvt = true;
      if (p.classList.contains('ledger') && sawEvt) return true;
      p = p.parentNode;
    }
    return false;
  });
  if (marks.length !== 3) {
    const dump = (n, d = 0) => {
      const tag = n.tagName === '#TEXT' ? `#text(${JSON.stringify(n._text.slice(0, 24))})` : n.tagName;
      console.error(`${'  '.repeat(d)}${tag} .${n.className || '-'}`);
      for (const c of n.children) dump(c, d + 1);
    };
    dump(root);
  }
  assert.equal(marks.length, 3, `应渲染出 3 条动态（实际 ${marks.length}）`);

  const cls = marks.map((m) => m.className);
  assert.ok(cls[0].includes('mk-ok'), `effective 应为绿（实际 ${cls[0]}）`);
  assert.ok(cls[1].includes('mk-bad'), `ineffective 应为红（实际 ${cls[1]}）—— 把未生效画成成功即违反铁律 6`);
  assert.ok(cls[2].includes('mk-warn'), `undetermined 应为黄（实际 ${cls[2]}）`);

  // 标签也必须区分，不能一律写「验证」
  const text = root.querySelector('.ledger')?.textContent ?? '';
  assert.ok(/生效/.test(text) && /未生效/.test(text) && /无法判定/.test(text),
    '三类验证必须在界面上用文字区分，不能只靠颜色');
});
