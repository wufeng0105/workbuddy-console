/**
 * 本地控制台服务端 —— 唯一持有写权限的进程。
 *
 * 边界契约（docs/framework.md 第六节 / 第九节）：
 *   - **仅回环**：绑定 127.0.0.1，绝不监听 0.0.0.0
 *   - **随机端口 + 一次性 token**：每次启动生成，页面从 URL 取一次
 *   - 前端**永不直接触碰文件系统**，一切动作经本服务
 *   - 厂商文件写入需显式 confirm（铁律 5），由前端二次确认
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createEngine } from './core/engine.mjs';
import { registerAll } from './handles/index.mjs';
import { configRoot as resolveConfigRoot, storeRoot as resolveStoreRoot, tildify } from './core/paths.mjs';
import { ConsoleError } from './core/errors.mjs';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const BODY_LIMIT = 4 * 1024 * 1024;

/** @param {http.IncomingMessage} req */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new ConsoleError('BODY_TOO_LARGE', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** @param {string} p */
function safeJoin(base, rel) {
  const target = path.resolve(base, `.${path.posix.normalize(`/${rel}`)}`);
  if (!target.startsWith(path.resolve(base))) throw new ConsoleError('PATH_ESCAPE', '路径越界');
  return target;
}

/**
 * @param {{configRoot:string, storeRoot:string, version?:string}} opts
 */
export function createConsoleServer({ configRoot, storeRoot, version, isolatedBaselines = false }) {
  registerAll();
  /**
   * 隔离运行（显式给了非默认 `--store`）时，最初基线账本也放到那个 store 下。
   *
   * 为什么：默认位置是**项目目录** `baselines/`，那是给正常使用准备的（账本随仓库维护）。
   * 但隔离运行的目的是"不碰真实数据"——如果账本还往项目目录写，
   * 启动时的自动补建就会把 fixture 的合成账本落进真实账本目录（实测踩过两次）。
   */
  const engine = createEngine({
    configRoot,
    storeRoot,
    version,
    actor: 'web',
    baselinesDir: isolatedBaselines ? path.join(storeRoot, 'baselines') : undefined,
  });
  const token = crypto.randomBytes(24).toString('base64url');

  // 启动时补建「最初基线」——只在缺失时捕获，绝不覆盖（不可修改语义）
  engine.baselineCapture().then((b) => {
    console.log(b.note ?? `最初基线已就绪（${Object.keys(b.entries ?? {}).length} 项，${b.capturedAt}）`);
  }).catch((e) => {
    console.error('最初基线建立失败：', e.message);
  });

  /** @param {string} pathname */
  async function dispatch(pathname, method, body, url) {
    if (pathname === '/api/doctor' && method === 'GET') return engine.doctor();
    if (pathname === '/api/overview' && method === 'GET') return engine.overview();
    if (pathname === '/api/backups' && method === 'GET') return engine.backups();
    if (pathname === '/api/audit' && method === 'GET') {
      return engine.audit(Number(url.searchParams.get('limit') ?? 50));
    }
    if (pathname === '/api/restore' && method === 'POST') {
      /**
       * 边界契约（T10）：按备份还原是**写操作**，它会逐字节覆盖目标文件；
       * 更危险的是 `restoreBackup` 对"备份时本不存在"的条目执行 `rmSync` —— 也就是**删除**。
       *
       * 曾经：这个接口既不要 confirm、也不过闸门，任何人点一下就能删/覆盖文件，
       * 且删除动作不会单独回报给用户（只在 results 里一个 action:'delete'）。
       * 现在：必须显式 confirm；并先做 dryRun 预演，把"将要删除哪些文件"原样回报。
       */
      const backupId = String(body.backupId ?? '');
      const dryRun = body.dryRun === true;
      if (!dryRun && body.confirm !== true) {
        throw new ConsoleError(
          'CONFIRMATION_REQUIRED',
          '还原会覆盖甚至删除目标文件，需显式确认（confirm: true）。可先用 dryRun:true 预演。',
          { backupId },
        );
      }
      // 预演：先把"将要发生什么"算出来，并把删除项显式列出来
      const preview = engine.restore(backupId, { dryRun: true });
      const willDelete = preview.results.filter((x) => x.action === 'delete');
      if (dryRun) return { ...preview, willDelete };

      /**
       * 闸门（独立复核 D3）：还原是写操作，必须与 apply 过同一道闸。
       *
       * 曾经：`apply` 对需停机的把手会 400 `GATE_BLOCKED`，而 `restore` 直接**放行并真写入** ——
       * WorkBuddy 运行中也能写厂商文件。这是"同一类写操作两套规矩"。
       * `restore` 一条备份可能覆盖多个把手，所以按"最严"处理：只要有一条被闸门阻断，整体拒绝。
       */
      const gateBlock = engine.checkRestoreGate(backupId);
      if (gateBlock.blocked) {
        throw new ConsoleError(
          'GATE_BLOCKED',
          gateBlock.reason,
          { backupId, handles: gateBlock.handles, gate: gateBlock.gate },
        );
      }

      const r = engine.restore(backupId, { dryRun: false });
      return {
        ...r,
        willDelete,
        deleted: r.changed.filter((x) => x.action === 'delete'),
        note: willDelete.length
          ? `注意：本备份里有 ${willDelete.length} 个文件在备份时并不存在，还原会把它们**删除**`
          : undefined,
      };
    }
    // ── 最初基线 ──
    if (pathname === '/api/baseline' && method === 'GET') return engine.baseline();
    if (pathname === '/api/baseline/capture' && method === 'POST') return engine.baselineCapture();
    if (pathname === '/api/baseline/restore' && method === 'POST') {
      return engine.baselineRestore(String(body.id ?? ''), { confirm: body.confirm === true });
    }

    // ── 专家档位（多把手事务）──
    if (pathname === '/api/profiles' && method === 'GET') return engine.profiles();
    if (pathname.startsWith('/api/profiles/') && method === 'GET') {
      return engine.profileDetail(decodeURIComponent(pathname.slice('/api/profiles/'.length)));
    }
    if (pathname === '/api/profiles/save' && method === 'POST') {
      return engine.captureProfile({
        name: String(body.name ?? ''),
        id: typeof body.id === 'string' && body.id.trim() ? body.id.trim() : undefined,
      });
    }
    if (pathname === '/api/profiles/plan' && method === 'POST') {
      return engine.planProfile(String(body.id ?? ''));
    }
    if (pathname === '/api/profiles/apply' && method === 'POST') {
      return engine.applyProfile(String(body.id ?? ''), { confirm: body.confirm === true });
    }
    if (pathname === '/api/profiles/verify' && method === 'POST') {
      return engine.verifyProfile(String(body.id ?? ''));
    }
    if (pathname === '/api/profiles/delete' && method === 'POST') {
      return engine.removeProfile(String(body.id ?? ''));
    }

    // ── 版本重放（演进契约）──
    if (pathname === '/api/bundle' && method === 'POST') return engine.captureBundle();
    if (pathname === '/api/drift' && method === 'GET') return engine.checkDrift();
    if (pathname === '/api/replay' && method === 'POST') {
      return engine.replay({
        only: Array.isArray(body.only) && body.only.length ? body.only : undefined,
        confirm: body.confirm === true,
      });
    }

    // ── P3 · 审批自动同意 ──
    if (pathname === '/api/approval' && method === 'GET') return engine.approvalState();
    if (pathname === '/api/approval/plan' && method === 'POST') {
      return engine.planApproval(String(body.level ?? ''));
    }
    if (pathname === '/api/approval/apply' && method === 'POST') {
      return engine.applyApproval(String(body.level ?? ''), { confirm: body.confirm === true });
    }
    if (pathname === '/api/approval/verify' && method === 'POST') {
      return engine.verifyApproval(String(body.level ?? ''));
    }

    const m = /^\/api\/handle\/([^/]+)\/(probe|plan|apply|verify)$/.exec(pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const op = m[2];
      if (op === 'probe' && method === 'GET') return engine.probe(id);
      if (op === 'plan' && method === 'POST') return engine.plan(id, { next: body.next ?? '' });
      if (op === 'apply' && method === 'POST') {
        /**
         * ⚠️ 这里**不许**用 `body.next ?? ''`（F1 的 HTTP 腿，CRITICAL）。
         *
         * `??` 把"body 里根本没有 `next` 这个键"与"显式传空串"合并成同一个值 `''`，
         * 于是引擎那条"漏传 next 就拒绝"的硬防线（`engine.mjs` 的 `next === undefined`）
         * 在 HTTP 层被**提前绕过**。实测（Lead 亲测）：
         *   `POST /api/handle/personalization.soul/apply` body `{}`
         *   → SOUL.md 31 B → 0 B，响应却是 `ok:true`。
         *
         * 现在只认"键真的存在"：
         *   - 键缺失 → 传 `undefined`，交给引擎抛 `INPUT_MISSING`；
         *   - 显式 `''` / `0` / `false` → 原样传（它们是合法写入值，不许误伤，
         *     清空文件必须走显式 `next:""`，这是故意的`不便`）；
         *   - JSON 的 `null` → 也按"没传"拒绝。没有任何把手认 null 作为写入值
         *     （`identity-file` 的 `truncateToInjectionLimit` 会把非字符串当空文本），
         *     此前 `?? ''` 同样把它变成空串 —— 那正是"清空文件"这条路。
         */
        const hasNext = Object.prototype.hasOwnProperty.call(body, 'next');
        return engine.apply(id, {
          next: hasNext && body.next !== null ? body.next : undefined,
          confirm: body.confirm === true,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
        });
      }
      if (op === 'verify' && method === 'POST') return engine.verify(id, body.args ?? {});
    }

    throw new ConsoleError('NOT_FOUND', `未知接口：${method} ${pathname}`);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    /** @param {number} status @param {any} obj */
    const sendJson = (status, obj) => {
      const text = JSON.stringify(obj, null, 2);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(text);
    };

    try {
      // ── 静态页 ──
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && pathname.startsWith('/static/')) {
        const file = safeJoin(WEB_DIR, pathname.slice('/static/'.length));
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new ConsoleError('NOT_FOUND', '资源不存在');
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(fs.readFileSync(file));
        return;
      }

      // ── API ──
      if (pathname.startsWith('/api/')) {
        const given = req.headers['x-wbc-token'] ?? url.searchParams.get('token') ?? '';
        const a = Buffer.from(String(given));
        const b = Buffer.from(token);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          sendJson(401, { error: { code: 'UNAUTHORIZED', message: '缺少或错误的会话令牌' } });
          return;
        }
        const raw = req.method === 'POST' ? await readBody(req) : '';
        let body = {};
        if (raw.trim()) {
          try { body = JSON.parse(raw); } catch { throw new ConsoleError('BAD_JSON', '请求体不是合法 JSON'); }
        }
        const result = await dispatch(pathname, req.method ?? 'GET', body, url);
        sendJson(200, { ok: true, data: result });
        return;
      }

      throw new ConsoleError('NOT_FOUND', `未知路径：${pathname}`);
    } catch (e) {
      /**
       * 错误码不能一律 INTERNAL（T6）。
       *
       * 曾经：非 `ConsoleError` 一律回 `code:'INTERNAL'` + 把原始堆栈塞进 `detail` 发给浏览器。
       * 后果有二：① 前端只能显示「写入失败 [INTERNAL] EPERM: operation not permitted, open 'C:\\…'」
       * ——用户看不出"这是没权限"，而这次"点应用没反应"正是被这句话掩盖的；
       * ② 堆栈含本机绝对路径与源码行号，属于不必要的暴露面。
       *
       * 现在：把常见的系统错误映射成可判定的稳定码；堆栈只写进服务端日志，不进响应。
       */
      const sysErr = mapSystemError(e);
      const isConsole = e instanceof ConsoleError;
      const code = isConsole ? e.code : (sysErr?.code ?? 'INTERNAL');
      const status = code === 'UNAUTHORIZED' ? 401
        : code === 'NOT_FOUND' ? 404
          : code === 'PERMISSION_DENIED' ? 403
            : 400;
      if (!isConsole) {
        // 堆栈只进服务端日志（运维可见），不进响应（前端不需要、也不该拿到本机路径）
        console.error(`[${new Date().toISOString()}] ${req.method} ${pathname} → ${code}:`, e?.stack ?? e);
      }
      sendJson(status, {
        ok: false,
        error: {
          code,
          message: isConsole ? (e?.message ?? String(e)) : (sysErr?.message ?? e?.message ?? String(e)),
          detail: isConsole ? (e.detail ?? {}) : (sysErr ? { hint: sysErr.hint } : {}),
        },
      });
    }
  });

  /**
   * 把 Node 的系统错误翻译成"用户能据此行动"的错误码。
   * @param {any} e
   * @returns {{code:string, message:string, hint:string}|null}
   */
  function mapSystemError(e) {
    const errno = String(e?.code ?? '');
    const p = String(e?.path ?? '');
    const where = p ? `（${p}）` : '';
    if (errno === 'EPERM' || errno === 'EACCES') {
      return {
        code: 'PERMISSION_DENIED',
        message: `没有权限写入${where}`,
        hint: '目标可能在受保护目录（如 Program Files），或文件被 WorkBuddy / 安全软件占用。'
          + '厂商文件需要管理员权限；用户目录下的文件通常是 WorkBuddy 运行中锁住了。',
      };
    }
    if (errno === 'ENOENT') {
      return { code: 'NOT_FOUND_PATH', message: `目标路径不存在${where}`, hint: '锚点可能失效（WorkBuddy 升级换了目录）——去「守护」页看漂移。' };
    }
    if (errno === 'EBUSY' || errno === 'ETXTBSY') {
      return { code: 'FILE_BUSY', message: `文件被占用${where}`, hint: '先退出 WorkBuddy 再试。' };
    }
    if (errno === 'ENOSPC') {
      return { code: 'DISK_FULL', message: '磁盘空间不足', hint: '清理磁盘后重试。' };
    }
    return null;
  }

  return {
    engine,
    token,
    server,
    /** @param {number} [port] */
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address();
          resolve({ port: addr.port, url: `http://127.0.0.1:${addr.port}/?token=${token}` });
        });
      });
    },
    close() { return new Promise((r) => server.close(() => r())); },
    describe() {
      return { configRoot: tildify(configRoot), storeRoot: tildify(storeRoot), version: engine.resolver.version };
    },
  };
}

/** 便捷入口：用默认路径起服务并打印 URL */
export async function startConsole({ root, store, port } = {}) {
  const configRoot = resolveConfigRoot(root);
  // `store` 与 CLI 的 `--store` 同义（显式参数 > 环境变量 > 默认）
  const storeRoot = resolveStoreRoot(store);
  /**
   * 显式给了 `--store` = 调用方在要一个**隔离环境**（fixture、e2e、试跑）。
   * 那就连最初基线账本一起隔离到那个 store 下，别落进项目 `baselines/`。
   * 不给 `--store` 的正常路径保持原样（账本仍在项目目录，随仓库维护）。
   */
  const isolated = typeof store === 'string' && store.trim() !== '' && store !== resolveStoreRoot();
  const app = createConsoleServer({ configRoot, storeRoot, isolatedBaselines: isolated });
  const { url, port: actual } = await app.listen(port ?? 0);
  const d = app.describe();
  /** 令牌在 createConsoleServer 的作用域里，这里从 app 取 */
  const token = app.token;

  // 把带令牌的 URL 落一份，便于重开控制台（该文件含令牌，只在用户数据目录内）
  //
  // 为什么要落"全部入口"而不只是首页：
  //   令牌每次启动都变，人手抄链接必然出错（已发生过一次：贴了上一轮的旧令牌，
  //   页面打开全是 401）。所以把**每种可用地址**都写进文件，用完直接复制。
  const dir = path.join(storeRoot, 'state');
  fs.mkdirSync(dir, { recursive: true });
  const urlFile = path.join(dir, 'console-url.txt');
  const lines = [
    `# workbuddy-console · 启动于 ${new Date().toISOString()}`,
    `# 令牌随每次启动变化；本文件每次启动重写`,
    ``,
    `# 控制台`,
    url,
  ];
  fs.writeFileSync(urlFile, `${lines.join('\n')}\n`, 'utf8');

  return { app, url, port: actual, urlFile, ...d };
}
