import fs from 'node:fs';
import path from 'node:path';
import { appendLine, ensureDir, exists, readText, writeAtomic, isoNow, slugDate } from './fsutil.js';
import { eventsPath, approvalsDir, locksDir } from './config.js';
import type { Role } from './types.js';

export interface EventRecord {
  ts?: string;
  seq?: number;
  role: Role | string;
  actor?: string;
  tool: string;
  repo?: string;
  milestone?: string;
  question?: string;
  detail?: unknown;
  ok?: boolean;
}

export function logEvent(root: string, e: EventRecord): void {
  const p = eventsPath(root);
  ensureDir(path.dirname(p));
  const line = JSON.stringify({ ...e, ts: e.ts || isoNow() });
  try {
    appendLine(p, line);
  } catch {
    // auditing must never break the operation
  }
}

export function readEvents(root: string, limit = 500): EventRecord[] {
  const p = eventsPath(root);
  if (!exists(p)) return [];
  const lines = readText(p).split('\n').filter(Boolean);
  const out: EventRecord[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line) as EventRecord);
    } catch {
      /* skip malformed */
    }
  }
  return out.reverse();
}

/* --------------------------- advisory locks --------------------------- */

export interface LockHandle {
  path: string;
  release: () => void;
}

/**
 * Directory-based lock. Stale locks older than `staleMs` are reclaimed.
 * Advisory: used to serialize config/question writes across MCP processes.
 */
export function acquireLock(root: string, name: string, staleMs = 30_000): LockHandle | null {
  const dir = locksDir(root);
  ensureDir(dir);
  const p = path.join(dir, `${name}.lock`);
  const now = Date.now();
  try {
    fs.mkdirSync(p);
    fs.writeFileSync(path.join(p, 'pid'), String(process.pid));
  } catch {
    try {
      const st = fs.statSync(p);
      if (now - st.mtimeMs > staleMs) {
        fs.rmSync(p, { recursive: true, force: true });
        fs.mkdirSync(p);
        fs.writeFileSync(path.join(p, 'pid'), String(process.pid));
      } else {
        return null;
      }
    } catch {
      return null;
    }
  }
  let released = false;
  return {
    path: p,
    release: () => {
      if (released) return;
      released = true;
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

export function withLock<T>(root: string, name: string, fn: () => T): T {
  const lock = acquireLock(root, name);
  if (!lock) throw new Error(`无法获取锁 ${name}；可能有另一个进程正在写状态`);
  try {
    return fn();
  } finally {
    lock.release();
  }
}

/* ------------------------------- approvals ------------------------------ */

export interface Approval {
  id: string;
  repo: string;
  tree_hash: string;
  message: string;
  files: string[];
  created_at: string;
  approved_at?: string;
  approved_by?: string;
  used_at?: string;
  reason?: string;
}

export function createApproval(root: string, a: Omit<Approval, 'id' | 'created_at'>): Approval {
  const id = `ap-${slugDate()}-${Math.random().toString(36).slice(2, 6)}`;
  const rec: Approval = { ...a, id, created_at: isoNow() };
  const p = path.join(approvalsDir(root), `${id}.json`);
  ensureDir(path.dirname(p));
  writeAtomic(p, JSON.stringify(rec, null, 2));
  return rec;
}

export function readApproval(root: string, id: string): Approval | null {
  const p = path.join(approvalsDir(root), `${id}.json`);
  if (!exists(p)) return null;
  try {
    return JSON.parse(readText(p)) as Approval;
  } catch {
    return null;
  }
}

export function writeApproval(root: string, a: Approval): void {
  const p = path.join(approvalsDir(root), `${a.id}.json`);
  writeAtomic(p, JSON.stringify(a, null, 2));
}

export function listApprovals(root: string): Approval[] {
  const dir = approvalsDir(root);
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readText(path.join(dir, f))) as Approval;
      } catch {
        return null;
      }
    })
    .filter((x): x is Approval => !!x)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
