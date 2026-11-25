import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir,
  exists,
  readText,
  writeAtomic,
  appendLine,
  isoNow,
  truncate,
} from './fsutil.js';
import { runtimeDir } from './config.js';
import type { Role } from './types.js';

export type MsgRole = Role | 'system';

export interface Actor {
  role: MsgRole;
  repo?: string;
}

export type MessageKind =
  | 'question'
  | 'answer'
  | 'event'
  | 'handoff'
  | 'alert'
  | 'approval_request';

export type MessageStatus = 'queued' | 'unread' | 'read' | 'acked' | 'expired' | 'failed';

export interface Message {
  id: string;
  project: string;
  repo?: string;
  from: Actor;
  to: Actor;
  kind: MessageKind;
  subject: string;
  body: string;
  refs: Record<string, string | string[]>;
  blocking: boolean;
  status: MessageStatus;
  created_at: string;
  read_at?: string;
  acked_at?: string;
  ack_note?: string;
  expires_at?: string;
  escalated_at?: string;
  correlation_id?: string;
  idempotency_key?: string;
  /** system-generated workflow events bypass the human-facing send ACL */
  auto?: boolean;
}

export interface SendInput {
  from: Actor;
  to: Actor;
  kind: MessageKind;
  subject: string;
  body?: string;
  refs?: Record<string, string | string[]>;
  blocking?: boolean;
  expires_at?: string;
  correlation_id?: string;
  idempotency_key?: string;
  repo?: string;
  /** internal: workflow-emitted events skip ACL (still validated for idempotency) */
  auto?: boolean;
}

const MAX_BODY = 32 * 1024;
const PRESENCE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_BLOCKING_TTL_MIN = 45;

export function actorKey(a: Actor): string {
  if (a.role === 'main' || a.role === 'user' || a.role === 'system') return a.role;
  return a.repo ? `${a.role}@${a.repo}` : a.role;
}

export function parseActor(s: string): Actor {
  const [role, repo] = s.split('@');
  return { role: role as MsgRole, repo: repo || undefined };
}

/** Map a question's `from`/`to` label onto an addressable actor. */
export function actorFromRole(label: string, repo?: string): Actor {
  const r = String(label).toLowerCase();
  if (r === 'plan' || r === 'todo') return { role: r, repo };
  if (r === 'user') return { role: 'user' };
  if (r === 'system') return { role: 'system' };
  return { role: 'main' };
}

export function sameActor(a: Actor, b: Actor): boolean {
  return actorKey(a) === actorKey(b);
}

/* --------------------------------- ACL --------------------------------- */

export function canSend(
  from: Actor,
  to: Actor,
  kind: MessageKind,
): { ok: boolean; reason?: string } {
  if (from.role === 'system' || from.role === 'user' || from.role === 'main') {
    return { ok: true };
  }
  if (from.role === 'plan') {
    if (to.role === 'main') return { ok: true };
    if (to.role === 'todo' && to.repo === from.repo) return { ok: true };
    if (to.role === 'user' && kind === 'alert') return { ok: true };
    return {
      ok: false,
      reason: `plan@${from.repo ?? '?'} 只能发给 main、todo@同仓 或 user(alert)`,
    };
  }
  if (from.role === 'todo') {
    if (to.role === 'plan' && to.repo === from.repo) return { ok: true };
    if (to.role === 'main' && kind === 'alert') return { ok: true };
    return {
      ok: false,
      reason: `todo@${from.repo ?? '?'} 只能发给 plan@同仓 或 main(alert)`,
    };
  }
  return { ok: false, reason: `未知发送方 ${from.role}` };
}

/* ------------------------------- storage -------------------------------- */

export interface MessageStoreOptions {
  root: string;
  project: string;
  repos: string[];
}

export class MessageStore {
  root: string;
  project: string;
  repos: string[];
  dir: string;
  auditFile: string;

  constructor(opts: MessageStoreOptions) {
    this.root = opts.root;
    this.project = opts.project;
    this.repos = opts.repos;
    this.dir = path.join(runtimeDir(this.root), 'messages');
    this.auditFile = path.join(this.dir, 'audit.jsonl');
    ensureDir(this.dir);
    ensureDir(path.join(this.dir, 'presence'));
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private audit(entry: Record<string, unknown>): void {
    try {
      appendLine(this.auditFile, JSON.stringify({ ts: isoNow(), ...entry }));
    } catch {
      /* audit must never break the workflow */
    }
  }

  list(): Message[] {
    const out: Message[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return out;
    }
    for (const n of names) {
      try {
        const m = JSON.parse(readText(path.join(this.dir, n))) as Message;
        if (m && m.id) out.push(m);
      } catch {
        /* skip corrupt messages */
      }
    }
    return out;
  }

  get(id: string): Message | null {
    const p = this.file(id);
    if (!exists(p)) return null;
    try {
      return JSON.parse(readText(p)) as Message;
    } catch {
      return null;
    }
  }

  private save(m: Message): void {
    writeAtomic(this.file(m.id), JSON.stringify(m, null, 2));
  }

  findByKey(key: string): Message | null {
    if (!key) return null;
    return this.list().find((m) => m.idempotency_key === key) || null;
  }

  /* ----------------------------- presence ------------------------------ */

  ping(a: Actor, session?: string): void {
    const p = path.join(this.dir, 'presence', `${encodeURIComponent(actorKey(a))}.json`);
    writeAtomic(
      p,
      JSON.stringify({ actor: a, session: session || null, last_seen: isoNow() }, null, 2),
    );
  }

  presence(): { actor: Actor; session: string | null; last_seen: string; online: boolean }[] {
    const dir = path.join(this.dir, 'presence');
    if (!exists(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => {
        try {
          const d = JSON.parse(readText(path.join(dir, n))) as {
            actor: Actor;
            session: string | null;
            last_seen: string;
          };
          return {
            ...d,
            online: Date.now() - new Date(d.last_seen).getTime() < PRESENCE_TTL_MS,
          };
        } catch {
          return null;
        }
      })
      .filter((x): x is { actor: Actor; session: string | null; last_seen: string; online: boolean } => !!x);
  }

  isOnline(a: Actor): boolean {
    return this.presence().some((p) => sameActor(p.actor, a) && p.online);
  }

  /* ------------------------------ sending ------------------------------ */

  send(input: SendInput): { message: Message; duplicate: boolean } {
    const body = input.body || '';
    if (body.length > MAX_BODY) {
      throw new Error(`消息体 ${body.length} 字节，超过 32KB；大段内容请放 evidence 文件并只引用路径`);
    }

    if (input.idempotency_key) {
      const existing = this.findByKey(input.idempotency_key);
      if (existing) return { message: existing, duplicate: true };
    }

    if (!input.auto) {
      const acl = canSend(input.from, input.to, input.kind);
      if (!acl.ok) throw new Error(`消息 ACL 拒绝：${acl.reason}`);
    }

    const now = new Date();
    const id = `msg-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(
      now.getTime(),
    ).slice(-6)}-${Math.random().toString(36).slice(2, 6)}`;

    const expires =
      input.expires_at ||
      (input.blocking
        ? new Date(now.getTime() + DEFAULT_BLOCKING_TTL_MIN * 60_000).toISOString()
        : undefined);

    const msg: Message = {
      id,
      project: this.project,
      repo: input.repo ?? input.to.repo ?? input.from.repo,
      from: input.from,
      to: input.to,
      kind: input.kind,
      subject: input.subject,
      body,
      refs: input.refs || {},
      blocking: Boolean(input.blocking),
      status: this.isOnline(input.to) ? 'unread' : 'queued',
      created_at: now.toISOString(),
      expires_at: expires,
      correlation_id: input.correlation_id,
      idempotency_key: input.idempotency_key,
      auto: input.auto,
    };
    this.save(msg);
    this.audit({ action: 'create', id: msg.id, from: actorKey(msg.from), to: actorKey(msg.to), kind: msg.kind });
    return { message: msg, duplicate: false };
  }

  /** Internal convenience: emit one message per recipient, ignoring ACL. */
  emit(
    input: Omit<SendInput, 'to' | 'auto' | 'idempotency_key'> & {
      to: Actor[];
      idempotencyBase?: string;
    },
  ): Message[] {
    const out: Message[] = [];
    for (const to of input.to) {
      const key = input.idempotencyBase
        ? `${input.idempotencyBase}:${actorKey(to)}`
        : undefined;
      const { message } = this.send({ ...input, to, auto: true, idempotency_key: key });
      out.push(message);
    }
    return out;
  }

  /* ---------------------------- transitions ---------------------------- */

  private transition(id: string, patch: Partial<Message>, audit: Record<string, unknown>): Message | null {
    const m = this.get(id);
    if (!m) return null;
    Object.assign(m, patch);
    this.save(m);
    this.audit({ ...audit, id });
    return m;
  }

  promoteQueued(a: Actor): void {
    for (const m of this.list()) {
      if (m.status === 'queued' && sameActor(m.to, a)) {
        this.transition(m.id, { status: 'unread' }, { action: 'deliver' });
      }
    }
  }

  markRead(id: string): Message | null {
    const m = this.get(id);
    if (!m) return null;
    if (m.status === 'unread' || m.status === 'queued') {
      return this.transition(
        id,
        { status: 'read', read_at: isoNow() },
        { action: 'read' },
      );
    }
    return m;
  }

  ack(id: string, note?: string): Message | null {
    const m = this.get(id);
    if (!m) return null;
    const at = isoNow();
    const patch: Partial<Message> = { status: 'acked', acked_at: at, ack_note: note };
    // Ack implies read: never leave a message "handled" but with no read_at.
    if (!m.read_at) patch.read_at = at;
    return this.transition(id, patch, { action: 'ack', note });
  }

  ackByRef(actor: Actor, refName: string, refValue: string): number {
    let n = 0;
    for (const m of this.list()) {
      if (
        m.status !== 'acked' &&
        sameActor(m.to, actor) &&
        String(m.refs[refName] || '') === refValue
      ) {
        this.ack(m.id);
        n++;
      }
    }
    return n;
  }

  /* ------------------------------ queries ------------------------------ */

  forActor(
    a: Actor,
    opts: { unreadOnly?: boolean; kind?: MessageKind; limit?: number; includeAcked?: boolean } = {},
  ): Message[] {
    let list = this.list().filter((m) => sameActor(m.to, a));
    if (!opts.includeAcked) list = list.filter((m) => m.status !== 'acked');
    if (opts.unreadOnly) list = list.filter((m) => m.status === 'queued' || m.status === 'unread');
    if (opts.kind) list = list.filter((m) => m.kind === opts.kind);
    list.sort((x, y) => y.created_at.localeCompare(x.created_at));
    return opts.limit ? list.slice(0, opts.limit) : list;
  }

  unreadCount(a: Actor): number {
    return this.list().filter(
      (m) => sameActor(m.to, a) && (m.status === 'queued' || m.status === 'unread'),
    ).length;
  }

  blockingFor(a: Actor): Message[] {
    return this.list()
      .filter(
        (m) =>
          sameActor(m.to, a) &&
          m.blocking &&
          ['queued', 'unread', 'read'].includes(m.status),
      )
      .sort((x, y) => x.created_at.localeCompare(y.created_at));
  }

  allBlocking(): Message[] {
    return this.list().filter(
      (m) => m.blocking && ['queued', 'unread', 'read'].includes(m.status),
    );
  }

  /* ------------------------------ expiry ------------------------------- */

  expireDue(): Message[] {
    const now = Date.now();
    const expired: Message[] = [];
    for (const m of this.list()) {
      if (!m.expires_at) continue;
      if (['acked', 'expired', 'failed'].includes(m.status)) continue;
      if (new Date(m.expires_at).getTime() > now) continue;
      const updated = this.transition(
        m.id,
        { status: 'expired', escalated_at: isoNow() },
        { action: 'expire' },
      );
      if (updated) {
        expired.push(updated);
        if (updated.blocking) {
          this.send({
            from: { role: 'system' },
            to: { role: 'user' },
            kind: 'alert',
            subject: `消息超时未处理：${updated.subject}`,
            body: `${updated.id}（${actorKey(updated.from)} → ${actorKey(updated.to)}）已过期。请人工介入。`,
            refs: { message_id: updated.id, milestone: String(updated.refs.milestone || '') },
            blocking: false,
            auto: true,
            idempotency_key: `escalate:${updated.id}`,
          });
          this.send({
            from: { role: 'system' },
            to: { role: 'main' },
            kind: 'alert',
            subject: `消息超时未处理：${updated.subject}`,
            body: `${updated.id}（${actorKey(updated.from)} → ${actorKey(updated.to)}）已过期。`,
            refs: { message_id: updated.id },
            blocking: false,
            auto: true,
            idempotency_key: `escalate-main:${updated.id}`,
          });
        }
      }
    }
    return expired;
  }

  escalate(id: string, reason: string, by: Actor): Message | null {
    const m = this.get(id);
    if (!m) return null;
    const { message } = this.send({
      from: { role: 'system' },
      to: { role: 'user' },
      kind: 'alert',
      subject: `升级：${m.subject}`,
      body: `${reason}\n\n原消息 ${m.id}（${actorKey(m.from)} → ${actorKey(m.to)}）\n${truncate(m.body, 800)}`,
      refs: { message_id: m.id, escalated_by: actorKey(by) },
      auto: true,
      idempotency_key: `escalate:${m.id}:${Math.floor(Date.now() / 60000)}`,
    });
    this.transition(m.id, { escalated_at: isoNow() }, { action: 'escalate', by: actorKey(by) });
    return message;
  }

  markExpired(id: string): Message | null {
    return this.transition(id, { status: 'expired' }, { action: 'expire-manual' });
  }
}

export function formatMessage(m: Message, opts: { full?: boolean } = {}): string {
  const head = `${m.id} [${m.status}]${m.blocking ? ' [blocking]' : ''} ${m.kind}  ${actorKey(
    m.from,
  )} → ${actorKey(m.to)}`;
  const lines = [head, `  ${m.subject}`, `  ${m.created_at}`];
  if (m.body) {
    const body = opts.full ? m.body : truncate(m.body, 400);
    lines.push(...body.split('\n').map((l) => '  ' + l));
  }
  const refs = Object.entries(m.refs).filter(([, v]) => (Array.isArray(v) ? v.length : v));
  if (refs.length) {
    lines.push('  refs: ' + refs.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join(' '));
  }
  if (m.expires_at) lines.push(`  expires: ${m.expires_at}`);
  if (m.ack_note) lines.push(`  ack: ${m.ack_note}`);
  return lines.join('\n');
}
