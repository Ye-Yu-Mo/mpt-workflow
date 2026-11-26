import crypto from 'node:crypto';
import path from 'node:path';
import { runtimeDir } from './config.js';
import { ensureDir, exists, readText, writeAtomic } from './fsutil.js';
import type { Role } from './types.js';

export interface RoleLease {
  role: Role;
  repo?: string;
  at: string;
  /** Raw session key (Claude Code session id, WF_SESSION, or a generated MCP key). */
  session?: string;
  /** Owner process (diagnostics only). */
  pid?: number;
  source?: 'env' | 'file' | 'legacy';
}

/**
 * Resolve the session key. Precedence: explicit argument (hook input) >
 * WF_SESSION > CLAUDE_CODE_SESSION_ID (set by Claude Code for MCP servers and
 * hooks). There is deliberately no machine-wide fallback.
 */
export function resolveSessionKey(explicit?: string): string | undefined {
  const raw =
    explicit?.trim() ||
    process.env.WF_SESSION?.trim() ||
    process.env.CLAUDE_CODE_SESSION_ID?.trim();
  return raw || undefined;
}

/**
 * MCP servers may be launched outside Claude Code. Give that process a stable
 * key for its lifetime instead of writing a global lease.
 */
export function ensureSessionKey(): string {
  const existing = resolveSessionKey();
  if (existing) return existing;
  const generated = `mcp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  process.env.WF_SESSION = generated;
  return generated;
}

/** Hashed filename so an arbitrary WF_SESSION cannot escape runtime/sessions. */
export function sessionLeasePath(root: string, key: string): string {
  const name = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return path.join(runtimeDir(root), 'sessions', `${name}.json`);
}

/** Legacy machine-wide lease from 0.x/1.0.0; kept only for diagnostics. */
export function legacyLeasePath(root: string): string {
  return path.join(runtimeDir(root), 'role.json');
}

export function setRoleLease(
  root: string,
  lease: Omit<RoleLease, 'at' | 'session' | 'source'> & { at?: string },
  explicit?: string,
): RoleLease {
  const key = resolveSessionKey(explicit);
  if (!key) {
    throw new Error(
      '没有会话 id：请在 Claude Code 会话内调用 bootstrap，或设置 WF_SESSION / WF_ROLE+WF_REPO',
    );
  }
  const record: RoleLease = {
    ...lease,
    at: lease.at ?? new Date().toISOString(),
    session: key,
    pid: process.pid,
  };
  const p = sessionLeasePath(root, key);
  ensureDir(path.dirname(p));
  writeAtomic(p, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function readRoleLease(root: string, explicit?: string): RoleLease | null {
  const envRole = process.env.WF_ROLE as Role | undefined;
  const envRepo = process.env.WF_REPO;
  // An explicit key (hook input) is authoritative: never fall back to a
  // different environment session, or one hook could read another's role.
  const keys = explicit?.trim()
    ? [explicit.trim()]
    : [
        ...new Set([process.env.WF_SESSION?.trim(), process.env.CLAUDE_CODE_SESSION_ID?.trim()]),
      ].filter((k): k is string => Boolean(k));

  if (envRole) {
    return {
      role: envRole,
      repo: envRepo,
      at: new Date().toISOString(),
      session: keys[0],
      source: 'env',
    };
  }
  for (const key of keys) {
    const p = sessionLeasePath(root, key);
    if (!exists(p)) continue;
    try {
      const lease = JSON.parse(readText(p)) as RoleLease;
      return { ...lease, session: key, source: 'file' };
    } catch {
      /* try the next candidate session key */
    }
  }
  // Migration compatibility: an old global lease is still readable, with a
  // warning from the hooks. It is never written anymore.
  const legacy = legacyLeasePath(root);
  if (exists(legacy)) {
    try {
      const lease = JSON.parse(readText(legacy)) as RoleLease;
      return { ...lease, source: 'legacy' };
    } catch {
      /* ignore a corrupt legacy file */
    }
  }
  return null;
}

/** Human label for status: `plan@repo-a（abcd1234）` or `未声明`. */
export function sessionLabel(lease: RoleLease | null, width = 8): string {
  if (!lease) return '未声明（bootstrap 或 WF_ROLE）';
  const id = lease.session ? lease.session.slice(0, width) : 'env';
  return `${lease.role}${lease.repo ? `@${lease.repo}` : ''}（${id}）`;
}
