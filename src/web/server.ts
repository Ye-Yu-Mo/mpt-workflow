import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, readText, realPath, within } from '../core/fsutil.js';
import { diffStat, diffUnified, recentLog, workingTreeHash } from '../core/git.js';
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
 * Reject a different loopback port too: another local dev server must not be
 * able to write as the user just because its hostname is 127.0.0.1.
 */
function isCrossOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
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
      if (data.length > 2 * 1024 * 1024) {
        req.destroy();
        reject(new Error('body too large'));
      }
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
  const realAbs = realPath(abs);
  if (
    !within(realPath(PUBLIC_DIR), realAbs) ||
    !exists(realAbs) ||
    fs.statSync(realAbs).isDirectory()
  ) {
    res.writeHead(404).end('not found');
    return;
  }
  const ext = path.extname(realAbs);
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
  fs.createReadStream(realAbs).pipe(res);
}

export interface WebHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function startWebServer(wf: Workflow, port: number): Promise<WebHandle> {
  const server = http.createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad request');
      return;
    }
    const p = url.pathname;

    // Loopback-only + same-origin. The server has no authentication, so DNS
    // rebinding, cross-site form posts and other localhost ports must be refused.
    if (!LOCAL_HOSTS.has(hostName(req))) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden');
      return;
    }
    const site = String(req.headers['sec-fetch-site'] || '');
    if (site && site !== 'same-origin' && site !== 'none') {
      res
        .writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        .end('cross-site request rejected');
      return;
    }
    if (isCrossOrigin(req)) {
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
          const approvals = wf.approvals().map((a) => {
            try {
              return { ...a, stale: workingTreeHash(wf.repoRef(a.repo).abs) !== a.tree_hash };
            } catch {
              return { ...a, stale: true };
            }
          });
          return json(res, approvals);
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
        if (req.method === 'POST' && /^\/api\/message\/[A-Za-z0-9-]+\/(ack|read)$/.test(p)) {
          const [, , , id, action] = p.split('/');
          const body = action === 'ack' ? await readBody(req) : {};
          const m =
            action === 'ack'
              ? wf.msgs.ack(id, body.note ? String(body.note) : undefined)
              : wf.msgs.markRead(id);
          if (!m) return json(res, { error: `no such message ${id}` }, 404);
          if (action === 'ack') {
            logEvent(wf.root, {
              role: 'user',
              tool: 'web_message_ack',
              ok: true,
              detail: { message: id },
            });
          }
          return json(res, m);
        }
        if (req.method === 'GET' && p === '/api/presence') {
          return json(res, wf.msgs.presence());
        }
        if (req.method === 'GET' && p === '/api/diff') {
          const repo = url.searchParams.get('repo') || '';
          if (!repo) return json(res, { error: 'repo required' }, 400);
          const ref = wf.repoRef(repo);
          const full = diffUnified(ref.abs);
          const limit = 200_000;
          const truncated = full.length > limit;
          return json(res, {
            stat: diffStat(ref.abs),
            diff: truncated ? `${full.slice(0, limit)}\n... [diff 已截断]` : full,
            truncated,
            log: recentLog(ref.abs, 8),
          });
        }
        if (req.method === 'GET' && p.startsWith('/api/repo/')) {
          const id = decodeURIComponent(p.slice('/api/repo/'.length));
          return json(res, wf.repoState(id));
        }
        if (req.method === 'POST' && /^\/api\/question\/[A-Za-z0-9_-]+\/answer$/.test(p)) {
          const id = p.split('/')[3];
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
        if (req.method === 'POST' && /^\/api\/question\/[A-Za-z0-9_-]+\/close$/.test(p)) {
          const id = p.split('/')[3];
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
          const realAbs = realPath(abs);
          const realRepo = realPath(ref.abs);
          if (!within(realRepo, realAbs)) return json(res, { error: 'outside repo' }, 403);
          const relPosix = path.relative(realRepo, realAbs).split(path.sep).join('/');
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
