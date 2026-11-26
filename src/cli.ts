#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { describeAcl } from './core/acl.js';
import { findRoot } from './core/config.js';
import { createDemoWorkspace } from './core/demo.js';
import { formatGcReport, runGc } from './core/gc.js';
import {
  readRoleLease,
  runPreCommit,
  runPretool,
  runSessionStart,
  setRoleLease,
} from './core/hooks.js';
import { formatInitResult, init } from './core/init.js';
import { formatMessage, type MessageKind } from './core/messages.js';
import { migrateConfig, SCHEMA_VERSION } from './core/migrate.js';
import { updateQuestion } from './core/questions.js';
import { sessionDisplay } from './core/session.js';
import { withLock } from './core/state.js';
import { isRole, type Role } from './core/types.js';
import { Workflow } from './core/workflow.js';
import { runMcpServer } from './mcp/server.js';
import { VERSION } from './version.js';
import { startWebServer } from './web/server.js';

function usage(): string {
  return `mpt-workflow — 多 agent / 多仓工作流状态机

用法:
  mpt-workflow init [--root DIR] [--program NAME] [--repo NAME]... [--install-hooks]
                  [--no-adopt]
  mpt-workflow demo
  mpt-workflow --version
  mpt-workflow status [--root DIR] [--json]
  mpt-workflow gc [--root DIR] [--older-than DAYS] [--evidence-days DAYS] [--apply] [--json]
  mpt-workflow next [--root DIR]
  mpt-workflow doctor [--root DIR]
  mpt-workflow migrate [--root DIR] [--apply]
  mpt-workflow questions [--root DIR] [--json] [--all]
  mpt-workflow answer <Q-id> --answer TEXT [--resolution TEXT] [--root DIR]
  mpt-workflow inbox [--role R] [--repo NAME] [--unread] [--all] [--json]
  mpt-workflow read <msg-id>
  mpt-workflow ack <msg-id> [--note TEXT]
  mpt-workflow send --to <actor> [--to-repo NAME] [--kind K] --subject TEXT
                    [--body TEXT] [--blocking] [--refs JSON] [--from R]
  mpt-workflow wait [--role R] [--repo NAME] [--timeout MS]
  mpt-workflow watch [--role R] [--repo NAME] [--interval MS]
  mpt-workflow escalate <msg-id> --reason TEXT
  mpt-workflow presence [--session NAME]
  mpt-workflow approve <approval-id> [--root DIR]
  mpt-workflow activate <repo|-> [--root DIR]
  mpt-workflow role <main|plan|todo|user> [--repo NAME] [--session ID] [--root DIR]
  mpt-workflow commit <approval-id> [--root DIR]
  mpt-workflow web [--root DIR] [--port 7788]
  mpt-workflow mcp [--root DIR] [--role ROLE] [--repo NAME]
  mpt-workflow hook pretool|session-start|pre-commit
  mpt-workflow acl <role>

环境变量:
  WF_ROLE / WF_REPO   覆盖 .workflow/runtime/role.json 中的会话角色
  WF_ALLOW_COMMIT=1   跳过 git pre-commit scope 检查
`;
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  const set = (key: string, value: string) => {
    const cur = flags[key];
    if (cur === undefined) flags[key] = value;
    else if (Array.isArray(cur)) cur.push(value);
    else flags[key] = [String(cur), value];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        set(a.slice(2, eq), a.slice(eq + 1));
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        set(key, next);
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function boolFlag(flags: Record<string, unknown>, name: string, fallback = false): boolean {
  const v = flags[name];
  if (v === undefined) return fallback;
  if (v === true) return true;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off'].includes(s)) return false;
  }
  throw new Error(`--${name} 只接受布尔值（true/false）`);
}

function resolveWorkflow(flags: Record<string, unknown>): Workflow {
  const rootArg = typeof flags.root === 'string' ? flags.root : undefined;
  const start = rootArg ? path.resolve(rootArg) : process.cwd();
  const wf = Workflow.discover(start);
  if (!wf) {
    const root = findRoot(start);
    throw new Error(
      root
        ? `${root} 有 .workflow 目录但配置无法读取`
        : `未找到工作流根目录（从 ${start} 向上没有 .workflow/program.yaml）。先运行 mpt-workflow init`,
    );
  }
  return wf;
}

function printStatus(wf: Workflow, json: boolean) {
  const st = wf.programStatus();
  if (json) {
    process.stdout.write(JSON.stringify(st, null, 2) + '\n');
    return;
  }
  console.log(`程序: ${st.program}`);
  console.log(`根目录: ${st.root}`);
  console.log(
    `当前会话: ${st.session ? `${st.session.role}${st.session.repo ? `@${st.session.repo}` : ''}（${st.session.id ? st.session.id.slice(0, 8) : 'env'}）` : '未声明（bootstrap 或 WF_ROLE）'}`,
  );
  console.log(`全局 active repo: ${st.activeRepo ?? '(none)'}`);
  console.log(
    `配置: ${st.config.version} · ${st.config.path}${st.config.error ? ` · 解析失败: ${st.config.error}` : ` · 加载于 ${st.config.loaded_at}`}`,
  );
  console.log('');
  for (const p of st.phases)
    console.log(`阶段 ${p.id}「${p.title}」= ${p.status}  [${p.repos.join(', ')}]`);
  console.log('');
  for (const r of st.repos) {
    const done = r.milestones.filter((x) => ['accepted', 'committed'].includes(x.status)).length;
    const m = r.currentMilestone;
    console.log(
      `${r.id.padEnd(20)} ${String(done).padStart(2)}/${r.milestones.length} M  ` +
        `[${r.git.branch}@${r.git.shortHead}${r.git.dirty ? ', dirty' : ''}]  ` +
        (m
          ? `当前 ${m.id} ${m.status}`
          : r.milestones.length === 0
            ? '无 M（缺 PLAN）'
            : '全部完成'),
    );
    for (const mm of r.milestones) {
      console.log(
        `    ${mm.id}  ${mm.status.padEnd(12)} ${mm.title}` +
          (mm.evidence.length ? `  证据=${mm.evidence.length}` : ''),
      );
    }
  }
  const open = st.questions.filter((q) => q.status === 'open' || q.status === 'answered');
  if (open.length) {
    console.log('\n问题:');
    for (const q of open) {
      console.log(`  ${q.id} [${q.status}]${q.blocking ? ' [blocking]' : ''} ${q.from} → ${q.to}`);
      console.log(`      ${q.context.split('\n')[0].slice(0, 150)}`);
    }
  }
  if (st.next.length) {
    console.log('\n下一步:');
    for (const n of st.next) {
      console.log(
        `  [${n.actor}] ${n.action}${n.repo ? ` (${n.repo}${n.milestone ? '/' + n.milestone : ''})` : ''}`,
      );
      console.log(`      ${n.detail}`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const cmd = positional[0] || 'help';

  if (flags.version) {
    console.log(VERSION);
    return;
  }

  try {
    switch (cmd) {
      case 'help':
      case '--help':
      case '-h':
        console.log(usage());
        return;

      case 'version':
      case '-v':
      case '--version':
        console.log(VERSION);
        return;

      case 'demo': {
        const { root } = createDemoWorkspace();
        const wf = new Workflow(root);
        console.log(`Demo workspace: ${root}\n`);
        printStatus(wf, false);
        console.log('');
        console.log(`打开看板: mpt-workflow web --root ${JSON.stringify(root)} --port 7788`);
        console.log('演示目录在 $TMPDIR 下；没有改动任何现有仓库。');
        return;
      }

      case 'init': {
        const root = typeof flags.root === 'string' ? flags.root : process.cwd();
        const repos = flags.repo
          ? Array.isArray(flags.repo)
            ? flags.repo
            : [String(flags.repo)]
          : undefined;
        const res = init({
          root,
          program: typeof flags.program === 'string' ? flags.program : undefined,
          repos,
          adopt: !boolFlag(flags, 'no-adopt'),
          installHooks: boolFlag(flags, 'install-hooks'),
        });
        console.log(formatInitResult(res));
        return;
      }

      case 'status': {
        const wf = resolveWorkflow(flags);
        printStatus(wf, boolFlag(flags, 'json'));
        return;
      }

      case 'next': {
        const wf = resolveWorkflow(flags);
        const st = wf.programStatus();
        for (const n of st.next) {
          console.log(
            `[${n.actor}] ${n.action}${n.repo ? ` (${n.repo}${n.milestone ? '/' + n.milestone : ''})` : ''}`,
          );
          console.log(`    ${n.detail}`);
        }
        return;
      }

      case 'doctor': {
        const wf = resolveWorkflow(flags);
        const findings = wf.doctor();
        const order = { FAIL: 0, WARN: 1, OK: 2 };
        findings.sort((a, b) => order[a.level] - order[b.level]);
        for (const f of findings) {
          console.log(
            `${f.level.padEnd(4)} ${f.code}${f.repo ? ` [${f.repo}]` : ''}: ${f.message}`,
          );
          if (f.hint) console.log(`      → ${f.hint}`);
        }
        process.exitCode = findings.some((f) => f.level === 'FAIL') ? 1 : 0;
        return;
      }

      case 'migrate': {
        const wf = resolveWorkflow(flags);
        const apply = boolFlag(flags, 'apply');
        const r = migrateConfig(wf.root, apply);
        if (r.changes.length === 0) {
          console.log(`配置已是最新（schema_version=${SCHEMA_VERSION}）。`);
          return;
        }
        console.log(`${apply ? '已迁移' : '迁移预览'} .workflow/program.yaml：`);
        for (const c of r.changes) console.log(`  - ${c}`);
        if (!apply) {
          console.log('');
          console.log(r.after.trimEnd());
          console.log('');
          console.log('预览模式；加 --apply 写入。');
        }
        return;
      }

      case 'gc': {
        const wf = resolveWorkflow(flags);
        const numberFlag = (name: string, fallback: number): number => {
          if (typeof flags[name] !== 'string') return fallback;
          const n = Number(flags[name]);
          if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} 必须是非负数字`);
          return n;
        };
        const report = runGc(wf.root, {
          olderThanDays: numberFlag('older-than', 30),
          evidenceDays: numberFlag('evidence-days', 0),
          apply: boolFlag(flags, 'apply'),
        });
        if (boolFlag(flags, 'json')) console.log(JSON.stringify(report, null, 2));
        else console.log(formatGcReport(report));
        if (report.failed.length) process.exitCode = 1;
        return;
      }

      case 'questions': {
        const wf = resolveWorkflow(flags);
        let qs = wf.allQuestions();
        if (!boolFlag(flags, 'all'))
          qs = qs.filter((q) => q.status !== 'closed' && q.status !== 'canceled');
        if (boolFlag(flags, 'json')) {
          console.log(JSON.stringify(qs, null, 2));
          return;
        }
        for (const q of qs) {
          console.log(
            `${q.id} [${q.status}]${q.blocking ? ' [blocking]' : ''} ${q.from} → ${q.to}  (${q.repo ?? 'root'})`,
          );
          console.log(`  ${q.context.split('\n')[0].slice(0, 160)}`);
        }
        if (!qs.length) console.log('没有未闭合的问题。');
        return;
      }

      case 'answer': {
        const wf = resolveWorkflow(flags);
        const id = positional[1];
        const answer = typeof flags.answer === 'string' ? flags.answer : '';
        if (!id || !answer) throw new Error('用法: mpt-workflow answer Q-001 --answer "..."');
        const q = wf.findQuestion(id);
        if (!q) throw new Error(`找不到 ${id}`);
        withLock(wf.root, 'questions', () =>
          updateQuestion(q.file, id, {
            status: 'answered',
            answer,
            resolution: typeof flags.resolution === 'string' ? flags.resolution : undefined,
          }),
        );
        console.log(`已回答 ${id}。记得回写 PLAN/TODO。`);
        return;
      }

      case 'inbox': {
        const wf = resolveWorkflow(flags);
        const lease = readRoleLease(wf.root);
        const role = (flags.role as string) || lease?.role || 'user';
        const repo = (flags.repo as string) || lease?.repo;
        const target = { role: role as Role, repo };
        wf.msgs.promoteQueued(target);
        wf.msgs.expireDue();
        const list = wf.msgs.forActor(target, {
          unreadOnly: boolFlag(flags, 'unread'),
          includeAcked: boolFlag(flags, 'all'),
          limit: typeof flags.limit === 'string' ? Number(flags.limit) : undefined,
        });
        if (boolFlag(flags, 'json')) {
          console.log(
            JSON.stringify({ unread: wf.msgs.unreadCount(target), messages: list }, null, 2),
          );
          return;
        }
        const unread = wf.msgs.unreadCount(target);
        const blocking = wf.msgs.blockingFor(target).length;
        console.log(
          `${role}${repo ? '@' + repo : ''}: ${list.length} 条 · 未读 ${unread} · blocking ${blocking}`,
        );
        for (const m of list) console.log('\n' + formatMessage(m));
        return;
      }

      case 'read': {
        const wf = resolveWorkflow(flags);
        const id = positional[1];
        if (!id) throw new Error('用法: mpt-workflow read <msg-id>');
        const m = wf.msgs.markRead(id);
        if (!m) throw new Error(`找不到消息 ${id}`);
        console.log(formatMessage(m, { full: true }));
        return;
      }

      case 'ack': {
        const wf = resolveWorkflow(flags);
        const id = positional[1];
        if (!id) throw new Error('用法: mpt-workflow ack <msg-id> [--note TEXT]');
        const m = wf.msgs.ack(id, typeof flags.note === 'string' ? flags.note : undefined);
        if (!m) throw new Error(`找不到消息 ${id}`);
        console.log(`已 ack ${id}`);
        return;
      }

      case 'send': {
        const wf = resolveWorkflow(flags);
        const lease = readRoleLease(wf.root);
        const fromRole = ((flags.from as string) || lease?.role || 'user') as Role;
        const fromRepo =
          (flags['from-repo'] as string) ||
          (fromRole === 'plan' || fromRole === 'todo' ? lease?.repo : undefined);
        if (!flags.to)
          throw new Error('用法: mpt-workflow send --to <main|plan|todo|user> --subject TEXT');
        const toRole = String(flags.to);
        const toRepo =
          (flags['to-repo'] as string) ||
          (toRole === 'plan' || toRole === 'todo' ? lease?.repo : undefined);
        let refs: Record<string, string> = {};
        if (typeof flags.refs === 'string') {
          try {
            refs = JSON.parse(flags.refs) as Record<string, string>;
          } catch {
            throw new Error('--refs 必须是 JSON 对象');
          }
        }
        const { message, duplicate } = wf.msgs.send({
          from: { role: fromRole, repo: fromRepo },
          to: { role: toRole as Role, repo: toRepo },
          kind: ((flags.kind as string) || 'event') as MessageKind,
          subject: String(flags.subject || '(no subject)'),
          body: typeof flags.body === 'string' ? flags.body : '',
          refs,
          blocking: boolFlag(flags, 'blocking'),
          idempotency_key:
            typeof flags['idempotency-key'] === 'string' ? flags['idempotency-key'] : undefined,
        });
        console.log(
          `${duplicate ? '已存在' : '已发送'} ${message.id} → ${toRole}${toRepo ? '@' + toRepo : ''} [${message.status}]`,
        );
        return;
      }

      case 'wait': {
        const wf = resolveWorkflow(flags);
        const lease = readRoleLease(wf.root);
        const role = ((flags.role as string) || lease?.role || 'user') as Role;
        const repo = (flags.repo as string) || lease?.repo;
        const target = { role, repo };
        const timeout = typeof flags.timeout === 'string' ? Number(flags.timeout) : 60_000;
        const deadline = Date.now() + Math.min(timeout, 600_000);
        wf.msgs.ping(target);
        while (Date.now() < deadline) {
          wf.msgs.expireDue();
          wf.msgs.promoteQueued(target);
          const [next] = wf.msgs.forActor(target, { unreadOnly: true, limit: 1 });
          if (next) {
            console.log(formatMessage(wf.msgs.markRead(next.id)!, { full: true }));
            return;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        console.log('timeout: 没有新消息。');
        return;
      }

      case 'watch': {
        const wf = resolveWorkflow(flags);
        const lease = readRoleLease(wf.root);
        const role = ((flags.role as string) || lease?.role || 'user') as Role;
        const repo = (flags.repo as string) || lease?.repo;
        const target = { role, repo };
        const interval = typeof flags.interval === 'string' ? Number(flags.interval) : 2000;
        const seen = new Set<string>();
        wf.msgs.ping(target);
        console.log(`watching ${role}${repo ? '@' + repo : ''} … (Ctrl-C 退出)`);
        // print anything already unread once
        for (;;) {
          wf.msgs.expireDue();
          wf.msgs.promoteQueued(target);
          const list = wf.msgs.forActor(target, { unreadOnly: true, limit: 20 });
          for (const m of list.reverse()) {
            if (seen.has(m.id)) continue;
            seen.add(m.id);
            console.log('\n' + formatMessage(m));
            wf.msgs.markRead(m.id);
          }
          await new Promise((r) => setTimeout(r, interval));
        }
      }

      case 'escalate': {
        const wf = resolveWorkflow(flags);
        const id = positional[1];
        const reason = typeof flags.reason === 'string' ? flags.reason : '';
        if (!id || !reason) throw new Error('用法: mpt-workflow escalate <msg-id> --reason TEXT');
        const lease = readRoleLease(wf.root);
        const m = wf.msgs.escalate(id, reason, {
          role: (lease?.role as Role) || 'user',
          repo: lease?.repo,
        });
        if (!m) throw new Error(`找不到消息 ${id}`);
        console.log(`已升级 → ${m.id}`);
        return;
      }

      case 'presence': {
        const wf = resolveWorkflow(flags);
        const lease = readRoleLease(wf.root);
        if (lease)
          wf.msgs.ping(
            { role: lease.role, repo: lease.repo },
            typeof flags.session === 'string' ? flags.session : undefined,
          );
        for (const p of wf.msgs.presence()) {
          console.log(
            `${p.online ? '●' : '○'} ${p.actor.role}${p.actor.repo ? '@' + p.actor.repo : ''}  ${p.last_seen}${p.session ? '  [' + p.session + ']' : ''}`,
          );
        }
        return;
      }

      case 'approve': {
        const wf = resolveWorkflow(flags);
        const id = positional[1];
        if (!id) throw new Error('用法: mpt-workflow approve <approval-id>');
        const a = wf.approve(id);
        console.log(`已批准 ${a.id}（${a.repo}，${a.files.length} 个文件）。`);
        console.log('agent 现在可以调用 commit。');
        return;
      }

      case 'commit': {
        const wf = resolveWorkflow(flags);
        const id = positional[1];
        if (!id) throw new Error('用法: mpt-workflow commit <approval-id>');
        const a = wf.approvals().find((x) => x.id === id);
        if (!a) throw new Error(`找不到审批 ${id}`);
        const r = wf.commitApproved({ repoId: a.repo, approvalId: id, role: 'user' });
        console.log(`已提交 ${a.repo} @ ${(r as { head: string }).head}`);
        return;
      }

      case 'activate': {
        const wf = resolveWorkflow(flags);
        const repo = positional[1];
        if (!repo) throw new Error('用法: mpt-workflow activate <repo|->');
        wf.setActiveRepo(repo === '-' ? null : repo);
        console.log(repo === '-' ? 'active repo 已清空' : `active repo = ${repo}`);
        return;
      }

      case 'role': {
        const wf = resolveWorkflow(flags);
        const role = (positional[1] || '') as Role;
        if (!['main', 'plan', 'todo', 'user'].includes(role)) {
          throw new Error(
            '用法: mpt-workflow role <main|plan|todo|user> [--repo NAME] [--session ID]',
          );
        }
        const repo = typeof flags.repo === 'string' ? flags.repo : undefined;
        const session = typeof flags.session === 'string' ? flags.session : undefined;
        const lease = setRoleLease(wf.root, { role, repo, at: new Date().toISOString() }, session);
        console.log(
          `会话角色 = ${role}${repo ? ` @ ${repo}` : ''}（session ${sessionDisplay(lease.session)}）`,
        );
        console.log(describeAcl(role));
        return;
      }

      case 'acl': {
        const role = positional[1] || 'todo';
        if (!isRole(role)) {
          throw new Error('用法: mpt-workflow acl <main|plan|todo|user>');
        }
        console.log(describeAcl(role));
        return;
      }

      case 'web': {
        const wf = resolveWorkflow(flags);
        const port = typeof flags.port === 'string' ? Number(flags.port) : 7788;
        await startWebServer(wf, port);
        return;
      }

      case 'mcp': {
        const rootArg = typeof flags.root === 'string' ? flags.root : process.cwd();
        const root = findRoot(path.resolve(rootArg));
        if (!root) throw new Error(`未找到 .workflow/program.yaml（从 ${rootArg} 向上）`);
        await runMcpServer({
          root,
          role: typeof flags.role === 'string' ? (flags.role as Role) : undefined,
          repo: typeof flags.repo === 'string' ? flags.repo : undefined,
        });
        return;
      }

      case 'hook': {
        const sub = positional[1];
        if (sub === 'pretool') process.exitCode = runPretool();
        else if (sub === 'session-start') process.exitCode = runSessionStart();
        else if (sub === 'pre-commit') process.exitCode = runPreCommit();
        else throw new Error('用法: mpt-workflow hook pretool|session-start|pre-commit');
        return;
      }

      default:
        console.log(usage());
        process.exitCode = 1;
    }
  } catch (e) {
    console.error(`错误: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

main();
