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
export function createConsoleServer({ configRoot, storeRoot, version }) {
  registerAll();
  const engine = createEngine({ configRoot, storeRoot, version, actor: 'web' });
  const token = crypto.randomBytes(24).toString('base64url');

  /** @param {string} pathname */
  async function dispatch(pathname, method, body, url) {
    if (pathname === '/api/doctor' && method === 'GET') return engine.doctor();
    if (pathname === '/api/backups' && method === 'GET') return engine.backups();
    if (pathname === '/api/audit' && method === 'GET') {
      return engine.audit(Number(url.searchParams.get('limit') ?? 50));
    }
    if (pathname === '/api/restore' && method === 'POST') {
      return engine.restore(String(body.backupId ?? ''), { dryRun: body.dryRun === true });
    }

    // ── 专家档位（多把手事务）──
    if (pathname === '/api/profiles' && method === 'GET') return engine.profiles();
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

    const m = /^\/api\/handle\/([^/]+)\/(probe|plan|apply|verify)$/.exec(pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const op = m[2];
      if (op === 'probe' && method === 'GET') return engine.probe(id);
      if (op === 'plan' && method === 'POST') return engine.plan(id, { next: body.next ?? '' });
      if (op === 'apply' && method === 'POST') {
        return engine.apply(id, {
          next: body.next ?? '',
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
      const code = e instanceof ConsoleError ? e.code : 'INTERNAL';
      const status = code === 'UNAUTHORIZED' ? 401 : code === 'NOT_FOUND' ? 404 : 400;
      sendJson(status, {
        ok: false,
        error: { code, message: e?.message ?? String(e), detail: e?.detail ?? (code === 'INTERNAL' ? String(e?.stack ?? '') : {}) },
      });
    }
  });

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
export async function startConsole({ root, port } = {}) {
  const configRoot = resolveConfigRoot(root);
  const storeRoot = resolveStoreRoot();
  const app = createConsoleServer({ configRoot, storeRoot });
  const { url, port: actual } = await app.listen(port ?? 0);
  const d = app.describe();

  // 把带令牌的 URL 落一份，便于重开控制台（该文件含令牌，只在用户数据目录内）
  const dir = path.join(storeRoot, 'state');
  fs.mkdirSync(dir, { recursive: true });
  const urlFile = path.join(dir, 'console-url.txt');
  fs.writeFileSync(urlFile, `${url}\n`, 'utf8');

  return { app, url, port: actual, urlFile, ...d };
}
