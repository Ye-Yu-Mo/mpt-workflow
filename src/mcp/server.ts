import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Workflow } from '../core/workflow.js';
import { describeAcl } from '../core/acl.js';
import { loadConfig } from '../core/config.js';
import { setRoleLease } from '../core/hooks.js';
import { questionsFile, appendQuestion, updateQuestion, nextQuestionId } from '../core/questions.js';
import { logEvent } from '../core/state.js';
import { readText, writeAtomic } from '../core/fsutil.js';
import { actorKey, formatMessage, canSend, type Actor, type MessageKind } from '../core/messages.js';
import path from 'node:path';
import type { Role } from '../core/types.js';

type ToolReturn =
  | string
  | { content: { type: 'text'; text: string }[]; isError: boolean };

interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  roles: Role[];
  handler: (args: Record<string, unknown>, ctx: Ctx) => Promise<ToolReturn> | ToolReturn;
}

interface Ctx {
  wf: Workflow;
  role: Role;
  repo: string | null;
}

export interface ServerOptions {
  root: string;
  role?: Role;
  repo?: string;
}

const READ_ROLES: Role[] = ['main', 'plan', 'todo', 'user'];

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

function err(s: string) {
  return { content: [{ type: 'text' as const, text: s }], isError: true };
}

function statusText(wf: Workflow, role: Role | null, repo: string | null): string {
  const st = wf.programStatus();
  const lines: string[] = [];
  const me: Actor | null = role ? { role, repo: repo ?? undefined } : null;
  const unread = me ? wf.msgs.unreadCount(me) : 0;
  const blocking = me ? wf.msgs.blockingFor(me) : [];
  if (me && (unread || blocking.length)) {
    lines.push(`未读 ${unread} 条${blocking.length ? ` · blocking ${blocking.length} 条` : ''}（用 inbox 查看）`);
    for (const m of blocking) {
      lines.push(`  [blocking] ${m.id} ${m.subject}`);
    }
    lines.push('');
  }
  lines.push(`程序: ${st.program}`);
  lines.push(`根目录: ${st.root}`);
  lines.push(`active repo: ${st.activeRepo ?? '(none)'}`);
  if (role) lines.push(`本会话角色: ${role}${repo ? ` (绑定 ${repo})` : ''}`);
  lines.push('');
  for (const p of st.phases) {
    lines.push(`阶段 ${p.id}「${p.title}」 = ${p.status}  [${p.repos.join(', ')}]`);
  }
  lines.push('');
  lines.push('仓库:');
  for (const r of st.repos) {
    const m = r.currentMilestone;
    const done = r.milestones.filter((x) => ['accepted', 'committed'].includes(x.status)).length;
    lines.push(
      `  ${r.id}  ${done}/${r.milestones.length} M` +
        (m
          ? `  当前 ${m.id}「${m.title}」= ${m.status}` +
            (m.evidence.length ? ` (证据 ${m.evidence.length})` : '')
          : r.milestones.length === 0
            ? '  无 M（缺 PLAN）'
            : '  全部完成') +
        `  [${r.git.branch}@${r.git.shortHead}${r.git.dirty ? ', dirty' : ''}]`,
    );
    for (const mm of r.milestones) {
      lines.push(`      ${mm.id} ${mm.status.padEnd(12)} ${mm.title}`);
    }
  }
  const qs = st.questions;
  const open = qs.filter((q) => q.status === 'open' || q.status === 'answered');
  if (open.length) {
    lines.push('');
    lines.push('未闭合问题:');
    for (const q of open) {
      lines.push(
        `  ${q.id} [${q.status}]${q.blocking ? ' [blocking]' : ''} ${q.from} → ${q.to}: ${q.context.split('\n')[0].slice(0, 100)}`,
      );
    }
  }
  if (st.next.length) {
    lines.push('');
    lines.push('建议下一步:');
    for (const n of st.next) {
      lines.push(
        `  [${n.actor}] ${n.action}${n.repo ? ` (${n.repo}${n.milestone ? '/' + n.milestone : ''})` : ''}`,
      );
      lines.push(`      ${n.detail}`);
    }
  }
  return lines.join('\n');
}

/* --------------------------------------------------------------------- */

function buildTools(opts: ServerOptions): ToolSpec[] {
  const repoParam = z.string().optional().describe('仓库 id；默认用绑定仓或 active repo');
  const msParam = z.string().describe('里程碑编号，如 M2');

  const tools: ToolSpec[] = [
    {
      name: 'bootstrap',
      description:
        '声明本会话的 agent 角色并取得权限矩阵、当前状态和建议下一步。开始工作前先调用一次。',
      roles: READ_ROLES,
      schema: {
        role: z.enum(['main', 'plan', 'todo', 'user']).describe('本会话角色'),
        repo: z.string().optional().describe('绑定的仓库 id（plan/todo 必填）'),
      },
      handler: async (args, ctx) => {
        const role = args.role as Role;
        const repo = (args.repo as string | undefined) || ctx.repo || null;
        if ((role === 'plan' || role === 'todo') && !repo) {
          return err(`角色 ${role} 必须指定 repo`);
        }
        if (repo) ctx.wf.repoRef(repo);
        setRoleLease(ctx.wf.root, { role, repo: repo ?? undefined, at: new Date().toISOString() });
        ctx.role = role;
        ctx.repo = repo;
        const me: Actor = { role, repo: repo ?? undefined };
        ctx.wf.msgs.ping(me);
        ctx.wf.msgs.promoteQueued(me);
        ctx.wf.msgs.expireDue();
        const unread = ctx.wf.msgs.unreadCount(me);
        const blocking = ctx.wf.msgs.blockingFor(me);
        const recent = ctx.wf.msgs.forActor(me, { limit: 3 });
        logEvent(ctx.wf.root, { role, tool: 'bootstrap', repo: repo ?? undefined, ok: true });
        return [
          `已绑定角色 ${role}${repo ? ` @ ${repo}` : ''}。`,
          '',
          describeAcl(role),
          '',
          unread
            ? `未读 ${unread} 条${blocking.length ? `（blocking ${blocking.length}）` : ''}：`
            : '没有未读消息。',
          ...blocking.map((m) => `  [blocking] ${m.id} ${m.subject}`),
          ...(unread ? recent.map((m) => `  ${m.id} [${m.status}] ${m.subject}`) : []),
          '',
          '下一步：status 看全局，next 看该做什么，inbox 看消息。',
        ].join('\n');
      },
    },
    {
      name: 'status',
      description: '返回程序/仓库/里程碑/问题/下一步的完整状态。新会话第一件事。',
      roles: READ_ROLES,
      schema: {
        repo: z.string().optional().describe('只看某个仓库'),
      },
      handler: (args, ctx) => {
        const repo = args.repo as string | undefined;
        if (!repo) return statusText(ctx.wf, ctx.role, ctx.repo);
        const st = ctx.wf.repoState(repo);
        const lines = [
          `${st.id}  [${st.git.branch}@${st.git.shortHead}${st.git.dirty ? ', dirty' : ''}]`,
          `PLAN: ${st.plan?.file ?? '(none)'}  阶段: ${st.phase ?? '?'}`,
          '',
          '里程碑:',
          ...st.milestones.map(
            (m) =>
              `  ${m.id} ${m.status.padEnd(12)} ${m.title}` +
              (m.evidence.length ? `  证据=${m.evidence.length}` : '') +
              (m.sha ? `  sha=${m.sha}` : ''),
          ),
        ];
        if (st.questions.length) {
          lines.push('', '问题:');
          for (const q of st.questions) {
            lines.push(`  ${q.id} [${q.status}] ${q.from} → ${q.to}${q.blocking ? ' [blocking]' : ''}`);
          }
        }
        if (st.problems.length) lines.push('', '注意:', ...st.problems.map((p) => `  ! ${p}`));
        return lines.join('\n');
      },
    },
    {
      name: 'next',
      description: '根据状态机计算下一步该谁做什么，附理由。',
      roles: READ_ROLES,
      schema: {},
      handler: (_a, ctx) => {
        const me: Actor = { role: ctx.role, repo: ctx.repo ?? undefined };
        const blocking = ctx.wf.msgs.blockingFor(me);
        const st = ctx.wf.programStatus();
        const lines: string[] = [];
        if (blocking.length) {
          lines.push('先处理 blocking 消息（ack 后才能推进）：');
          for (const m of blocking) lines.push(`  ${m.id}  ${m.subject}`);
          lines.push('');
        }
        if (!st.next.length) {
          lines.push('没有识别到待办；检查程序配置。');
          return lines.join('\n');
        }
        lines.push(
          st.next
            .map(
              (n) =>
                `[${n.actor}] ${n.action}${n.repo ? ` — ${n.repo}${n.milestone ? '/' + n.milestone : ''}` : ''}\n    ${n.detail}`,
            )
            .join('\n'),
        );
        return lines.join('\n');
      },
    },
    {
      name: 'doctor',
      description: '检查环境、git 状态、缺文件、阻塞问题、待批准提交，给出 OK/WARN/FAIL。',
      roles: READ_ROLES,
      schema: {},
      handler: (_a, ctx) => {
        const findings = ctx.wf.doctor();
        const order = { FAIL: 0, WARN: 1, OK: 2 };
        findings.sort((a, b) => order[a.level] - order[b.level]);
        return findings
          .map(
            (f) =>
              `${f.level.padEnd(4)} ${f.code}${f.repo ? ` [${f.repo}]` : ''}: ${f.message}` +
              (f.hint ? `\n      → ${f.hint}` : ''),
          )
          .join('\n');
      },
    },
    {
      name: 'questions',
      description: '列出问题，可按 to/status/blocking 过滤。',
      roles: READ_ROLES,
      schema: {
        to: z.string().optional(),
        status: z.string().optional(),
        blocking: z.boolean().optional(),
        all: z.boolean().optional().describe('包含已关闭的问题'),
      },
      handler: (args, ctx) => {
        let qs = ctx.wf.allQuestions();
        if (args.to) qs = qs.filter((q) => q.to === args.to);
        if (args.status) qs = qs.filter((q) => q.status === args.status);
        if (args.blocking !== undefined) qs = qs.filter((q) => q.blocking === args.blocking);
        if (!args.all) qs = qs.filter((q) => q.status !== 'closed' && q.status !== 'canceled');
        if (!qs.length) return '没有匹配的问题。';
        return qs
          .map((q) => {
            const head = `${q.id} [${q.status}]${q.blocking ? ' [blocking]' : ''} ${q.from} → ${q.to}  (${q.repo ?? 'root'})`;
            const opts = q.options.length
              ? '\n  选项: ' + q.options.map((o) => `${o.id}) ${o.text}`).join(' | ')
              : '';
            const rec = q.recommendation ? `\n  建议: ${q.recommendation}` : '';
            const ans = q.answer ? `\n  回答: ${q.answer}` : '';
            return `${head}\n  背景: ${q.context.split('\n')[0].slice(0, 200)}${opts}${rec}${ans}`;
          })
          .join('\n\n');
      },
    },
    {
      name: 'ask',
      description: '创建问题并写入对应 docs/agent-questions.md。blocking=yes 时实现必须停。',
      roles: READ_ROLES,
      schema: {
        to: z.enum(['main', 'PLAN', 'user']).describe('问谁'),
        context: z.string().describe('为什么需要决定；相关文件/PLAN 条目'),
        blocking: z.boolean().default(false),
        blocking_note: z.string().optional(),
        options: z.array(z.string()).optional().describe('候选方案，每项形如 "A: ..."'),
        recommendation: z.string().optional(),
        repo: repoParam,
      },
      handler: (args, ctx) => {
        const to = String(args.to);
        const toUserFromMain = ctx.role === 'main' && to === 'user';
        const repoId = toUserFromMain
          ? (args.repo as string | undefined) || null
          : (args.repo as string) || ctx.repo || ctx.wf.cfg.active_repo;
        if (!toUserFromMain && !repoId) return err('需要指定 repo');
        if (repoId) ctx.wf.repoRef(repoId);
        const toActor: Actor =
          to === 'PLAN'
            ? { role: 'plan', repo: repoId || undefined }
            : to === 'main'
              ? { role: 'main' }
              : { role: 'user' };
        const acl = canSend(meActor(ctx), toActor, 'question');
        if (!acl.ok) return err(`不能向 ${actorKey(toActor)} 提问：${acl.reason}`);
        const file = toUserFromMain && !repoId
          ? path.join(ctx.wf.root, 'docs', 'agent-questions.md')
          : questionsFile(ctx.wf.repoRef(repoId as string).abs);
        const existing = ctx.wf.allQuestions();
        const id = nextQuestionId(existing);
        const rawOptions = (args.options as string[] | undefined) || [];
        const options = rawOptions.map((s, i) => {
          const m = /^([A-Za-z0-9]+)\s*[:：]\s*(.*)$/.exec(s);
          return m ? { id: m[1], text: m[2] } : { id: String.fromCharCode(65 + i), text: s };
        });
        appendQuestion(file, {
          id,
          to,
          from: ctx.role,
          blocking: Boolean(args.blocking),
          blockingNote: args.blocking_note as string | undefined,
          context: String(args.context),
          options,
          recommendation: args.recommendation as string | undefined,
        });
        logEvent(ctx.wf.root, {
          role: ctx.role,
          tool: 'question_ask',
          repo: repoId ?? undefined,
          question: id,
          ok: true,
          detail: { to, blocking: Boolean(args.blocking) },
        });
        // notify the addressee (best-effort; the question file stays the source of truth)
        try {
          const { message } = ctx.wf.msgs.send({
            from: meActor(ctx),
            to: toActor,
            kind: 'question',
            subject: `${id} ${String(args.context).split('\n')[0].slice(0, 90)}`,
            body: String(args.context),
            refs: { question_id: id, repo: repoId || '' },
            blocking: Boolean(args.blocking),
            repo: repoId ?? undefined,
            idempotency_key: `${ctx.wf.cfg.program}:q:${id}`,
          });
          ctx.wf.msgs.ping(meActor(ctx));
          return [
            `已创建 ${id} → ${to}（${path.relative(ctx.wf.root, file)}），已通知 ${actorKey(toActor)}（${message.id}）。`,
            Boolean(args.blocking) ? 'blocking: yes —— 现在停下等待回答，不要继续实现。' : '',
            '用户可以在看板里直接回答，或转发给对方 agent。',
          ]
            .filter(Boolean)
            .join('\n');
        } catch (e) {
          return [
            `已创建 ${id} → ${to}（${path.relative(ctx.wf.root, file)}）。`,
            `⚠️ 通知投递失败：${(e as Error).message}（消息未丢失，对方可用 inbox 查询）`,
          ].join('\n');
        }
      },
    },
    {
      name: 'answer',
      description: '回答一个问题（只有被问方可以）。写入 answer，并提示需要回写的 PLAN/TODO。',
      roles: READ_ROLES,
      schema: {
        id: z.string(),
        answer: z.string(),
        resolution: z.string().optional().describe('回写到 PLAN/TODO/decisions 的位置'),
      },
      handler: (args, ctx) => {
        const q = ctx.wf.findQuestion(String(args.id));
        if (!q) return err(`找不到问题 ${args.id}`);
        const to = String(q.to).toLowerCase();
        const allowed =
          ctx.role === 'user' ||
          (to === 'plan' && ctx.role === 'plan') ||
          (to === 'main' && ctx.role === 'main');
        if (!allowed) return err(`问题 ${q.id} 是问 ${q.to} 的，你不能回答`);
        if (q.status === 'closed') return err(`问题 ${q.id} 已关闭`);
        ctx.wf.answerQuestion(
          q,
          String(args.answer),
          args.resolution ? String(args.resolution) : undefined,
          meActor(ctx),
        );
        logEvent(ctx.wf.root, {
          role: ctx.role,
          tool: 'question_answer',
          question: q.id,
          repo: q.repo,
          ok: true,
        });
        return [
          `已回答 ${q.id}。`,
          '提醒：回答必须回写 PLAN/TODO/decisions，不能只留在问答文件里。',
          '提问方应用后再 close。',
        ].join('\n');
      },
    },
    {
      name: 'close',
      description: '关闭问题（提问方或用户），要求已写 resolution。',
      roles: READ_ROLES,
      schema: {
        id: z.string(),
        resolution: z.string().optional(),
      },
      handler: (args, ctx) => {
        const q = ctx.wf.findQuestion(String(args.id));
        if (!q) return err(`找不到问题 ${args.id}`);
        const isAsker = String(q.from).toLowerCase() === ctx.role;
        if (!isAsker && ctx.role !== 'user' && ctx.role !== 'main') {
          return err(`只有提问方（${q.from}）或用户/主 agent 能关闭 ${q.id}`);
        }
        if (!q.status.startsWith('answered') && !q.answer && ctx.role !== 'user' && ctx.role !== 'main') {
          return err(`${q.id} 还没有回答，不能关闭`);
        }
        ctx.wf.closeQuestion(
          q,
          args.resolution ? String(args.resolution) : q.resolution,
          meActor(ctx),
        );
        logEvent(ctx.wf.root, { role: ctx.role, tool: 'question_close', question: q.id, repo: q.repo, ok: true });
        return `已关闭 ${q.id}，已通知对方。记得确认 PLAN/TODO 已经反映结论。`;
      },
    },
    {
      name: 'send_message',
      description:
        '向另一个 agent 定向发送工作流消息（持久化、可查、可 ack）。受发送 ACL 限制。',
      roles: READ_ROLES,
      schema: {
        to: z.enum(['main', 'plan', 'todo', 'user']),
        to_repo: z.string().optional().describe('plan/todo 的仓库；默认自己的仓'),
        kind: z
          .enum(['question', 'answer', 'event', 'handoff', 'alert', 'approval_request'])
          .default('event'),
        subject: z.string(),
        body: z.string().optional(),
        refs: z.record(z.string(), z.string()).optional(),
        blocking: z.boolean().default(false),
        expires_at: z.string().optional(),
        idempotency_key: z.string().optional(),
      },
      handler: (args, ctx) => {
        const to = resolveActor(String(args.to), args.to_repo as string | undefined, ctx);
        const { message, duplicate } = ctx.wf.msgs.send({
          from: meActor(ctx),
          to,
          kind: args.kind as MessageKind,
          subject: String(args.subject),
          body: args.body ? String(args.body) : '',
          refs: (args.refs as Record<string, string>) || {},
          blocking: Boolean(args.blocking),
          expires_at: args.expires_at as string | undefined,
          idempotency_key: args.idempotency_key as string | undefined,
          repo: (args.to_repo as string) || ctx.repo || undefined,
        });
        ctx.wf.msgs.ping(meActor(ctx));
        return `${duplicate ? '已存在（幂等命中）' : '已发送'} ${message.id} → ${actorKey(to)} [${message.status}]`;
      },
    },
    {
      name: 'inbox',
      description:
        '列出消息。默认当前 actor；main/user 可查任意 role。会顺带把 queued 提升为 unread。',
      roles: READ_ROLES,
      schema: {
        role: z.enum(['main', 'plan', 'todo', 'user']).optional(),
        repo: z.string().optional(),
        unread_only: z.boolean().optional(),
        include_acked: z.boolean().optional(),
        kind: z
          .enum(['question', 'answer', 'event', 'handoff', 'alert', 'approval_request'])
          .optional(),
        limit: z.number().optional(),
      },
      handler: (args, ctx) => {
        const target = args.role
          ? resolveActor(String(args.role), args.repo as string | undefined, ctx)
          : meActor(ctx);
        assertCanQuery(ctx, target);
        ctx.wf.msgs.promoteQueued(target);
        ctx.wf.msgs.expireDue();
        const list = ctx.wf.msgs.forActor(target, {
          unreadOnly: Boolean(args.unread_only),
          includeAcked: Boolean(args.include_acked),
          kind: args.kind as MessageKind | undefined,
          limit: args.limit as number | undefined,
        });
        const unread = ctx.wf.msgs.unreadCount(target);
        const blocking = ctx.wf.msgs.blockingFor(target).length;
        if (!list.length) return `${actorKey(target)}: 没有消息（未读 0）。`;
        return [
          `${actorKey(target)}: ${list.length} 条 · 未读 ${unread} · blocking ${blocking}`,
          '',
          ...list.map((m) => formatMessage(m)),
        ].join('\n');
      },
    },
    {
      name: 'read_message',
      description: '读取一条消息并标记为已读。',
      roles: READ_ROLES,
      schema: { id: z.string() },
      handler: (args, ctx) => {
        const m = ctx.wf.msgs.get(String(args.id));
        if (!m) return err(`找不到消息 ${args.id}`);
        assertCanQuery(ctx, m.to);
        const updated = ctx.wf.msgs.markRead(m.id)!;
        return formatMessage(updated, { full: true });
      },
    },
    {
      name: 'ack_message',
      description: '确认已处理一条消息（ack）。blocking 消息 ack 后才会解除拦截。',
      roles: READ_ROLES,
      schema: { id: z.string(), note: z.string().optional() },
      handler: (args, ctx) => {
        const m = ctx.wf.msgs.get(String(args.id));
        if (!m) return err(`找不到消息 ${args.id}`);
        assertCanQuery(ctx, m.to);
        const updated = ctx.wf.msgs.ack(m.id, args.note as string | undefined)!;
        logEvent(ctx.wf.root, {
          role: ctx.role,
          tool: 'message_ack',
          repo: m.repo,
          ok: true,
          detail: { message: m.id },
        });
        return `已 ack ${updated.id}（${updated.status}）${updated.blocking ? '，blocking 已解除' : ''}`;
      },
    },
    {
      name: 'wait_message',
      description:
        '长轮询等待新消息（默认 30s，最长 120s）。收到后自动标记已读。适合空闲的 plan/todo 会话。',
      roles: READ_ROLES,
      schema: {
        role: z.enum(['main', 'plan', 'todo', 'user']).optional(),
        repo: z.string().optional(),
        timeout_ms: z.number().optional(),
      },
      handler: async (args, ctx) => {
        const target = args.role
          ? resolveActor(String(args.role), args.repo as string | undefined, ctx)
          : meActor(ctx);
        assertCanQuery(ctx, target);
        const timeout = Math.min(Number(args.timeout_ms ?? 30_000), 120_000);
        const deadline = Date.now() + timeout;
        ctx.wf.msgs.ping(target);
        while (Date.now() < deadline) {
          ctx.wf.msgs.expireDue();
          ctx.wf.msgs.promoteQueued(target);
          const [next] = ctx.wf.msgs.forActor(target, { unreadOnly: true, limit: 1 });
          if (next) {
            const read = ctx.wf.msgs.markRead(next.id)!;
            return `收到消息：\n${formatMessage(read, { full: true })}`;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        return `timeout: ${actorKey(target)} 在 ${Math.round(timeout / 1000)}s 内没有新消息。`;
      },
    },
    {
      name: 'broadcast',
      description: '向所有 plan/todo 广播（仅 main）。',
      roles: ['main'],
      schema: {
        kind: z.enum(['event', 'alert']).default('event'),
        subject: z.string(),
        body: z.string().optional(),
        refs: z.record(z.string(), z.string()).optional(),
      },
      handler: (args, ctx) => {
        const targets: Actor[] = ctx.wf.cfg.repos.flatMap((r) => [
          { role: 'plan' as const, repo: r.id },
          { role: 'todo' as const, repo: r.id },
        ]);
        const msgs = ctx.wf.msgs.emit({
          from: meActor(ctx),
          to: targets,
          kind: args.kind as MessageKind,
          subject: String(args.subject),
          body: args.body ? String(args.body) : '',
          refs: (args.refs as Record<string, string>) || {},
          idempotencyBase: `broadcast:${Date.now()}`,
        });
        return `已广播 ${msgs.length} 条：${msgs.map((m) => m.id).join(', ')}`;
      },
    },
    {
      name: 'presence',
      description: '登记/查看 agent 在线状态。',
      roles: READ_ROLES,
      schema: { session: z.string().optional() },
      handler: (args, ctx) => {
        ctx.wf.msgs.ping(meActor(ctx), args.session as string | undefined);
        const list = ctx.wf.msgs.presence();
        if (!list.length) return '没有 presence 记录。';
        return list
          .map(
            (p) =>
              `${p.online ? '●' : '○'} ${actorKey(p.actor)}  ${p.last_seen}` +
              (p.session ? `  [${p.session}]` : ''),
          )
          .join('\n');
      },
    },
    {
      name: 'escalate',
      description: '把一条消息升级给用户（并记录原因）。',
      roles: READ_ROLES,
      schema: { id: z.string(), reason: z.string() },
      handler: (args, ctx) => {
        const m = ctx.wf.msgs.escalate(String(args.id), String(args.reason), meActor(ctx));
        if (!m) return err(`找不到消息 ${args.id}`);
        return `已升级 ${args.id} → ${m.id}（→ user）`;
      },
    },
    {
      name: 'milestone_claim',
      description: '领取一个 M，状态 todo_ready → implementing。',
      roles: ['todo', 'main'],
      schema: { milestone: msParam, repo: repoParam },
      handler: (args, ctx) => {
        const repo = requireRepo(args, ctx);
        const m = ctx.wf.claim(repo, String(args.milestone), ctx.role);
        return `${m.id} 进入 implementing。只按 TODO 改；有歧义先 ask（to: PLAN）。`;
      },
    },
    {
      name: 'milestone_complete',
      description: '实现完成，状态 implementing → review。要求至少一条证据。',
      roles: ['todo', 'main'],
      schema: { milestone: msParam, repo: repoParam },
      handler: (args, ctx) => {
        const repo = requireRepo(args, ctx);
        const m = ctx.wf.complete(repo, String(args.milestone), ctx.role);
        return `${m.id} 进入 review，等待 PLAN agent 验收。${m.evidence.length} 条证据。`;
      },
    },
    {
      name: 'evidence_run',
      description:
        '在仓库内执行命令并自动记录证据（退出码、SHA、tree oid、输出），写入 TODO 的「证据记录」。用这个而不是手写证据。',
      roles: ['todo', 'plan', 'main'],
      schema: {
        command: z.string().describe('要执行的命令，如 cargo test --workspace --locked'),
        milestone: msParam,
        repo: repoParam,
        cwd: z.string().optional().describe('相对仓库根目录的工作目录'),
        timeout_ms: z.number().optional(),
      },
      handler: async (args, ctx) => {
        const repo = requireRepo(args, ctx);
        const r = await ctx.wf.runEvidence({
          repoId: repo,
          milestone: String(args.milestone),
          command: String(args.command),
          role: ctx.role,
          cwd: args.cwd as string | undefined,
          timeoutMs: args.timeout_ms as number | undefined,
        });
        return [
          `${r.id} exit=${r.exitCode} head=${r.head} tree=${r.tree || '(clean)'} dirty=${r.dirty}`,
          `已写入 ${r.todoFile}`,
          '',
          r.output ? r.output.slice(-2000) : '(no output)',
        ].join('\n');
      },
    },
    {
      name: 'milestone_accept',
      description: 'PLAN/主 agent 验收 M（需处于 review 且有成功证据）。实现者不能自验。',
      roles: ['plan', 'main'],
      schema: {
        milestone: msParam,
        repo: repoParam,
        note: z.string().optional(),
        force: z.boolean().optional().describe('跳过状态/证据检查（仅限明确授权）'),
      },
      handler: (args, ctx) => {
        const repo = requireRepo(args, ctx);
        const m = ctx.wf.accept(repo, String(args.milestone), ctx.role, {
          note: args.note as string | undefined,
          force: Boolean(args.force),
        });
        return `${m.id} 已验收。受验 SHA ${m.sha ?? '?'}。下一步由用户 review diff 后批准提交。`;
      },
    },
    {
      name: 'milestone_reject',
      description: 'PLAN/主 agent 打回 M，必须给具体原因。',
      roles: ['plan', 'main'],
      schema: { milestone: msParam, reason: z.string(), repo: repoParam },
      handler: (args, ctx) => {
        const repo = requireRepo(args, ctx);
        const m = ctx.wf.reject(repo, String(args.milestone), ctx.role, String(args.reason));
        return `${m.id} 已打回。原因已写入 TODO 的「验收记录」。`;
      },
    },
    {
      name: 'scope_check',
      description: '检查当前改动是否越界：TODO 声明的「影响文件」+（todo 角色）ACL。',
      roles: READ_ROLES,
      schema: {
        milestone: msParam.optional(),
        repo: repoParam,
        as_role: z
          .enum(['todo', 'plan', 'main'])
          .optional()
          .describe('按哪个角色检查 ACL；默认实现者(todo)，PLAN 验收时用这个看实现方视角'),
      },
      handler: (args, ctx) => {
        const repo = requireRepo(args, ctx);
        const asRole = (args.as_role as Role | undefined) || (ctx.role === 'todo' ? 'todo' : 'plan');
        const r = ctx.wf.scopeCheck(repo, args.milestone as string | undefined, asRole, {
          enforceAcl: asRole === 'todo',
        });
        const lines = [
          `${r.pass ? 'PASS' : 'FAIL'} ${r.repo}${r.milestone ? '/' + r.milestone : ''}`,
          `改动 ${r.changed.length} 个文件:`,
          ...r.changed.map((f) => `  - ${f}`),
        ];
        if (r.violations.length) {
          lines.push('', '违规:');
          for (const v of r.violations) lines.push(`  ✗ ${v.file}: ${v.reason}`);
        }
        if (r.warnings.length) {
          lines.push('', '提示:');
          for (const w of r.warnings) lines.push(`  ! ${w}`);
        }
        return lines.join('\n');
      },
    },
    {
      name: 'commit_request',
      description:
        '请求提交：校验 scope 后生成一次性审批 id，需要用户执行 workflow-mcp approve <id>。',
      roles: READ_ROLES,
      schema: {
        message: z.string().describe('commit message'),
        repo: repoParam,
      },
      handler: (args, ctx) => {
        const repo = requireRepo(args, ctx);
        const r = ctx.wf.requestCommit({ repoId: repo, message: String(args.message), role: ctx.role });
        return [
          `审批已创建: ${r.approval.id}`,
          `仓库: ${repo}  文件: ${r.files.length}`,
          '',
          r.diffStat,
          '',
          `请用户执行: workflow-mcp approve ${r.approval.id}`,
          '（或在前端看板点“批准提交”）批准后再调用 commit。',
        ].join('\n');
      },
    },
    {
      name: 'commit',
      description: '使用已批准的审批执行本地 commit；不会 push。',
      roles: READ_ROLES,
      schema: {
        approval: z.string(),
        repo: repoParam,
        dry_run: z.boolean().optional(),
      },
      handler: (args, ctx) => {
        const repo = requireRepo(args, ctx);
        const r = ctx.wf.commitApproved({
          repoId: repo,
          approvalId: String(args.approval),
          role: ctx.role,
          dryRun: Boolean(args.dry_run),
        });
        if ('dryRun' in r) return `dry-run: ${JSON.stringify(r, null, 2)}`;
        return `已提交 ${repo} @ ${r.head}\n${r.message}`;
      },
    },
    {
      name: 'phase_activate',
      description: '主 agent 激活一个仓（串行锁），或设置为 null 暂停。',
      roles: ['main', 'user'],
      schema: {
        repo: z.string().describe('仓库 id；传空字符串表示无'),
        phase: z.string().optional(),
      },
      handler: (args, ctx) => {
        const repo = String(args.repo || '');
        ctx.wf.setActiveRepo(repo || null);
        if (args.phase) ctx.wf.updatePhase(String(args.phase), 'active');
        logEvent(ctx.wf.root, { role: ctx.role, tool: 'phase_activate', repo: repo || undefined, ok: true });
        return repo
          ? `active repo = ${repo}${args.phase ? `，阶段 ${args.phase} = active` : ''}`
          : 'active repo 已清空';
      },
    },
  ];

  return tools;
}

function requireRepo(args: Record<string, unknown>, ctx: Ctx): string {
  const repo = (args.repo as string) || ctx.repo || ctx.wf.cfg.active_repo;
  if (!repo) throw new Error('需要指定 repo（或先 bootstrap 绑定仓库）');
  ctx.wf.repoRef(repo);
  return repo;
}

function meActor(ctx: Ctx): Actor {
  return { role: ctx.role, repo: ctx.repo ?? undefined };
}

function resolveActor(role: string, repo: string | undefined, ctx: Ctx): Actor {
  if (role === 'plan' || role === 'todo') {
    return { role, repo: repo || ctx.repo || ctx.wf.cfg.active_repo || undefined };
  }
  return { role: role as Actor['role'] };
}

function assertCanQuery(ctx: Ctx, target: Actor): void {
  if (ctx.role === 'main' || ctx.role === 'user') return;
  if (actorKey(meActor(ctx)) === actorKey(target)) return;
  throw new Error(`角色 ${actorKey(meActor(ctx))} 不能读取 ${actorKey(target)} 的消息`);
}

export async function runMcpServer(opts: ServerOptions): Promise<void> {
  const cfg = loadConfig(opts.root);
  if (!cfg) {
    process.stderr.write(`[workflow] 未在 ${opts.root} 找到 .workflow/program.yaml\n`);
    process.exit(1);
  }
  const wf = new Workflow(opts.root, cfg);
  const ctx: Ctx = { wf, role: opts.role || 'user', repo: opts.repo || null };
  // Do not write the machine-wide role lease at startup: several role sessions
  // may run at once. Hooks should get their role from WF_ROLE/WF_REPO; the
  // bootstrap tool may declare it explicitly for single-session use.

  const server = new McpServer(
    { name: 'workflow', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: [
        '这是多 agent / 多仓开发的工作流状态机。开始任何工作前，先调用 bootstrap 声明本会话角色：',
        'bootstrap(role="main" | "plan" | "todo" | "user", repo="<仓库 id>")。',
        '然后调用 status 看全局、next 看下一步。',
        '规则：不要手改 PLAN.md / TODO-*.md 里的状态（由工具维护）；有歧义用 ask 提问；',
        '实现完成必须用 evidence_run 记录证据；验收用 milestone_accept；提交必须先 commit_request，',
        '等用户批准后再 commit；永远不要 push。',
        '写文件仍用原生 Edit/Write，但会被角色 ACL 和 git pre-commit 检查。',
      ].join(''),
    },
  );

  const tools = buildTools(opts);
  const registered = new Set<string>();

  const register = (t: ToolSpec) => {
    if (registered.has(t.name)) return;
    registered.add(t.name);
    server.registerTool(
      t.name,
      {
        title: t.name,
        description: t.description,
        inputSchema: t.schema,
      },
      async (args: Record<string, unknown>) => {
        const out = await invokeTool(tools, t.name, args, ctx);
        return typeof out === 'string' ? text(out) : out;
      },
    );
  };

  const publicTools = new Set(['bootstrap', 'status', 'next', 'doctor', 'questions']);
  for (const t of tools) if (publicTools.has(t.name)) register(t);

  // Once the role is bootstrapped, expose the rest through the same server.
  // (Tools are registered up-front but gated per call, so the list stays stable.)
  for (const t of tools) if (!publicTools.has(t.name)) register(t);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[workflow] MCP server ready: ${wf.root} role=${ctx.role}${ctx.repo ? ' repo=' + ctx.repo : ''}\n`,
  );
}

export { buildTools };

/**
 * Single entry point for a tool call, shared by the MCP registration and tests.
 * Enforces role gating and converts handler output to an MCP tool result.
 */
export async function invokeTool(
  tools: ToolSpec[],
  name: string,
  args: Record<string, unknown>,
  ctx: Ctx,
): Promise<ToolReturn> {
  const t = tools.find((x) => x.name === name);
  if (!t) return err(`未知工具 ${name}`);
  if (!t.roles.includes(ctx.role)) {
    return err(
      `角色 ${ctx.role} 不能调用 ${name}（允许: ${t.roles.join(', ')}）。` +
        `如果角色不对，重新 bootstrap。`,
    );
  }
  try {
    return await t.handler(args, ctx);
  } catch (e) {
    return err(`[${name}] ${(e as Error).message}`);
  }
}

export type { Ctx, ToolSpec, ToolReturn };
