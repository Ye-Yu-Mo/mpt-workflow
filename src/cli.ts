#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { init, formatInitResult } from './core/init.js';
import { Workflow } from './core/workflow.js';
import { findRoot, detectRepos } from './core/config.js';
import { runPretool, runSessionStart, runPreCommit, setRoleLease, readRoleLease } from './core/hooks.js';
import { runMcpServer } from './mcp/server.js';
import { startWebServer } from './web/server.js';
import { describeAcl } from './core/acl.js';
import { updateQuestion } from './core/questions.js';
import type { Role } from './core/types.js';

function usage(): string {
  return `workflow-mcp — 多 agent / 多仓工作流状态机

用法:
  workflow-mcp init [--root DIR] [--program NAME] [--repo NAME]... [--install-hooks]
                  [--no-adopt]
  workflow-mcp status [--root DIR] [--json]
  workflow-mcp next [--root DIR]
  workflow-mcp doctor [--root DIR]
  workflow-mcp questions [--root DIR] [--json] [--all]
  workflow-mcp answer <Q-id> --answer TEXT [--resolution TEXT] [--root DIR]
  workflow-mcp approve <approval-id> [--root DIR]
  workflow-mcp activate <repo|-> [--root DIR]
  workflow-mcp role <main|plan|todo|user> [--repo NAME] [--root DIR]
  workflow-mcp commit <approval-id> [--root DIR]
  workflow-mcp web [--root DIR] [--port 7788]
  workflow-mcp mcp [--root DIR] [--role ROLE] [--repo NAME]
  workflow-mcp hook pretool|session-start|pre-commit
  workflow-mcp acl <role>

环境变量:
  WF_ROLE / WF_REPO   覆盖 .workflow/runtime/role.json 中的会话角色
  WF_ALLOW_COMMIT=1   跳过 git pre-commit scope 检查
`;
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        const cur = flags[key];
        if (cur === undefined) flags[key] = next;
        else if (Array.isArray(cur)) cur.push(next);
        else flags[key] = [String(cur), next];
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

function resolveWorkflow(flags: Record<string, unknown>): Workflow {
  const rootArg = typeof flags.root === 'string' ? flags.root : undefined;
  const start = rootArg ? path.resolve(rootArg) : process.cwd();
  const wf = Workflow.discover(start);
  if (!wf) {
    const root = findRoot(start);
    throw new Error(
      root
        ? `${root} 有 .workflow 目录但配置无法读取`
        : `未找到工作流根目录（从 ${start} 向上没有 .workflow/program.yaml）。先运行 workflow-mcp init`,
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
  const lease = readRoleLease(wf.root);
  console.log(`程序: ${st.program}`);
  console.log(`根目录: ${st.root}`);
  console.log(`active repo: ${st.activeRepo ?? '(none)'}${lease ? `   本会话角色: ${lease.role}${lease.repo ? '@' + lease.repo : ''}` : ''}`);
  console.log('');
  for (const p of st.phases) console.log(`阶段 ${p.id}「${p.title}」= ${p.status}  [${p.repos.join(', ')}]`);
  console.log('');
  for (const r of st.repos) {
    const done = r.milestones.filter((x) => ['accepted', 'committed'].includes(x.status)).length;
    const m = r.currentMilestone;
    console.log(
      `${r.id.padEnd(20)} ${String(done).padStart(2)}/${r.milestones.length} M  ` +
        `[${r.git.branch}@${r.git.shortHead}${r.git.dirty ? ', dirty' : ''}]  ` +
        (m ? `当前 ${m.id} ${m.status}` : r.milestones.length === 0 ? '无 M（缺 PLAN）' : '全部完成'),
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
      console.log(`  [${n.actor}] ${n.action}${n.repo ? ` (${n.repo}${n.milestone ? '/' + n.milestone : ''})` : ''}`);
      console.log(`      ${n.detail}`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const cmd = positional[0] || 'help';

  try {
    switch (cmd) {
      case 'help':
      case '--help':
      case '-h':
        console.log(usage());
        return;

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
          adopt: flags['no-adopt'] ? false : true,
          installHooks: Boolean(flags['install-hooks']),
        });
        console.log(formatInitResult(res));
        return;
      }

      case 'status': {
        const wf = resolveWorkflow(flags);
        printStatus(wf, Boolean(flags.json));
        return;
      }

      case 'next': {
        const wf = resolveWorkflow(flags);
        const st = wf.programStatus();
        for (const n of st.next) {
          console.log(`[${n.actor}] ${n.action}${n.repo ? ` (${n.repo}${n.milestone ? '/' + n.milestone : ''})` : ''}`);
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
          console.log(`${f.level.padEnd(4)} ${f.code}${f.repo ? ` [${f.repo}]` : ''}: ${f.message}`);
          if (f.hint) console.log(`      → ${f.hint}`);
        }
        process.exitCode = findings.some((f) => f.level === 'FAIL') ? 1 : 0;
        return;
      }

      case 'questions': {
        const wf = resolveWorkflow(flags);
        let qs = wf.allQuestions();
        if (!flags.all) qs = qs.filter((q) => q.status !== 'closed' && q.status !== 'canceled');
        if (flags.json) {
          console.log(JSON.stringify(qs, null, 2));
          return;
        }
        for (const q of qs) {
          console.log(`${q.id} [${q.status}]${q.blocking ? ' [blocking]' : ''} ${q.from} → ${q.to}  (${q.repo ?? 'root'})`);
          console.log(`  ${q.context.split('\n')[0].slice(0, 160)}`);
        }
        if (!qs.length) console.log('没有未闭合的问题。');
        return;
      }

      case 'answer': {
        const wf = resolveWorkflow(flags);
        const id = positional[1];
        const answer = typeof flags.answer === 'string' ? flags.answer : '';
        if (!id || !answer) throw new Error('用法: workflow-mcp answer Q-001 --answer "..."');
        const q = wf.findQuestion(id);
        if (!q) throw new Error(`找不到 ${id}`);
        updateQuestion(q.file, id, {
          status: 'answered',
          answer,
          resolution: typeof flags.resolution === 'string' ? flags.resolution : undefined,
        });
        console.log(`已回答 ${id}。记得回写 PLAN/TODO。`);
        return;
      }

      case 'approve': {
        const wf = resolveWorkflow(flags);
        const id = positional[1];
        if (!id) throw new Error('用法: workflow-mcp approve <approval-id>');
        const a = wf.approve(id);
        console.log(`已批准 ${a.id}（${a.repo}，${a.files.length} 个文件）。`);
        console.log('agent 现在可以调用 commit。');
        return;
      }

      case 'commit': {
        const wf = resolveWorkflow(flags);
        const id = positional[1];
        if (!id) throw new Error('用法: workflow-mcp commit <approval-id>');
        const a = wf.approvals().find((x) => x.id === id);
        if (!a) throw new Error(`找不到审批 ${id}`);
        const r = wf.commitApproved({ repoId: a.repo, approvalId: id, role: 'user' });
        console.log(`已提交 ${a.repo} @ ${(r as { head: string }).head}`);
        return;
      }

      case 'activate': {
        const wf = resolveWorkflow(flags);
        const repo = positional[1];
        if (!repo) throw new Error('用法: workflow-mcp activate <repo|->');
        wf.setActiveRepo(repo === '-' ? null : repo);
        console.log(repo === '-' ? 'active repo 已清空' : `active repo = ${repo}`);
        return;
      }

      case 'role': {
        const wf = resolveWorkflow(flags);
        const role = (positional[1] || '') as Role;
        if (!['main', 'plan', 'todo', 'user'].includes(role)) {
          throw new Error('用法: workflow-mcp role <main|plan|todo|user> [--repo NAME]');
        }
        const repo = typeof flags.repo === 'string' ? flags.repo : undefined;
        setRoleLease(wf.root, { role, repo, at: new Date().toISOString() });
        console.log(`本机会话角色 = ${role}${repo ? ` @ ${repo}` : ''}`);
        console.log(describeAcl(role));
        return;
      }

      case 'acl': {
        const role = (positional[1] || 'todo') as Role;
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
        else throw new Error('用法: workflow-mcp hook pretool|session-start|pre-commit');
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
