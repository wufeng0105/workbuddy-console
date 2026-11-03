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
    /**
     * `then` —— **故意声明成非函数**。
     *
     * 审计的 Proxy 插桩报过"已执行路径上唯一被访问、stub 没定义的成员是 `then`"。
     * 追下去发现来源是本文件自己的 harness：`async function boot() { … return root }`
     * 返回的是一个 StubNode，于是 Promise 解析它会读 `root.then`。
     *
     * 所以这里**不能**给一个真的 thenable 实现：`then` 一旦是函数，`await boot()`
     * 就会走 thenable 解析路径；而"用节点自己兑现自己"按规范是无限自激
     * （then(resolve) → resolve(node) → 再读 then …），测试会直接挂死。
     * 声明成 undefined 是**显式**表达"StubNode 不是 thenable"，
     * 让"这里读过 then"这件事有一个可读的落点，而不是靠"反正没定义"偶然正确。
     */
    this.then = undefined;
  }

  /**
   * 自身或祖先链上是否有 disabled —— 真实浏览器对 disabled 控件的**可信**点击不派发事件。
   * 读的是 `disabled` 属性（IDL 反射 content attribute），与浏览器一致。
   */
  isDisabled() {
    for (let n = this; n; n = n.parentNode) {
      if (n.disabled === true) return true;
    }
    return false;
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
  removeAttribute(k) {
    delete this.attributes[k];
    if (k === 'disabled') this.disabled = false;
  }

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
  /**
   * 派发事件（真实浏览器行为；测试模拟"用户输入"必须走它，否则 input 监听不会被触发）
   *
   * ⚠️ 与 `click()` 刻意**不同**：真实 DOM 里 `dispatchEvent()` 是**不可信**输入，
   * disabled 元素照样会收到监听器。真正的浏览器只拦"用户激活"那一路。
   * 所以这里不加 disabled 判定 —— 加了就等于把 app.js 的守卫搬到 stub 里替它把关。
   */
  dispatchEvent(ev) {
    const type = typeof ev === 'string' ? ev : ev?.type;
    const event = typeof ev === 'string' ? { type, target: this } : { target: this, ...ev };
    for (const fn of this.listeners[type] ?? []) fn(event);
    return true;
  }

  /**
   * 触发一次**可信** click（等价于用户真的用鼠标点了它）。
   *
   * 为什么必须遵守 `disabled`：`web/app.js` 防双击双写的**唯一**机制就是禁用按钮
   * （`runBusy` → `setBusyDom(true)`，见 app.js:1561 / :1577）。stub 若不拦，
   * 任何"点两次"的断言都恒绿 —— 也就是在假 DOM 上通过，这正是 I2 名不副实的根因。
   *
   * 关于"真浏览器里 dispatchEvent 也绕过 disabled"：那是**不可信**输入被刻意允许的
   * （规范如此）。CDP 的 `Input.dispatchMouseEvent` 才是可信输入，它会遵守 disabled；
   * 本方法模拟的是后者。要模拟前者请用 `dispatchEvent({ type: 'click' })`。
   */
  click() {
    if (this.isDisabled()) return false;   // 可信点击：disabled 控件收不到
    const ev = { target: this, preventDefault() {}, stopPropagation() {} };
    for (const fn of this.listeners.click ?? []) fn(ev);
    const oc = this.attributes.onclick;
    if (typeof oc === 'function') oc(ev);
    return true;
  }

  /**
   * 真实 API：`app.js:555` 打开站内对话框时调 `input.focus?.()`。
   * 记录一次调用（`_focused`）而不是空实现 —— 将来要断言"打开对话框就聚焦"时有据可查。
   */
  focus() { this._focused = true; }

  /**
   * 真实 API：`app.js:2113` 守护页「快照归档」按钮调
   * `document.getElementById('guard-timeline')?.scrollIntoView(...)`，**没有可选链**，
   * stub 缺它就会真 `TypeError`（审计 gates/WP7/PROBE-scrollIntoView.log 复现过）。
   */
  scrollIntoView() { this._scrolledIntoView = true; }

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

/** api() 传给 fetch 的 body 是 JSON **字符串**（见 web/core.js:31）——这里统一解析回来 */
const bodyOf = (opts) => {
  try { return JSON.parse(opts?.body ?? '{}'); } catch { return {}; }
};

function makeHarness({ mode = 'ok', overview = {}, handles = [], profiles = [], probeOverride = null, drift = null, audit = null, restorePreview = null, applyResult = null, restoreResult = null } = {}) {
  const doc = new StubDocument();
  const apiCalls = [];

  const respond = (p, opts) => {
    if (mode === 'down') {
      const e = new Error('缺少或错误的会话令牌');
      e.code = 'UNAUTHORIZED';
      throw e;
    }
    /**
     * 写事务失败注入（B5）：只让 `/apply` 挂，其余域照常 ——
     * 这样页面会走 doApply 的 onError 分支，而不是被 reloadAll 的域错误横幅遮住。
     * 注意 message **不含**错误码：于是"提示里必须有 EPERM"这条断言真的在验 `e.code` 被读了。
     */
    if (mode === 'apply-down' && /\/apply$/.test(p)) {
      const e = new Error('数据目录写不进去');
      e.code = 'EPERM';
      throw e;
    }
    /** apply 的返回值：让用例能注入 previewWarnings / backupId / noop（R4 需要） */
    if (/\/apply$/.test(p)) {
      if (applyResult) return applyResult;
      const id = decodeURIComponent(/\/api\/handle\/([^/]+)\/apply/.exec(p)?.[1] ?? "h");
      return { handle: id, backupId: "20260101T000000Z-test", contentChanged: true, previewWarnings: [] };
    }
    if (p === '/api/overview') return overview;
    if (p === '/api/doctor') return { version: '5.9.3', anchors: [], handles };
    if (p === '/api/profiles') return profiles;
    if (p === '/api/approval') return { levels: [], prompts: [], rules: null };
    if (p === '/api/drift') return drift ?? { ok: false, reason: 'no bundle', results: [], needReplay: [] };
    if (p.startsWith('/api/audit')) return audit ?? [];
    /**
     * 按备份还原（B7）。`doRestore` 是两步走：先 dryRun 预演、再 confirm 执行。
     * 这里的两发返回值必须不同 —— 否则"确认前就执行了"会被同样的一份响应掩盖。
     */
    if (p === '/api/restore') {
      const body = bodyOf(opts);
      if (body.dryRun === true) {
        return restorePreview ?? { changed: [], willDelete: [], backupId: body.backupId };
      }
      /** 实际执行的结果：让用例能注入 `results[]`（含失败项）与 `savedDir`（R25 需要） */
      if (restoreResult) return { backupId: body.backupId, ...restoreResult };
      return { changed: ['x'], deleted: [], backupId: body.backupId };
    }
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

/* ══════════════ 行为断言的公共工具（WP11 加） ══════════════ */

/** 等异步落地（render / 请求 / queueMicrotask）。行为断言里统一用它，不散落魔法数 */
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

/** 进「个性化」并展开标题含 `titlePart` 的卡；render 会重建整棵树，所以取用前一律重新查 */
async function expandCustomizeCard(root, titlePart) {
  const nav = root.querySelectorAll('.nav-tab').find((b) => b.textContent.trim() === '个性化');
  assert.ok(nav, '找不到「个性化」导航');
  nav.click();
  await tick(100);
  const find = () => root.querySelectorAll('.acc')
    .find((c) => (c.querySelector('.acc-title')?.textContent ?? '').includes(titlePart));
  let card = find();
  assert.ok(card, `找不到标题含「${titlePart}」的卡`);
  if (card.dataset.open !== 'true') {
    card.querySelector('.acc-head').click();
    await tick(180);
    card = find();
  }
  assert.ok(card, `展开后找不到标题含「${titlePart}」的卡`);
  return card;
}

/**
 * 只取「最近动态」表格里的三态标记。
 * 本 stub 的 `A B` 后代选择器是"逐级交集过滤"而非真后代匹配（见文件顶部 stub 说明），
 * 所以按 class 取全量、再顺着祖先链自己判断归属（T16 也是这么做的）。
 */
function ledgerMarks(root) {
  return root.querySelectorAll('.mk').filter((m) => {
    let p = m.parentNode;
    let sawEvt = false;
    while (p) {
      if (p.classList.contains('ledger-evt')) sawEvt = true;
      if (p.classList.contains('ledger') && sawEvt) return true;
      p = p.parentNode;
    }
    return false;
  });
}

const SOUL_HANDLE = {
  id: 'personalization.soul', title: '人设设定（SOUL.md）', writeClass: 'user-data', anchorOk: true,
};

/** 打开 SOUL 卡、在编辑器里真打一段字（派发 input）、返回最新卡与按钮 */
async function openSoulEditor(root, typedSuffix = '') {
  const card = await expandCustomizeCard(root, 'SOUL');
  const ta = card.querySelectorAll('#editor')[0];
  assert.ok(ta, '找不到编辑器（#editor）');
  const typed = typedSuffix ? `${ta.value}${typedSuffix}` : null;
  if (typed !== null) {
    ta.value = typed;
    ta.dispatchEvent({ type: 'input' });   // 必须派发：否则草稿不会被记录
  }
  const applyBtn = card.querySelectorAll('.btn-primary').find((b) => b.textContent.trim() === '应用');
  assert.ok(applyBtn, '找不到「应用」按钮');
  return { card, ta, typed, applyBtn };
}
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

test('F6：枚举卡的下拉框与按钮必须在同一层（否则永远对不齐）', async () => {
  /**
   * 实测过的缺陷：`actions()` 自己返回一个带 `margin-top:12px` 的 `.row`，
   * 枚举分支又把它 append 进**另一个** `.row` → 嵌套两层 flex，
   * 内层的 margin-top 把按钮推下去（真机实测：高度差 2.6px、中心偏移 6px、sameParent=false）。
   * `align-items:center` 只作用于同层子元素 —— 跨层就失效，所以这是结构错，不是调参问题。
   */
  const handles = [
    { id: 'personalization.tone-style', title: '回复风格（toneStyle）', writeClass: 'user-data', anchorOk: true },
  ];
  await loadApp({
    mode: 'ok',
    handles,
    probeOverride: {
      'personalization.tone-style': {
        handle: { id: 'personalization.tone-style', title: '回复风格（toneStyle）', writeClass: 'user-data' },
        state: { exists: true, value: 'friendly', allowedValues: ['efficient', 'friendly', 'socratic'], text: 'friendly', bytes: 8 },
      },
    },
  });
  const root = await boot();
  root.querySelectorAll('.nav-tab').find((b) => b.textContent.trim() === '个性化').click();
  await new Promise((r) => setTimeout(r, 120));
  const card = root.querySelectorAll('.acc').find((c) => (c.querySelector('.acc-title')?.textContent ?? '').includes('回复风格'));
  assert.ok(card, '找不到 toneStyle 卡');
  if (card.dataset.open !== 'true') card.querySelector('.acc-head').click();
  await new Promise((r) => setTimeout(r, 150));

  const sel = card.querySelectorAll('#editor')[0];
  const applyBtn = card.querySelectorAll('button').find((b) => b.textContent.trim() === '应用');
  assert.ok(sel, '找不到下拉框');
  assert.ok(applyBtn, '找不到应用按钮');
  assert.equal(applyBtn.parentNode, sel.parentNode,
    '「应用」与下拉框必须是同一个父元素的子节点（嵌套 .row 会让它们错位）');
  assert.equal(sel.parentNode.className, 'row', '共同父元素应当是 .row');
});

test('F4：toneStyle 卡必须提供「编辑这一档正文」的入口', async () => {
  /**
   * D4：toneStyle 是指针，正文在 style-<id>.md。用户的任务是"把这一档改成我想要的样子"，
   * 不该拆成跨两张卡。这个入口就是那件事的落点。
   */
  const handles = [
    { id: 'personalization.tone-style', title: '回复风格（toneStyle）', writeClass: 'user-data', anchorOk: true },
    { id: 'style.friendly', title: '风格内容 · 友好（style-friendly.md）', writeClass: 'vendor-file', anchorOk: true },
  ];
  await loadApp({
    mode: 'ok',
    handles,
    probeOverride: {
      'personalization.tone-style': {
        handle: { id: 'personalization.tone-style', title: '回复风格（toneStyle）', writeClass: 'user-data' },
        state: { exists: true, value: 'friendly', allowedValues: ['efficient', 'friendly'], text: 'friendly', bytes: 8 },
      },
      'style.friendly': {
        handle: { id: 'style.friendly', title: '风格内容 · 友好（style-friendly.md）', writeClass: 'vendor-file' },
        state: { exists: true, text: '# Style: Friendly\n\ncontent', bytes: 24, isActive: true, writeAccess: true },
      },
    },
  });
  const root = await boot();
  root.querySelectorAll('.nav-tab').find((b) => b.textContent.trim() === '个性化').click();
  await new Promise((r) => setTimeout(r, 120));
  const card = root.querySelectorAll('.acc').find((c) => (c.querySelector('.acc-title')?.textContent ?? '').includes('回复风格'));
  if (card.dataset.open !== 'true') card.querySelector('.acc-head').click();
  await new Promise((r) => setTimeout(r, 200));

  const editBtn = card.querySelectorAll('button').find((b) => b.textContent.includes('编辑这一档的正文'));
  assert.ok(editBtn, 'toneStyle 卡必须有「编辑这一档的正文」按钮');

  editBtn.click();
  await new Promise((r) => setTimeout(r, 200));
  const card2 = root.querySelectorAll('.acc').find((c) => (c.querySelector('.acc-title')?.textContent ?? '').includes('回复风格'));
  const ta = card2.querySelectorAll('#style-editor')[0];
  assert.ok(ta, '点开后必须出现正文编辑器');
  assert.match(String(ta.value ?? ''), /Style: Friendly/, '编辑器要预填该档现有正文');
  const saveBtn = card2.querySelectorAll('button').find((b) => b.textContent.includes('保存正文并切到这一档'));
  assert.ok(saveBtn, '必须有「保存正文并切到这一档」按钮（用户选定：保存即顺手切）');
  const code = stripComments(readHead());
  assert.match(code, /confirm-vendor/, '写厂商文件必须带确认勾选框（铁律 5）');
});
test('F9：枚举卡不给「还原到最初基线」，文本卡必须保留', async () => {
  /**
   * 枚举的全部合法值就在下拉框里 —— 想回到 `efficient`，选它 + 应用即可。
   * 「还原到最初基线」做的正是"替你选中基线里记的那个值"，对枚举属于功能重叠；
   * 而且它与「应用」并排会被读成"撤销"（用户实测就是这么问的："为什么还原的是 efficient"）。
   *
   * 文本/规则卡相反：正文字数任意、没法凭记忆重建，「还原到最初」是唯一的路，必须留。
   */
  const code = stripComments(readHead());
  const fn = /function actionButtons\(h, getNext\) \{[\s\S]*?\n\}/.exec(code)?.[0] ?? '';
  assert.ok(fn, '找不到 actionButtons');
  assert.match(fn, /isEnum/, '必须按"是不是枚举"分流（否则枚举卡又会冒出还原按钮）');
  assert.match(fn, /if \(!isEnum\) \{/, '还原按钮必须被 !isEnum 守卫住');
});
test('R4：apply 必须在界面上显示后端返回的 previewWarnings', async () => {
  /**
   * `engine.apply` 从 D2 修复起就返回 `previewWarnings`，但全站只有风格编辑器读它——
   * 其余 11 个把手的警告全被丢掉。最要命的是 style 那条
   * 「该档位当前未生效 —— 改这个文件不会影响任何请求」：
   * 没有它，用户看到「✅ 已写入」，以为生效了，其实那份内容根本没参与请求。
   */
  const handles = [
    { id: 'personalization.soul', title: '人设设定（SOUL.md）', writeClass: 'user-data', anchorOk: true },
  ];
  await loadApp({
    mode: 'ok',
    handles,
    applyResult: {
      handle: 'personalization.soul', backupId: '20260101T000000Z-test', contentChanged: true,
      previewWarnings: ['该档位**当前未生效** —— 改这个文件不会影响任何请求。'],
    },
  });
  const root = await boot();
  root.querySelectorAll('.nav-tab').find((b) => b.textContent.trim() === '个性化').click();
  await new Promise((r) => setTimeout(r, 120));
  const card = root.querySelectorAll('.acc').find((c) => (c.querySelector('.acc-title')?.textContent ?? '').includes('人设'));
  if (card && card.dataset.open !== 'true') card.querySelector('.acc-head').click();
  await new Promise((r) => setTimeout(r, 150));

  const ta = root.querySelectorAll('#editor')[0];
  assert.ok(ta, '找不到编辑器');
  ta.value = '# 新内容\n- 加了东西';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const btn = root.querySelectorAll('.btn-primary').find((b) => b.textContent.trim() === '应用');
  assert.ok(btn, '找不到「应用」');
  btn.click();
  await new Promise((r) => setTimeout(r, 200));

  const flashText = root.querySelectorAll('.flash')[0]?.textContent ?? '';
  assert.match(flashText, /当前未生效/,
    `警告必须出现在界面上。实际 flash: ${JSON.stringify(flashText.slice(0, 160))}`);
  assert.match(flashText, /已写入/, '结论本身仍要保留');
});

test('R25：还原部分失败时不许打绿说"已还原"（行为）', async () => {
  /**
   * 后端 `restoreBackup` 返回 `ok`/`partial`/`savedDir`/`results[]`，
   * 而前端原来只读 `changed` 和 `deleted` —— 一条失败时照样打绿。
   * 用户以为回到原状了，其实没有。
   *
   * ⚠️ **这条断言的第一版是源码正则**，2026-11-03 独立检查用变异证伪：
   * 把过滤条件从 `x.ok === false` 反转成 `x.ok === true`（失败项当成成功项统计，
   * 界面从此**永远打绿**，正好是本条要防的那个 bug），四条 `assert.match` **全部照样匹配**。
   * 它钉的是字形，不是行为。
   *
   * 现在走用户真走的那条路：守护页 → 备份时间线「还原」→ 后端返回一条失败 →
   * 断言 flash 必须是 **err（红）**、必须列出失败路径、必须给出还原前副本位置。
   * 三证：① 反转 `ok === false` → 红；② 正常 → 绿；③ 删掉 `r.savedDir` 那行 → 红。
   */
  const backups = [{ id: 'bk-20261103-9', createdAt: '2026-11-03T00:00:00Z', entries: 2, reason: 'apply personalization.soul' }];
  await loadApp({
    mode: 'ok',
    handles: [SOUL_HANDLE],
    overview: {
      version: '5.9.3', configRoot: 'c', storeRoot: 's',
      health: { ok: true, anchors: 11, anchorFailures: 0, handles: 1 },
      gate: { appRunning: false }, drift: { available: false },
      customized: [], unknown: [], todos: [], recent: [], backups, counts: {},
    },
    // 预演：有变化、无删除 ⇒ 不弹确认框，直接进执行
    restorePreview: { changed: ['C:/x/SOUL.md'], willDelete: [] },
    // 执行：两条结果，一条失败 —— 后端此时 status 会是 'partial'
    restoreResult: {
      changed: ['C:/x/SOUL.md'],
      deleted: [],
      status: 'partial',
      savedDir: 'C:\\store\\state\\restore-pre\\bk-20261103-9',
      results: [
        { key: 'personal.soul', absPath: 'C:\\x\\SOUL.md', action: 'restore', ok: true },
        { key: 'personal.user', absPath: 'C:\\x\\USER.md', action: 'error', ok: false, error: 'EPERM' },
      ],
    },
  });
  const root = await boot();
  const nav = root.querySelectorAll('.nav-tab').find((x) => x.textContent.trim() === '守护');
  assert.ok(nav, '找不到导航「守护」');
  nav.click();
  await tick(150);

  const row = root.querySelectorAll('.tl-row')[0];
  assert.ok(row, '找不到备份时间线的行');
  const btn = row.querySelectorAll('button').find((x) => x.textContent.trim() === '还原');
  assert.ok(btn, '备份时间线里必须有「还原」按钮');
  btn.click();
  await tick(250);

  const flash = root.querySelectorAll('.flash')[0];
  assert.ok(flash, '还原之后必须有结果条（静默什么都不说同样是错的）');
  const text = flash.textContent;
  assert.match(text, /失败/, `部分失败必须说出来。实际 flash: ${JSON.stringify(text.slice(0, 200))}`);
  assert.match(text, /USER\.md/, `必须点名哪一条失败了（用户才知道去查哪个文件）。实际: ${JSON.stringify(text.slice(0, 200))}`);
  assert.match(text, /restore-pre/, `必须给出还原前副本的位置（失败时唯一能救回来的东西）。实际: ${JSON.stringify(text.slice(0, 200))}`);
  /**
   * 颜色/语义：flash 的 class 决定用户看到红还是绿。
   * 只断言文案不够 —— 文案里出现"失败"却配绿色底，等于还是"打绿"。
   */
  assert.ok(flash.classList.contains('flash-err'),
    `有失败项时必须是 flash-err（红），实际 class=${JSON.stringify(flash.className)}`);
  assert.ok(!flash.classList.contains('flash-ok'), '同一份结果不许同时打绿');
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

/* ══════════════ WP9 · F1 的前端腿（探测失败 ≠ 空内容）══════════════ */

test('F1（前端）：探测失败时展开的卡不渲染编辑器，也没有可点的「应用」', async () => {
  /**
   * 致命缺陷的另一条腿（F1）：`accCard` 里的 `const st = pr?.state ?? {}` 把
   * "没读到"变成了"内容本来就是空的"。后果：
   *   `editorArea` 的 `if (!st) return '读取中…'` 守卫形同虚设 →
   *   渲染出**空的、可编辑的** textarea → `getNext()` 返回 `''` → 点「应用」把整个文件写成空。
   * 实测证据：`gates/WP3/exp-G-probe-failed-editor.log`（`#editor` 存在、`value=""`、
   * `disabled=false`、「应用」可点）。
   *
   * 本断言直接盯住"失败态不许出现写入入口"：既不许有 #editor，也不许有可点的 .btn-primary。
   */
  const handles = [
    { id: 'personalization.soul', title: '人设设定（SOUL.md）', writeClass: 'user-data', anchorOk: true },
  ];
  await loadApp({ mode: 'probe-down', handles });
  const root = await boot();
  const nav = root.querySelectorAll('.nav-tab').find((b) => b.textContent.trim() === '个性化');
  nav.click();
  await new Promise((r) => setTimeout(r, 120));

  const card = root.querySelectorAll('.acc')
    .find((c) => (c.querySelector('.acc-title')?.textContent ?? '').includes('SOUL'));
  assert.ok(card, '找不到 SOUL 卡');
  if (card.dataset.open !== 'true') card.querySelector('.acc-head').click();
  await new Promise((r) => setTimeout(r, 200));

  // 重新取一次：render 会重建整棵子树
  const card2 = root.querySelectorAll('.acc')
    .find((c) => (c.querySelector('.acc-title')?.textContent ?? '').includes('SOUL'));
  assert.ok(card2, '展开后找不到 SOUL 卡');

  assert.equal(card2.querySelectorAll('#editor').length, 0,
    '探测失败时**不许**渲染 #editor（空的 textarea 会让用户以为文件本来就是空的，一点「应用」就清空）');

  const clickablePrimary = card2.querySelectorAll('.btn-primary').filter((b) => b.disabled !== true);
  assert.equal(clickablePrimary.length, 0,
    `探测失败时不许有可点的「应用」（实际 ${clickablePrimary.length} 个）——拿不到现状就不允许写`);

  // 文案必须说清"读不到"，并给一个**真的能点**的重试（否则"点重试"是死指针）
  assert.match(card2.textContent, /读取失败/, '必须明说读取失败，而不是伪装成空内容');
  const retry = card2.querySelectorAll('button').find((b) => b.textContent.trim() === '重试');
  assert.ok(retry, '失败态必须提供可点的「重试」按钮');
  assert.notEqual(retry.disabled, true, '「重试」按钮必须可点');
});

test('F1（前端回归）：style 参考件卡探测失败时仍能只读地显示"读取失败"（不许因 st=null 崩掉）', async () => {
  /**
   * 修 F1 时改了 `accCard` 里 `st` 的取值（`?? {}` → `?? null`）。参考件卡（style.*）
   * 在构造摘要时会无保护地读 `st.text` / `st.sha256` —— 若没改可选链，探测失败时这里会抛 TypeError，
   * 把"读取失败"的卡片直接炸没。本断言守住"既有正确行为不被改坏"：
   *   · 不崩；· 明说探测失败；· 仍然是只读（没有 textarea）；· 只有「重试」，没有可编辑入口。
   */
  const handles = [
    { id: 'style.friendly', title: '风格内容 · 友好（style-friendly.md）', writeClass: 'vendor-file', anchorOk: true },
  ];
  await loadApp({ mode: 'probe-down', handles });
  const root = await boot();
  root.querySelectorAll('.nav-tab').find((b) => b.textContent.trim() === '个性化').click();
  await new Promise((r) => setTimeout(r, 120));

  const card = root.querySelectorAll('.acc')
    .find((c) => (c.querySelector('.acc-title')?.textContent ?? '').includes('风格内容'));
  assert.ok(card, '找不到 style 参考件卡');
  if (card.dataset.open !== 'true') card.querySelector('.acc-head').click();
  await new Promise((r) => setTimeout(r, 200));

  const card2 = root.querySelectorAll('.acc')
    .find((c) => (c.querySelector('.acc-title')?.textContent ?? '').includes('风格内容'));
  assert.ok(card2, '展开后找不到参考件卡（st=null 时构造摘要抛错会把它炸掉）');
  assert.match(card2.textContent, /探测失败|读取失败/, '必须明说读不到内容');
  assert.equal(card2.querySelectorAll('textarea').length, 0, '参考件卡永远不许出现可编辑 textarea（I7 只读设计不变）');
  assert.equal(card2.querySelectorAll('.read-only-text').length, 0, '读不到内容时不许伪造一个空的只读正文');
  const retry = card2.querySelectorAll('button').find((b) => b.textContent.trim() === '重试');
  assert.ok(retry, '失败态必须给「重试」按钮');
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
     * ⚠️ 这条断言曾经是**空转**的（由独立复核抓出）：
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

/* ══════════════════════════════════════════════════════════════════════════
 * WP11 · B 组：7 条空转断言 → 真行为断言
 *
 * 背景（审计 07-assertions-frontend.md F3 / 红灯全表）：
 *   M1 / M5 / M6 / M16 / H1 这五条，把对应修复**改回缺陷态**之后 `npm test` 仍然全绿；
 *   `doRestore` 的删除同意闸门**完全没有断言**（reg02）；I4 被 T16 兜住、
 *   但自己那条静态断言单独看是空转。
 *
 * 共同点：它们都只看**源码文本**（"函数体里有没有出现过 runBusy(" "有没有 TTL 常量名"），
 * 而文本存在 ≠ 机制生效。下面每条都改成**走一遍用户真的会走的那条路**，再读结果。
 *
 * 每条都做了三证（改回缺陷态 / 正常态 / 删掉被测字段），原始输出在
     * 每条都做了三证（改回缺陷态 / 正常态 / 删掉被测字段）。
 * ══════════════════════════════════════════════════════════════════════════ */

test('I2（行为）：双击「应用」只写一次 —— 第一下之后按钮必须立刻 disabled', async () => {
  /**
   * 为什么必须改写：M1 证明"删掉 setBusyDom(true)"（app.js:1561，防双击双写的**唯一**机制）
   * 之后整轮 51 条断言全绿；M23 证明"干净地绕开 runBusy"只让两条**文本**断言变红，
   * 没有任何一条断言真的点过两次。I2 因此名不副实。
   *
   * 本断言真的点两次（stub 的 click() 已改成遵守 disabled = 可信输入语义），
   * 数真正发出去的 `/apply` 请求条数。
   */
  await loadApp({ mode: 'ok', handles: [SOUL_HANDLE] });
  const root = await boot();
  const { applyBtn } = await openSoulEditor(root, '\n- 这一行只许写进去一次');

  assert.equal(applyBtn.disabled, false, '尚未开始写事务时「应用」不该是禁用的');

  H.apiCalls.length = 0;
  // 第一下：真用户点击
  assert.equal(applyBtn.click(), true, '按钮可点时 click() 应该真的派发出去');
  /**
   * 同步时点：fetch 已经发出（我们的 stub fetch 在 await 前就记账）、promise 还没落地。
   * 此刻 app.js 的防重机制必须已经把按钮禁掉，否则第二下就是第二次写盘。
   */
  assert.equal(applyBtn.disabled, true,
    '点第一下之后「应用」必须立刻 disabled —— 这是 app.js 唯一的防双击双写手段');

  // 第二下：用户手快又点一下。可信点击对 disabled 控件不派发
  assert.equal(applyBtn.click(), false, 'disabled 的按钮不许再派发 click（可信输入语义）');
  await tick(220);

  const applyCalls = H.apiCalls.filter((c) => /\/apply$/.test(c.path));
  assert.equal(applyCalls.length, 1, `双击必须只写一次，实际发了 ${applyCalls.length} 次 /apply`);
});

test('I2/M16（行为）：写事务进行中不重建 DOM —— #editor 必须是同一个节点实例', async () => {
  /**
   * 为什么必须改写：M16 证明"在 runBusy 开头加回 render()"（真实用户报告过的那个缺陷）
   * 之后整轮全绿 —— 原来那条断言只 grep 源码里 runBusy 开头有没有 render。
   *
   * 这里不读源码，只问一个事实：写入进行中，编辑器那个 DOM 节点还是不是**同一个对象**。
   * render() 一旦跑过，整棵树被 clear + 重建，就是新对象（且用户没提交的输入被冲成探测值）。
   */
  await loadApp({ mode: 'ok', handles: [SOUL_HANDLE] });
  const root = await boot();
  const { ta, typed, applyBtn } = await openSoulEditor(root, '\n- 忙态期间不许丢我');
  assert.ok(typed, '测试自己要先打出字来');

  H.apiCalls.length = 0;
  applyBtn.click();

  assert.equal(H.app.__state.busy, true, '点击之后应处于忙态（fetch 尚未落地）');
  const during = root.querySelectorAll('#editor')[0];
  assert.ok(during, '忙态期间 #editor 必须还在 —— 否则下面那条"引用相等"会因为两个 null 相等而空转');
  assert.equal(during, ta,
    '忙态期间 #editor 必须还是同一个节点实例：重建 DOM 会把它换成新节点，'
    + '用户没提交的输入随之被冲成探测值（M16 那个"点了应用内容却没变"的缺陷）');

  await tick(220);
  assert.equal(H.app.__state.busy, false, '事务结束后忙态必须复位（否则界面永久锁死）');
});

test('I1（行为）：textarea 里没提交的输入必须跨 render 存活（切页往返）', async () => {
  /**
   * 为什么必须改写：M5（删 textarea 的 rememberField）单独犯 → 全绿；
   * M16（runBusy 开头 render）单独犯 → 全绿；只有 M17（两个半缺陷一起犯）才红。
   * 也就是说这条不变量只认"两个半缺陷的合取"，任一半复发都抓不住。
   *
   * 下面分别在三证里验证：**任一半**单独改回去都必须红（见 exec-WP11.md）。
   * 断言本身走的是用户路径：打字 → 切页往返（真 render）→ 回来看还在不在。
   */
  await loadApp({ mode: 'ok', handles: [SOUL_HANDLE] });
  const root = await boot();
  const { ta, typed } = await openSoulEditor(root, '\n\n- 我手动加的这一行必须活过 render');
  assert.ok(typed, '测试自己要先打出字来');

  // 切页往返 = 一次真 render（render() 会 clear + 重建整棵树）
  const go = (label) => {
    const b = root.querySelectorAll('.nav-tab').find((x) => x.textContent.trim() === label);
    assert.ok(b, `找不到导航「${label}」`);
    b.click();
  };
  go('总览');
  await tick(60);
  go('个性化');
  await tick(180);

  const card2 = root.querySelectorAll('.acc')
    .find((c) => (c.querySelector('.acc-title')?.textContent ?? '').includes('SOUL'));
  assert.ok(card2, '往返后找不到 SOUL 卡');
  if (card2.dataset.open !== 'true') { card2.querySelector('.acc-head').click(); await tick(180); }

  const after = root.querySelectorAll('#editor')[0];
  assert.ok(after, '往返后找不到 #editor');
  assert.notEqual(after, ta,
    '这里必须已经换成新节点 —— 若还是旧节点说明 render 没发生，下面的断言会空转');
  assert.equal(after.value, typed,
    '切页往返之后 textarea 必须还是用户打的内容；变回探测到的原文说明 render 把它冲掉了');
});

test('I6（行为）：探测缓存过期才重探 —— 未过期不重拉、过期必须真重探', async () => {
  /**
   * 为什么必须改写：M6 证明"probeStale 恒 return false"（TTL 判定失效，页面永远显示旧值）
   * 之后全绿 —— 原来那条断言只查源码里有没有 PROBE_TTL_MS 这个名字。
   *
   * 做法：注入假时钟。进「个性化」页会走 customizeWork() 里那段
   * `refreshStaleProbes()` 判据（app.js:699），所以"切页往返"就是触发点。
   */
  const realNow = Date.now;
  let clock = Date.parse('2026-11-02T00:00:00Z');
  Date.now = () => clock;
  try {
    await loadApp({ mode: 'ok', handles: [SOUL_HANDLE] });
    const root = await boot();
    const probeCalls = () => H.apiCalls.filter((c) => /\/probe$/.test(c.path)).length;
    const go = (label) => {
      const b = root.querySelectorAll('.nav-tab').find((x) => x.textContent.trim() === label);
      assert.ok(b, `找不到导航「${label}」`);
      b.click();
    };

    go('个性化');
    await tick(180);
    const base = probeCalls();
    assert.ok(base >= 1, '进页时至少应该有一次探测（否则基线不成立，后面的比较无意义）');

    // ① 未过期（+5 秒）：切页往返不许重拉
    clock += 5 * 1000;
    go('总览');
    await tick(60);
    go('个性化');
    await tick(200);
    assert.equal(probeCalls(), base,
      `缓存未过期时不许重新探测（实际多拉了 ${probeCalls() - base} 次）——否则每次切页都打 18 个请求`);

    // ② 过期（+10 分钟）：必须真的重新探测
    clock += 10 * 60 * 1000;
    go('总览');
    await tick(60);
    go('个性化');
    await tick(250);
    assert.equal(probeCalls(), base + 1,
      `缓存过期后必须重新探测一次（实际变化 ${probeCalls() - base}）——`
      + '不重探就等于让用户照着过期的"当前内容"去改，违反状态契约');
  } finally {
    Date.now = realNow;
  }
});

test('H1（行为）：写事务失败必须带错误码报出来，且忙态复位', async () => {
  /**
   * 为什么必须改写：H1 证明"删掉 `if (onError) onError(e); else throw e;`"
   * （写事务失败静默吞掉，违铁律 6「禁止假装成功」）之后全绿。
   * 原来那条只 grep 源码里有没有 runBusy 调用 —— 9 个写事务失败时什么都不说的样子它看不见。
   *
   * 这里让 `/apply` 真的失败（EPERM），断言页面上的失败提示**带错误码**、且 S.busy 复位。
   */
  await loadApp({ mode: 'apply-down', handles: [SOUL_HANDLE] });
  const root = await boot();
  const { applyBtn } = await openSoulEditor(root, '\n- 这次写入会失败');

  H.apiCalls.length = 0;
  applyBtn.click();
  await tick(250);

  const text = root.textContent;
  assert.match(text, /写入失败/, '写事务失败必须在页面上明说 —— 静默吞掉就是"假装成功"');
  assert.match(text, /EPERM/, `失败提示必须带错误码（用户才知道是权限/目录问题），实际文案：${text.slice(0, 400)}`);
  assert.equal(H.app.__state.busy, false, '失败之后忙态必须复位（否则所有按钮永久禁用）');
});

test('I4（行为）：三个 verdict 给三个不同 class，未知 verdict 落非成功一侧', async () => {
  /**
   * 为什么必须改写：M3 证明"映射查表退回硬编码"之后 I4 单独仍是绿的（被 T16 兜住），
   * 而 I4 本体只是 grep `effective … mk-ok` 的字面共存 —— 三态映射塌成一态它看不出来。
   *
   * 这条不问"源码里有没有 mk-ok"，只问渲染结果：
   *   ① 三个 verdict 必须映射到**三个互不相同**的 class（不许两态同色）；
   *   ② 未知 verdict（将来上游加了新结论）必须落在**非成功**一侧 ——
   *      "无法判定不得显示为成功"是铁律 6，未知值更只能是"无法判定"。
   */
  const audit = [
    { at: '2026-11-01T01:00:00Z', event: 'verify', handle: 'personalization.soul', verdict: 'effective' },
    { at: '2026-11-01T01:01:00Z', event: 'verify', handle: 'personalization.user', verdict: 'ineffective' },
    { at: '2026-11-01T01:02:00Z', event: 'verify', handle: 'personalization.identity', verdict: 'undetermined' },
    { at: '2026-11-01T01:03:00Z', event: 'verify', handle: 'personalization.custom-prompt', verdict: 'brand-new-verdict' },
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
  if (!root.querySelector('.ledger')) {
    const nav = root.querySelectorAll('.nav-tab').find((b) => b.textContent.trim() === '总览');
    assert.ok(nav, '找不到「总览」导航');
    nav.click();
    await tick(60);
  }

  const marks = ledgerMarks(root);
  assert.equal(marks.length, 4, `应渲染出 4 条动态（实际 ${marks.length}）`);
  const [ok, bad, warn, unknown] = marks.map((m) => m.className);

  assert.notEqual(ok, bad, `生效与未生效必须是不同的 class（实际都渲染成 ${ok}）—— 这就是 D7`);
  assert.notEqual(ok, warn, `生效与无法判定必须是不同的 class（实际都渲染成 ${ok}）`);
  assert.notEqual(bad, warn, `未生效与无法判定必须是不同的 class（实际都渲染成 ${bad}）`);
  assert.ok(!/(^|\s)mk-ok(\s|$)/.test(unknown),
    `未知 verdict 必须落在非成功一侧（实际 ${unknown}）—— 未知值画成绿就是"把无法判定说成成功"`);
});

test('回归/删除闸门（行为）：还原会删除"备份时不存在"的文件时，必须先确认再发 /api/restore', async () => {
  /**
   * 为什么必须加：审计 reg02 —— `doRestore` 的 `willDelete` + `askConfirm` 整段
   * **零覆盖**：把它整段删掉，整轮仍然全绿。而它是"删除不可逆地丢内容"的唯一一道闸门。
   *
   * 断言四件事（顺序即用户路径）：
   *   ① 第一发必须只是 dryRun 预演（先算清会删什么）；
   *   ② 有删除项 → 必须先出现确认对话框，且**用户同意之前**绝不许发实际还原；
   *   ③ 点「取消」→ 仍然不许发实际还原，并且明说"没有修改任何文件"；
   *   ④ 再来一次点「继续」→ 这时才发确认过的实际还原。
   */
  const backups = [{ id: 'bk-20261102-1', createdAt: '2026-11-02T00:00:00Z', entries: 3, reason: 'apply personalization.soul' }];
  await loadApp({
    mode: 'ok',
    handles: [SOUL_HANDLE],
    overview: {
      version: '5.9.3', configRoot: 'c', storeRoot: 's',
      health: { ok: true, anchors: 11, anchorFailures: 0, handles: 1 },
      gate: { appRunning: false }, drift: { available: false },
      customized: [], unknown: [], todos: [], recent: [], backups, counts: {},
    },
    restorePreview: { changed: ['C:/x/SOUL.md'], willDelete: [{ absPath: 'C:\\x\\DROPPED.md' }] },
  });
  const root = await boot();
  const nav = (label) => {
    const b = root.querySelectorAll('.nav-tab').find((x) => x.textContent.trim() === label);
    assert.ok(b, `找不到导航「${label}」`);
    b.click();
  };
  nav('守护');
  await tick(150);

  /** 时间线里的「还原」按钮（每次 render 后都要重查：节点会被重建） */
  const restoreBtn = () => {
    const row = root.querySelectorAll('.tl-row')[0];
    assert.ok(row, '找不到备份时间线的行');
    const b = row.querySelectorAll('button').find((x) => x.textContent.trim() === '还原');
    assert.ok(b, '备份时间线里必须有「还原」按钮');
    return b;
  };
  const restores = () => H.apiCalls.filter((c) => c.path === '/api/restore');
  const executions = () => restores().filter((c) => bodyOf(c.opts).confirm === true);

  restoreBtn().click();
  await tick(200);

  assert.equal(restores().length, 1, `第一发必须只有 dryRun 预演（实际 ${restores().length} 发）`);
  assert.equal(bodyOf(restores()[0].opts).dryRun, true, '第一发必须是 dryRun 预演：先把"将删哪些文件"算清楚');
  assert.equal(executions().length, 0, '用户还没同意，绝不许先发实际还原');

  const dlg = root.querySelector('.dlg-overlay');
  assert.ok(dlg, '备份里有"备份时不存在"的条目 → 还原必须先弹确认（删掉是不可逆的）');
  assert.match(dlg.textContent, /删除/, `确认框必须说清会删除文件，实际文案：${dlg.textContent.slice(0, 200)}`);

  // ③ 取消
  const cancel = dlg.querySelectorAll('button').find((b) => b.textContent.trim() === '取消');
  assert.ok(cancel, '确认框必须有「取消」');
  cancel.click();
  await tick(200);
  assert.equal(executions().length, 0, '点了「取消」之后绝不许发实际还原');
  assert.match(root.textContent, /已取消还原/, '取消必须明说"没有修改任何文件"，不许静默什么都不做');

  // ④ 重新来一次，这回同意
  assert.equal(root.querySelector('.dlg-overlay'), null, '取消之后对话框必须收起');
  restoreBtn().click();
  await tick(200);
  const dlg2 = root.querySelector('.dlg-overlay');
  assert.ok(dlg2, '第二次还原也必须先弹确认（不是只弹一次就永久放行）');
  const ok2 = dlg2.querySelectorAll('button').find((b) => b.textContent.trim() === '继续');
  assert.ok(ok2, '确认框必须有「继续」');
  ok2.click();
  await tick(250);
  assert.equal(executions().length, 1, `确认之后必须恰好发一发实际还原（实际 ${executions().length} 发）`);
});
