import fs from 'node:fs';
import path from 'node:path';
import { approvalsDir, eventsPath, evidenceDir, locksDir, runtimeDir } from './config.js';
import { exists } from './fsutil.js';

export interface GcOptions {
  /** Processed messages/approvals older than this are eligible. Default 30. */
  olderThanDays?: number;
  /** Delete evidence logs older than this many days. 0 keeps all evidence. */
  evidenceDays?: number;
  /** Without this, only report what would be removed. */
  apply?: boolean;
}

export interface GcGroup {
  removable: string[];
  bytes: number;
}

export interface GcReport {
  root: string;
  cutoff: string;
  apply: boolean;
  runtimeBytesBefore: number;
  runtimeBytesAfter: number;
  messages: GcGroup & { total: number };
  approvals: GcGroup & { total: number };
  presence: GcGroup;
  locks: GcGroup;
  evidence: GcGroup & { files: number; removableBytes: number };
  events: { bytes: number };
  failed: string[];
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function dirSize(dir: string): number {
  if (!exists(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    try {
      const st = fs.lstatSync(p);
      if (st.isDirectory()) total += dirSize(p);
      else if (st.isFile()) total += st.size;
    } catch {
      /* ignore unreadable entries */
    }
  }
  return total;
}

function walkFiles(dir: string): string[] {
  if (!exists(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

function fileSize(p: string): number {
  try {
    const st = fs.statSync(p);
    return st.isDirectory() ? dirSize(p) : st.size;
  } catch {
    return 0;
  }
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

function olderThan(ts: string | undefined, cutoffMs: number): boolean {
  if (!ts) return false;
  const t = new Date(ts).getTime();
  return Number.isFinite(t) && t < cutoffMs;
}

/**
 * Reclaim runtime space. The default call is a dry run; `apply: true` deletes
 * processed messages/approvals and stale presence/lock entries. Evidence logs
 * are only touched when `evidenceDays > 0`, because the TODO keeps only a
 * truncated tail.
 */
export function runGc(root: string, opts: GcOptions = {}): GcReport {
  const days = opts.olderThanDays ?? 30;
  const evidenceDays = opts.evidenceDays ?? 0;
  const apply = Boolean(opts.apply);
  const now = Date.now();
  const cutoffMs = now - Math.max(0, days) * 86_400_000;
  const cutoff = new Date(cutoffMs).toISOString();
  const runtime = runtimeDir(root);

  const before = dirSize(runtime);
  const messages: GcReport['messages'] = { total: 0, removable: [], bytes: 0 };
  const approvals: GcReport['approvals'] = { total: 0, removable: [], bytes: 0 };
  const presence: GcGroup = { removable: [], bytes: 0 };
  const locks: GcGroup = { removable: [], bytes: 0 };
  const evidence: GcReport['evidence'] = { files: 0, removable: [], bytes: 0, removableBytes: 0 };

  const msgDir = path.join(runtime, 'messages');
  if (exists(msgDir)) {
    for (const name of fs.readdirSync(msgDir)) {
      if (!name.endsWith('.json')) continue;
      const p = path.join(msgDir, name);
      const m = readJson<{
        status?: string;
        created_at?: string;
        acked_at?: string;
        expires_at?: string;
      }>(p);
      if (!m) continue;
      messages.total++;
      const ts =
        m.status === 'acked'
          ? m.acked_at || m.created_at
          : m.status === 'expired'
            ? m.expires_at || m.created_at
            : undefined;
      if (olderThan(ts, cutoffMs)) {
        messages.removable.push(p);
        messages.bytes += fileSize(p);
      }
    }
  }

  const apDir = approvalsDir(root);
  if (exists(apDir)) {
    for (const name of fs.readdirSync(apDir)) {
      if (!name.endsWith('.json')) continue;
      const p = path.join(apDir, name);
      const a = readJson<{ used_at?: string; created_at?: string }>(p);
      if (!a) continue;
      approvals.total++;
      if (olderThan(a.used_at, cutoffMs)) {
        approvals.removable.push(p);
        approvals.bytes += fileSize(p);
      }
    }
  }

  // Presence is ephemeral: anything older than a day is safe to drop.
  const presenceDir = path.join(msgDir, 'presence');
  if (exists(presenceDir)) {
    for (const name of fs.readdirSync(presenceDir)) {
      if (!name.endsWith('.json')) continue;
      const p = path.join(presenceDir, name);
      const d = readJson<{ last_seen?: string }>(p);
      if (d && olderThan(d.last_seen, now - 86_400_000)) {
        presence.removable.push(p);
        presence.bytes += fileSize(p);
      }
    }
  }

  // A lock held for over an hour is stale; active locks are short-lived.
  const lockDir = locksDir(root);
  if (exists(lockDir)) {
    for (const name of fs.readdirSync(lockDir)) {
      if (!name.endsWith('.lock')) continue;
      const p = path.join(lockDir, name);
      try {
        if (fs.statSync(p).mtimeMs < now - 3_600_000) {
          locks.removable.push(p);
          locks.bytes += fileSize(p);
        }
      } catch {
        /* ignore */
      }
    }
  }

  const evDir = evidenceDir(root);
  const evidenceFiles = walkFiles(evDir);
  evidence.files = evidenceFiles.length;
  for (const p of evidenceFiles) {
    const size = fileSize(p);
    evidence.bytes += size;
    if (evidenceDays > 0) {
      try {
        if (fs.statSync(p).mtimeMs < now - evidenceDays * 86_400_000) {
          evidence.removable.push(p);
          evidence.removableBytes += size;
        }
      } catch {
        /* ignore */
      }
    }
  }

  const failed: string[] = [];
  if (apply) {
    for (const p of [
      ...messages.removable,
      ...approvals.removable,
      ...presence.removable,
      ...locks.removable,
      ...evidence.removable,
    ]) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch (e) {
        failed.push(`${p}: ${(e as Error).message}`);
      }
    }
  }

  return {
    root,
    cutoff,
    apply,
    runtimeBytesBefore: before,
    runtimeBytesAfter: apply ? dirSize(runtime) : before,
    messages,
    approvals,
    presence,
    locks,
    evidence,
    events: { bytes: exists(eventsPath(root)) ? fileSize(eventsPath(root)) : 0 },
    failed,
  };
}

export function formatGcReport(r: GcReport): string {
  const lines = [
    `GC ${r.apply ? '已执行' : 'dry-run（加 --apply 执行删除）'}`,
    `截止时间: ${r.cutoff}`,
    `runtime: ${formatBytes(r.runtimeBytesBefore)}${r.apply ? ` -> ${formatBytes(r.runtimeBytesAfter)}` : ''}`,
    `消息: ${r.messages.removable.length}/${r.messages.total} 个可删除 (${formatBytes(r.messages.bytes)})`,
    `审批: ${r.approvals.removable.length}/${r.approvals.total} 个可删除 (${formatBytes(r.approvals.bytes)})`,
    `在线状态: ${r.presence.removable.length} 个 (${formatBytes(r.presence.bytes)})`,
    `锁: ${r.locks.removable.length} 个 (${formatBytes(r.locks.bytes)})`,
    `证据: ${r.evidence.files} 个文件, ${formatBytes(r.evidence.bytes)}` +
      (r.evidence.removable.length
        ? `；可删除 ${r.evidence.removable.length} 个 (${formatBytes(r.evidence.removableBytes)})`
        : ''),
    `事件日志: ${formatBytes(r.events.bytes)}（不自动清理）`,
    '',
    r.failed.length ? `删除失败 ${r.failed.length} 个：\n  ${r.failed.join('\n  ')}` : '',
    r.apply
      ? r.failed.length
        ? '部分文件删除失败；见上方列表。'
        : '已删除符合条件的文件。'
      : '未删除任何文件。确认无误后加 --apply。',
    '注意：证据默认保留；只有显式传 --evidence-days N 才会删除旧证据。',
  ].filter((line) => line !== '');
  return lines.join('\n');
}
