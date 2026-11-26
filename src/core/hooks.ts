import fs from 'node:fs';
import path from 'node:path';
import { checkAcl } from './acl.js';
import { runtimeDir } from './config.js';
import { parseTodo } from './docs.js';
import { exists, readText, writeAtomic } from './fsutil.js';
import { stagedFiles } from './git.js';
import { matchGlob } from './glob.js';
import { QUESTION_STATUS_HELP } from './questions.js';
import { isRole, type Role } from './types.js';
import { isMachineManagedFile, Workflow } from './workflow.js';

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export function readHookInput(): HookInput {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as HookInput;
  } catch (e) {
    throw new Error(`hook input 不是合法 JSON: ${(e as Error).message}`);
  }
}

/* ------------------------------ role lease ------------------------------ */

export interface RoleLease {
  role: Role;
  repo?: string;
  at: string;
}

function leasePath(root: string): string {
  return path.join(runtimeDir(root), 'role.json');
}

export function setRoleLease(root: string, lease: RoleLease): void {
  writeAtomic(leasePath(root), JSON.stringify(lease, null, 2));
}

export function readRoleLease(root: string): RoleLease | null {
  const envRole = process.env.WF_ROLE as Role | undefined;
  const envRepo = process.env.WF_REPO;
  if (envRole) return { role: envRole, repo: envRepo, at: new Date().toISOString() };
  const p = leasePath(root);
  if (!exists(p)) return null;
  try {
    return JSON.parse(readText(p)) as RoleLease;
  } catch {
    return null;
  }
}

/** Infer which repo owns `abs`, falling back to the lease's repo. */
function repoFor(wf: Workflow, abs: string, lease: RoleLease | null): string | null {
  const owned = wf.repoForPath(abs);
  if (owned) return owned.id;
  return lease?.repo || wf.cfg.repos[0]?.id || null;
}

function leaseBoundRepo(wf: Workflow, lease: RoleLease): { id: string; abs: string } | null {
  if (lease.role !== 'plan' && lease.role !== 'todo') return null;
  if (!lease.repo) return null;
  return wf.repoRefs().find((r) => r.id === lease.repo) ?? null;
}

function leaseError(wf: Workflow, lease: RoleLease): string | null {
  if (!isRole(lease.role)) return `无效角色 ${String(lease.role)}；允许 main/plan/todo/user`;
  if (lease.role === 'plan' || lease.role === 'todo') {
    if (!lease.repo) return `角色 ${lease.role} 没有绑定仓库（WF_REPO）`;
    if (!wf.repoRefs().some((r) => r.id === lease.repo)) {
      return `角色 ${lease.role} 绑定的仓库 ${lease.repo} 不存在`;
    }
  }
  return null;
}

/* ------------------------------- pretool -------------------------------- */

export function runPretool(): number {
  try {
    return runPretoolInner();
  } catch (e) {
    process.stderr.write(
      `[workflow] hook 出错，按 fail-closed 拒绝本次调用：${(e as Error).message}\n`,
    );
    return 2;
  }
}

function runPretoolInner(): number {
  const input = readHookInput();
  const cwd = input.cwd || process.cwd();
  const wf = Workflow.discover(cwd);
  if (!wf) return 0; // workflow not active here

  const lease = readRoleLease(wf.root);
  if (!lease) {
    // No role declared: only guard the most dangerous action.
    return guardPush(input) ? 2 : 0;
  }
  const bad = leaseError(wf, lease);
  if (bad) {
    process.stderr.write(`[workflow] 拒绝执行：${bad}\n`);
    return 2;
  }

  const repos = wf.repoRefs().map((r) => ({ id: r.id, abs: r.abs }));
  const bound = leaseBoundRepo(wf, lease);
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};

  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit' || tool === 'MultiEdit') {
    const file = String(ti.file_path || ti.notebook_path || '');
    if (!file) return 0;
    const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
    const repoId = bound ? bound.id : repoFor(wf, abs, lease);
    const repoAbs = bound
      ? bound.abs
      : repoId
        ? wf.repoRef(repoId).abs
        : path.join(wf.root, '.no-such-repo');
    const d = checkAcl(lease.role, abs, wf.root, repoId ?? '', repoAbs, repos);
    if (!d.allowed) {
      process.stderr.write(
        `[workflow] 拒绝写入：${d.reason}\n` +
          `角色 ${lease.role}` +
          (lease.repo ? `（绑定 ${lease.repo}）` : '') +
          `\n如果这是必要的跨角色操作，请让用户执行，或向对应 agent 提问。\n`,
      );
      return 2;
    }
    return 0;
  }

  if (tool === 'Bash') {
    const cmd = String(ti.command || '');
    const err = guardBash(wf, cmd, lease, cwd, repos);
    if (err) {
      process.stderr.write(err);
      return 2;
    }
  }
  return 0;
}

function guardPush(input: HookInput): boolean {
  const cmd = String(input.tool_input?.command || '');
  if (gitMutation(cmd) === 'push') {
    process.stderr.write('[workflow] push 必须由用户手动执行：agent 只做本地 commit。\n');
    return true;
  }
  return false;
}

/**
 * Best-effort detection of `git commit` / `git push`, including global options
 * such as `-C`, `-c` and `--git-dir`. Aliases are not resolved.
 */
function gitMutation(cmd: string): 'commit' | 'push' | null {
  const tokens = cmd.match(/(?:[^\s"'`;&|()]+|"[^"]*"|'[^']*')/g) ?? [];
  const takesValue = new Set([
    '-C',
    '-c',
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--config-env',
    '--super-prefix',
  ]);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'git' && !tokens[i].endsWith('/git')) continue;
    let j = i + 1;
    while (j < tokens.length) {
      const tok = tokens[j];
      if (tok.startsWith('-')) {
        j += takesValue.has(tok) ? 2 : 1;
        continue;
      }
      if (tok === 'commit' || tok === 'push') return tok;
      break;
    }
  }
  return null;
}

function guardBash(
  wf: Workflow,
  cmd: string,
  lease: RoleLease,
  cwd: string,
  repos: { id: string; abs: string }[],
): string | null {
  const mutation = gitMutation(cmd);
  if (mutation && lease.role !== 'user') {
    return mutation === 'push'
      ? '[workflow] push 必须由用户手动执行；agent 只做本地 commit。\n'
      : '[workflow] 不要用 Bash 执行 git commit；请走 MCP commit 工具（需要用户批准）。\n';
  }
  if (
    lease.role !== 'user' &&
    /\b(?:mpt-workflow|mpt|workflow-mcp)\s+(?:approve|commit)\b/.test(cmd)
  ) {
    return '[workflow] approve/commit 是用户操作；agent 不能自己批准或提交。\n';
  }

  // Outstanding blocking questions stop implementation.
  const blocking = wf
    .allQuestions()
    .filter(
      (q) =>
        q.blocking &&
        q.status === 'open' &&
        (lease.role === 'todo'
          ? String(q.to).toLowerCase() === 'plan'
          : String(q.to).toLowerCase() === 'main'),
    );
  if (blocking.length && lease.role === 'todo') {
    return (
      `[workflow] 有阻塞问题未回答，先停下: ${blocking.map((q) => q.id).join(', ')}\n` +
      `在 docs/agent-questions.md 等待回答；或让用户用 mpt-workflow status 查看。\n`
    );
  }

  // Best-effort redirect target check.
  const bound = leaseBoundRepo(wf, lease);
  const redirects = [...cmd.matchAll(/(?:^|[^0-9&])>{1,2}\s*([^\s;|&]+)/g)].map((m) => m[1]);
  for (const target of redirects) {
    if (!target || target.startsWith('/dev/') || target.startsWith('&')) continue;
    const abs = path.isAbsolute(target) ? target : path.resolve(cwd, target);
    const repoId = bound ? bound.id : repoFor(wf, abs, lease);
    const repoAbs = bound
      ? bound.abs
      : repoId
        ? wf.repoRef(repoId).abs
        : path.join(wf.root, '.no-such-repo');
    const d = checkAcl(lease.role, abs, wf.root, repoId ?? '', repoAbs, repos);
    if (!d.allowed) return `[workflow] 拒绝写入 ${target}：${d.reason}\n`;
  }
  return null;
}

/* ---------------------------- session-start ----------------------------- */

export function runSessionStart(): number {
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const wf = Workflow.discover(cwd);
  if (!wf) return 0;
  const lease = readRoleLease(wf.root);
  const st = wf.programStatus();

  const lines: string[] = [];
  lines.push('# workflow 状态（自动注入）');
  lines.push(
    `程序 ${st.program} · active repo: ${st.activeRepo ?? '(none)'}` +
      (lease
        ? ` · 本会话角色: ${lease.role}${lease.repo ? `@${lease.repo}` : ''}`
        : ' · 本会话角色: 未声明'),
  );

  for (const r of st.repos) {
    const m = r.currentMilestone;
    const done = r.milestones.filter((x) => ['accepted', 'committed'].includes(x.status)).length;
    lines.push(
      `- ${r.id}: ${done}/${r.milestones.length} M 完成` +
        (m ? ` · 当前 ${m.id}「${m.title}」=${m.status}` : ' · 全部完成') +
        (r.git.dirty ? ' · 工作区有改动' : ''),
    );
  }

  if (st.blockingQuestions.length) {
    lines.push('');
    lines.push('## 阻塞问题');
    for (const q of st.blockingQuestions) {
      lines.push(`- ${q.id} ${q.from} → ${q.to}: ${q.context.split('\n')[0].slice(0, 120)}`);
    }
  }

  if (lease) {
    const me = { role: lease.role, repo: lease.repo };
    try {
      wf.msgs.ping(me);
      wf.msgs.expireDue();
      const unread = wf.msgs.unreadCount(me);
      const blocking = wf.msgs.blockingFor(me);
      if (unread || blocking.length) {
        lines.push('');
        lines.push(
          `## 未读消息 ${unread} 条${blocking.length ? `（blocking ${blocking.length}）` : ''}`,
        );
        for (const m of blocking)
          lines.push(`- [blocking] ${m.id} ${m.subject}（ack 后才能推进 M）`);
        for (const m of wf.msgs.forActor(me, { limit: 3 })) {
          if (blocking.some((b) => b.id === m.id)) continue;
          lines.push(`- ${m.id} [${m.kind}] ${m.subject}`);
        }
        lines.push('用 inbox 查看，read/ack 处理。');
      }
    } catch {
      /* messages are optional in the hook */
    }
  }

  if (st.next.length) {
    lines.push('');
    lines.push('## 建议下一步');
    for (const n of st.next.slice(0, 5)) {
      lines.push(
        `- [${n.actor}] ${n.action}${n.repo ? ` (${n.repo}${n.milestone ? '/' + n.milestone : ''})` : ''} — ${n.detail}`,
      );
    }
  }

  lines.push('');
  lines.push(
    '规则：只用 MCP 的 workflow 工具推进状态；不要手改 PLAN/TODO 状态；' +
      '有歧义先提问（ask）；提交需用户批准；blocking 消息要 ack 才能继续。',
  );
  lines.push(`问题：${QUESTION_STATUS_HELP}`);
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

/* ----------------------------- pre-commit ------------------------------- */

export function runPreCommit(): number {
  const cwd = process.cwd();
  const wf = Workflow.discover(cwd);
  if (!wf) return 0;
  const owned = wf.repoForPath(cwd);
  if (!owned) return 0; // umbrella commits are the user's own docs

  const lease = readRoleLease(wf.root);
  const roleRaw = lease?.role ?? 'user';
  if (!isRole(roleRaw)) {
    process.stderr.write(`[workflow] 无效角色 ${String(roleRaw)}；拒绝提交\n`);
    return 1;
  }
  const role: Role = roleRaw;
  const bound = lease ? leaseBoundRepo(wf, lease) : null;
  if ((role === 'plan' || role === 'todo') && !bound) {
    process.stderr.write(`[workflow] 角色 ${role} 没有有效的绑定仓库；拒绝提交\n`);
    return 1;
  }
  if (bound && owned.id !== bound.id) {
    process.stderr.write(`[workflow] 角色 ${role} 绑定在 ${bound.id}，不能在 ${owned.id} 提交\n`);
    return 1;
  }

  const files = stagedFiles(owned.abs);
  if (files.length === 0) return 0;

  const repos = wf.repoRefs().map((r) => ({ id: r.id, abs: r.abs }));
  const aclRepoId = bound ? bound.id : owned.id;
  const aclRepoAbs = bound ? bound.abs : owned.abs;
  const violations: string[] = [];

  for (const f of files) {
    if (isMachineManagedFile(f)) continue; // tools update these themselves
    const abs = path.join(owned.abs, f);
    const d = checkAcl(role, abs, wf.root, aclRepoId, aclRepoAbs, repos);
    if (!d.allowed) violations.push(`${f}: ${d.reason}`);
  }

  // TODO-declared file list, when a current milestone exists
  const st = wf.repoState(owned.id);
  const m = st.currentMilestone;
  if (m?.todoFile) {
    const todo = path.join(wf.root, m.todoFile);
    const todoDoc = parseTodoSafe(todo);
    if (todoDoc?.allowedFiles.length) {
      for (const f of files) {
        if (isMachineManagedFile(f)) continue;
        if (!todoDoc.allowedFiles.some((a) => matchGlob(f, a.replace(/^\.\//, '')))) {
          violations.push(`${f}: 不在 ${m.id} 的「影响文件」清单内`);
        }
      }
    }
  }

  if (violations.length) {
    process.stderr.write(
      '[workflow] pre-commit scope 检查未通过:\n' +
        violations.map((v) => `  - ${v}`).join('\n') +
        '\n（用户可 WF_ALLOW_COMMIT=1 或 --no-verify 绕过）\n',
    );
    return 1;
  }

  process.stderr.write(
    `[workflow] scope 检查通过：${files.length} 个文件 (${st.git.branch}@${st.git.shortHead})\n`,
  );
  return 0;
}

function parseTodoSafe(p: string) {
  try {
    return parseTodo(p);
  } catch {
    return null;
  }
}
