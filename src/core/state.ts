import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { approvalsDir, eventsPath, locksDir } from './config.js';
import {
  appendLine,
  ensureDir,
  exists,
  isoNow,
  readText,
  slugDate,
  writeAtomic,
} from './fsutil.js';
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
  /** Unique owner token; release only removes the lock if it still owns it. */
  token: string;
  release: () => void;
}

function writeLockOwner(p: string, token: string): void {
  fs.writeFileSync(path.join(p, 'pid'), String(process.pid));
  fs.writeFileSync(path.join(p, 'owner'), token);
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
  const token = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.mkdirSync(p);
    writeLockOwner(p, token);
  } catch {
    try {
      const st = fs.statSync(p);
      if (now - st.mtimeMs > staleMs) {
        // Reclaim atomically: only one process can rename the stale directory
        // away, so two waiters cannot both delete each other's fresh lock.
        const dead = `${p}.stale-${process.pid}-${Date.now()}`;
        try {
          fs.renameSync(p, dead);
        } catch {
          return null;
        }
        try {
          fs.rmSync(dead, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup of the renamed directory */
        }
        fs.mkdirSync(p);
        writeLockOwner(p, token);
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
    token,
    release: () => {
      if (released) return;
      released = true;
      try {
        // A stale lock may have been reclaimed by another process. Never delete
        // a lock directory that now belongs to a different owner token.
        const owner = path.join(p, 'owner');
        if (exists(owner) && readText(owner).trim() !== token) return;
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

export function withLock<T>(
  root: string,
  name: string,
  fn: () => T,
  opts: { timeoutMs?: number } = {},
): T {
  const deadline = Date.now() + (opts.timeoutMs ?? 3_000);
  let lock = acquireLock(root, name);
  while (!lock) {
    if (Date.now() >= deadline) {
      throw new Error(`无法获取锁 ${name}；可能有另一个进程正在写状态`);
    }
    sleepSync(50);
    lock = acquireLock(root, name);
  }
  try {
    return fn();
  } finally {
    lock.release();
  }
}

/** Synchronous sleep without busy-spinning the event loop. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/* ------------------------------- approvals ------------------------------ */

export interface Approval {
  id: string;
  repo: string;
  milestone?: string;
  tree_hash: string;
  staged_hash?: string;
  message: string;
  files: string[];
  created_at: string;
  approved_at?: string;
  approved_by?: string;
  used_at?: string;
  /** Set when a newer commit_request replaced this pending approval. */
  superseded_at?: string;
  superseded_by?: string;
  reason?: string;
}

const APPROVAL_ID_RE = /^ap-[A-Za-z0-9-]+$/;

export function createApproval(root: string, a: Omit<Approval, 'id' | 'created_at'>): Approval {
  const id = `ap-${slugDate()}-${Math.random().toString(36).slice(2, 6)}`;
  const rec: Approval = { ...a, id, created_at: isoNow() };
  const p = path.join(approvalsDir(root), `${id}.json`);
  ensureDir(path.dirname(p));
  writeAtomic(p, JSON.stringify(rec, null, 2));
  return rec;
}

export function readApproval(root: string, id: string): Approval | null {
  if (!APPROVAL_ID_RE.test(id)) return null;
  const p = path.join(approvalsDir(root), `${id}.json`);
  if (!exists(p)) return null;
  try {
    const rec = JSON.parse(readText(p)) as Approval;
    if (!rec || rec.id !== id || !APPROVAL_ID_RE.test(rec.id)) return null;
    return rec;
  } catch {
    return null;
  }
}

export function writeApproval(root: string, a: Approval): void {
  if (!APPROVAL_ID_RE.test(a.id)) throw new Error(`非法审批 id: ${a.id}`);
  const p = path.join(approvalsDir(root), `${a.id}.json`);
  writeAtomic(p, JSON.stringify(a, null, 2));
}

/**
 * Retire older pending approvals for a repo when a new commit_request is made.
 * Without this an old request that was never committed keeps resurfacing as a
 * stale "pending" row.
 */
export function supersedeApprovals(root: string, repo: string, keepId: string): number {
  let n = 0;
  for (const old of listApprovals(root)) {
    if (old.id === keepId || old.repo !== repo || old.used_at || old.superseded_at) continue;
    old.superseded_at = isoNow();
    old.superseded_by = keepId;
    writeApproval(root, old);
    n++;
  }
  return n;
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
