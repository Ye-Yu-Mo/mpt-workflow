import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, readText, within } from '../core/fsutil.js';
import { diffStat, diffUnified, recentLog } from '../core/git.js';
import { logEvent, readEvents } from '../core/state.js';
import type { Workflow } from '../core/workflow.js';
import { VERSION } from '../version.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Prefer the build output (dist/web/public); fall back to the source tree when
// running through tsx during development.
const PUBLIC_DIR =
  [path.resolve(here, 'public'), path.resolve(here, '..', '..', 'src', 'web', 'public')].find((p) =>
    exists(p),
  ) || path.resolve(here, 'public');

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Host header without the port, for loopback-only enforcement. */
function hostName(req: http.IncomingMessage): string {
  return (req.headers.host || '').replace(/:\d+$/, '');
}

/**
 * Browsers attach Origin to cross-origin writes. Rejecting them closes the
 * CSRF hole without adding tokens to a localhost-only dashboard.
 */
function isCrossOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return !LOCAL_HOSTS.has(new URL(origin).hostname);
  } catch {
    return true;
  }
}

function json(res: http.ServerResponse, data: unknown, code = 200) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res: http.ServerResponse, rel: string) {
  const cleaned = rel.replace(/^\/+/, '') || 'index.html';
  const abs = path.resolve(PUBLIC_DIR, cleaned);
  if (!within(PUBLIC_DIR, abs) || !exists(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  const ext = path.extname(abs);
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
  };
  res.writeHead(200, {
    'content-type': types[ext] || 'application/octet-stream',
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(abs).pipe(res);
}

export interface WebHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function startWebServer(wf: Workflow, port: number): Promise<WebHandle> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const p = url.pathname;
    const method = req.method || 'GET';

    // Loopback-only + same-origin writes. The server has no authentication, so
    // DNS rebinding and cross-site form posts must be refused here.
    if (!LOCAL_HOSTS.has(hostName(req))) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden');
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && isCrossOrigin(req)) {
      res
        .writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        .end('cross-origin request rejected');
      return;
    }

    try {
      if (p.startsWith('/api/')) {
        if (req.method === 'GET' && p === '/api/status') {
          return json(res, { ...wf.programStatus(), version: VERSION });
        }
        if (req.method === 'GET' && p === '/api/questions') {
          return json(res, wf.allQuestions());
        }
        if (req.method === 'GET' && p === '/api/events') {
          const limit = Number(url.searchParams.get('limit') || 200);
          return json(res, readEvents(wf.root, limit));
        }
        if (req.method === 'GET' && p === '/api/approvals') {
          return json(res, wf.approvals());
        }
        if (req.method === 'GET' && p === '/api/messages') {
          const role = (url.searchParams.get('role') || 'user') as
            | 'main'
            | 'plan'
            | 'todo'
            | 'user';
          const repo = url.searchParams.get('repo') || undefined;
          const target = { role, repo };
          wf.msgs.promoteQueued(target);
          wf.msgs.expireDue();
          return json(res, {
            actor: target,
            unread: wf.msgs.unreadCount(target),
            blocking: wf.msgs.blockingFor(target),
            messages: wf.msgs.forActor(target, {
              includeAcked: url.searchParams.get('all') === '1',
              unreadOnly: url.searchParams.get('unread') === '1',
              limit: Number(url.searchParams.get('limit') || 100),
            }),
          });
        }
        if (req.method === 'POST' && /^\/api\/message\/[^/]+\/ack$/.test(p)) {
          const id = decodeURIComponent(p.split('/')[3]);
          const body = await readBody(req);
          const m = wf.msgs.ack(id, body.note ? String(body.note) : undefined);
          if (!m) return json(res, { error: `no such message ${id}` }, 404);
          logEvent(wf.root, {
            role: 'user',
            tool: 'web_message_ack',
            ok: true,
            detail: { message: id },
          });
          return json(res, m);
        }
        if (req.method === 'POST' && /^\/api\/message\/[^/]+\/read$/.test(p)) {
          const id = decodeURIComponent(p.split('/')[3]);
          const m = wf.msgs.markRead(id);
          if (!m) return json(res, { error: `no such message ${id}` }, 404);
          return json(res, m);
        }
        if (req.method === 'GET' && p === '/api/presence') {
          return json(res, wf.msgs.presence());
        }
        if (req.method === 'GET' && p === '/api/diff') {
          const repo = url.searchParams.get('repo') || '';
          if (!repo) return json(res, { error: 'repo required' }, 400);
          const ref = wf.repoRef(repo);
          return json(res, {
            stat: diffStat(ref.abs),
            diff: diffUnified(ref.abs).slice(0, 200_000),
            log: recentLog(ref.abs, 8),
          });
        }
        if (req.method === 'GET' && p.startsWith('/api/repo/')) {
          const id = decodeURIComponent(p.slice('/api/repo/'.length));
          return json(res, wf.repoState(id));
        }
        if (req.method === 'POST' && /^\/api\/question\/[^/]+\/answer$/.test(p)) {
          const id = decodeURIComponent(p.split('/')[3]);
          const body = await readBody(req);
          const q = wf.findQuestion(id);
          if (!q) return json(res, { error: `no such question ${id}` }, 404);
          wf.answerQuestion(
            q,
            String(body.answer ?? ''),
            body.resolution ? String(body.resolution) : undefined,
            { role: 'user' },
          );
          logEvent(wf.root, {
            role: 'user',
            tool: 'web_answer',
            question: id,
            repo: q.repo,
            ok: true,
          });
          return json(res, { ok: true, id });
        }
        if (req.method === 'POST' && /^\/api\/question\/[^/]+\/close$/.test(p)) {
          const id = decodeURIComponent(p.split('/')[3]);
          const body = await readBody(req);
          const q = wf.findQuestion(id);
          if (!q) return json(res, { error: `no such question ${id}` }, 404);
          wf.closeQuestion(q, body.resolution ? String(body.resolution) : q.resolution, {
            role: 'user',
          });
          logEvent(wf.root, {
            role: 'user',
            tool: 'web_close',
            question: id,
            repo: q.repo,
            ok: true,
          });
          return json(res, { ok: true, id });
        }
        if (req.method === 'POST' && p === '/api/approve') {
          const body = await readBody(req);
          const a = wf.approve(String(body.id));
          return json(res, a);
        }
        if (req.method === 'POST' && p === '/api/activate') {
          const body = await readBody(req);
          const repo = String(body.repo || '');
          wf.setActiveRepo(repo || null);
          logEvent(wf.root, {
            role: 'user',
            tool: 'web_activate',
            repo: repo || undefined,
            ok: true,
          });
          return json(res, { ok: true, activeRepo: wf.cfg.active_repo });
        }
        if (req.method === 'GET' && p === '/api/doctor') {
          return json(res, wf.doctor());
        }
        if (req.method === 'GET' && p === '/api/files') {
          const repo = url.searchParams.get('repo') || '';
          const rel = url.searchParams.get('path') || '';
          if (!repo || !rel) return json(res, { error: 'repo and path required' }, 400);
          const ref = wf.repoRef(repo);
          const abs = path.resolve(ref.abs, rel);
          if (!within(ref.abs, abs)) return json(res, { error: 'outside repo' }, 400);
          const relPosix = path.relative(ref.abs, abs).split(path.sep).join('/');
          const allowed =
            relPosix === 'PLAN.md' ||
            /^TODO-M\d+\.md$/.test(relPosix) ||
            relPosix.startsWith('docs/') ||
            /^MS-[^/]+\//.test(relPosix);
          if (!allowed) return json(res, { error: 'path not readable via the dashboard' }, 403);
          return json(res, { path: relPosix, content: readText(abs) });
        }
        return json(res, { error: 'not found' }, 404);
      }

      if (req.method === 'GET') return serveStatic(res, p);
      return json(res, { error: 'not found' }, 404);
    } catch (e) {
      return json(res, { error: (e as Error).message }, 500);
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = (server.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${actual}`;
      console.log(`workflow 看板: ${url}`);
      console.log(`程序: ${wf.cfg.program}  根目录: ${wf.root}`);
      resolve({
        port: actual,
        url,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
