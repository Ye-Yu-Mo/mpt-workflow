import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkAcl } from '../src/core/acl.js';
import { parseTodo, setTodoStatus } from '../src/core/docs.js';
import { gitInfo, workingTreeHash } from '../src/core/git.js';
import { matchGlob } from '../src/core/glob.js';
import { init } from '../src/core/init.js';
import {
  appendQuestion,
  nextQuestionId,
  parseQuestionsFile,
  updateQuestion,
} from '../src/core/questions.js';
import { createApproval, readApproval, writeApproval } from '../src/core/state.js';
import { Workflow } from '../src/core/workflow.js';

function sh(cwd: string, cmd: string, args: string[]) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}

function makeRepo(
  root: string,
  id: string,
  opts: { plan?: boolean; todos?: Record<string, string> } = {},
) {
  const abs = path.join(root, id);
  fs.mkdirSync(path.join(abs, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(abs, 'src'), { recursive: true });
  if (opts.plan !== false) {
    fs.writeFileSync(
      path.join(abs, 'PLAN.md'),
      `# PLAN: ${id}\n\n## 5. 里程碑总览\n\n| M | 名称 | 目标 |\n|---|---|---|\n| M1 | 第一步 | x |\n| M2 | 第二步 | y |\n`,
    );
  }
  for (const [name, body] of Object.entries(opts.todos || {})) {
    fs.writeFileSync(path.join(abs, name), body);
  }
  fs.writeFileSync(path.join(abs, 'src/lib.rs'), 'fn f() {}\n');
  sh(abs, 'git', ['init', '-q']);
  sh(abs, 'git', ['config', 'user.email', 't@example.com']);
  sh(abs, 'git', ['config', 'user.name', 't']);
  sh(abs, 'git', ['add', '-A']);
  sh(abs, 'git', ['commit', '-qm', 'init']);
  return abs;
}

function todoBody(id: string, status: string, files: string[] = ['src/lib.rs']) {
  return `# TODO-${id}: task ${id}

> 对应 PLAN：[PLAN.md](PLAN.md) v1　程序阶段：\`P1\`　仓库里程碑：\`${id}\`
> 作者：PLAN agent　状态：${status}　受验 SHA：实现完成后回填

## 0. 边界

- **影响文件**：
${files.map((f) => `  - \`${f}\``).join('\n')}

## 3. 验收标准（可执行）

- [ ] 构建通过
- [ ] 测试通过
`;
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  makeRepo(root, 'repo-a', { todos: { 'TODO-M1.md': todoBody('M1', '待实现') } });
  makeRepo(root, 'repo-b', { plan: false });
  init({ root, program: 'test', repos: ['repo-a', 'repo-b'], adopt: true });
  const wf = new Workflow(root);
  return { root, wf };
}

/* --------------------------------- docs --------------------------------- */

test('parseTodo understands bold/annotated status labels', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-doc-'));
  const f = path.join(dir, 'TODO-M1.md');
  fs.writeFileSync(
    f,
    '# TODO-M1: x\n\n> 作者：a　状态：**已验收（文档评审通过；提交后回填受验 SHA）**\n> 受验基线：提交 `69d6df4`（docs）\n',
  );
  const d = parseTodo(f);
  assert.equal(d?.status, 'accepted');
  assert.equal(d?.sha, '69d6df4');
});

test('setTodoStatus preserves style', () => {
  const src = '# TODO-M1: x\n\n> 状态：待实现　受验 SHA：x\n';
  assert.match(setTodoStatus(src, 'implementing'), /状态：实现中/);
  assert.match(setTodoStatus(src, 'accepted'), /状态：已验收/);
});

/* ------------------------------- questions ------------------------------ */

test('question lifecycle: ask, answer, close', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-q-'));
  const f = path.join(dir, 'agent-questions.md');
  appendQuestion(f, {
    id: nextQuestionId([]),
    to: 'main',
    from: 'plan',
    blocking: true,
    context: 'line one\nline two',
    options: [
      { id: 'A', text: 'do a' },
      { id: 'B', text: 'do b' },
    ],
    recommendation: 'A',
  });
  let qs = parseQuestionsFile(f);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].id, 'Q-001');
  assert.equal(qs[0].blocking, true);
  assert.equal(qs[0].status, 'open');
  assert.equal(qs[0].options.length, 2);
  assert.match(qs[0].context, /line two/);

  updateQuestion(f, 'Q-001', { status: 'answered', answer: 'go with A', resolution: 'PLAN §3' });
  qs = parseQuestionsFile(f);
  assert.equal(qs[0].status, 'answered');
  assert.equal(qs[0].answer, 'go with A');
  assert.equal(qs[0].resolution, 'PLAN §3');

  updateQuestion(f, 'Q-001', { status: 'closed' });
  assert.equal(parseQuestionsFile(f)[0].status, 'closed');
});

test('nextQuestionId does not reuse closed ids', () => {
  assert.equal(nextQuestionId([{ id: 'Q-001' }, { id: 'Q-007' }]), 'Q-008');
  assert.equal(nextQuestionId([{ id: 'Q-001' }, { id: 'Q-repo-a-002' }], 'repo-a'), 'Q-repo-a-003');
  assert.equal(nextQuestionId([], 'root'), 'Q-root-001');
});

/* --------------------------------- acl ---------------------------------- */

test('acl: roles cannot cross boundaries', () => {
  const root = '/r';
  const repo = '/r/repo-a';
  const repos = [
    { id: 'repo-a', abs: repo },
    { id: 'repo-b', abs: '/r/repo-b' },
  ];
  assert.equal(checkAcl('plan', '/r/repo-a/PLAN.md', root, 'repo-a', repo, repos).allowed, true);
  assert.equal(checkAcl('plan', '/r/repo-a/src/x.rs', root, 'repo-a', repo, repos).allowed, false);
  assert.equal(
    checkAcl('plan', '/r/docs/decisions.md', root, 'repo-a', repo, repos).allowed,
    false,
  );
  assert.equal(checkAcl('plan', '/r/repo-b/PLAN.md', root, 'repo-a', repo, repos).allowed, false);
  assert.equal(checkAcl('todo', '/r/repo-a/src/x.rs', root, 'repo-a', repo, repos).allowed, true);
  assert.equal(checkAcl('todo', '/r/repo-a/PLAN.md', root, 'repo-a', repo, repos).allowed, false);
  assert.equal(checkAcl('todo', '/r/docs/x.md', root, 'repo-a', repo, repos).allowed, false);
  assert.equal(checkAcl('main', '/r/docs/x.md', root, 'repo-a', repo, repos).allowed, true);
  assert.equal(checkAcl('main', '/r/repo-a/src/x.rs', root, 'repo-a', repo, repos).allowed, false);
  assert.equal(checkAcl('user', '/r/repo-a/src/x.rs', root, 'repo-a', repo, repos).allowed, true);
});

/* ------------------------------ state machine --------------------------- */

test('milestone transitions and acceptance gates', async () => {
  const { wf } = setup();

  // claim requires a TODO; M1 has one, M2 does not.
  assert.equal(wf.milestone('repo-a', 'M1').status, 'todo_ready');
  assert.throws(() => wf.claim('repo-a', 'M2', 'todo'), /缺少 TODO/);

  wf.claim('repo-a', 'M1', 'todo');
  assert.equal(wf.milestone('repo-a', 'M1').status, 'implementing');

  // complete requires evidence
  assert.throws(() => wf.complete('repo-a', 'M1', 'todo'), /没有任何证据/);

  const ev = await wf.runEvidence({
    repoId: 'repo-a',
    milestone: 'M1',
    command: 'echo ok',
    role: 'todo',
  });
  assert.equal(ev.exitCode, 0);
  assert.match(ev.evidenceFile, /docs\/evidence\/M1\.jsonl/);

  wf.complete('repo-a', 'M1', 'todo');
  assert.equal(wf.milestone('repo-a', 'M1').status, 'review');

  // implementer role cannot accept
  assert.throws(() => wf.accept('repo-a', 'M1', 'todo'), /只有 PLAN/);

  const m = wf.accept('repo-a', 'M1', 'plan');
  assert.equal(m.status, 'accepted');
  const text = fs.readFileSync(path.join(wf.root, 'repo-a/TODO-M1.md'), 'utf8');
  assert.match(text, /## 验收记录/);
  assert.match(text, /通过/);
  assert.doesNotMatch(text, /## 证据记录/, 'evidence no longer dirties the TODO');
  const evidenceText = fs.readFileSync(path.join(wf.root, 'repo-a/docs/evidence/M1.jsonl'), 'utf8');
  assert.match(evidenceText, /echo ok/);
});

test('failing evidence forces a reject and a rework loop', async () => {
  const { wf } = setup();
  wf.claim('repo-a', 'M1', 'todo');
  const bad = await wf.runEvidence({
    repoId: 'repo-a',
    milestone: 'M1',
    command: 'exit 3',
    role: 'todo',
  });
  assert.equal(bad.exitCode, 3);
  wf.complete('repo-a', 'M1', 'todo');
  assert.throws(() => wf.accept('repo-a', 'M1', 'plan'), /最新证据|没有成功的证据/);
  const m = wf.reject('repo-a', 'M1', 'plan', '测试失败，先修');
  assert.equal(m.status, 'rejected');
  assert.throws(() => wf.reject('repo-a', 'M1', 'plan', ''), /必须写原因/);
});

test('evidence is appended to the tracked JSONL file, not the TODO', async () => {
  const { wf } = setup();
  const repoAbs = path.join(wf.root, 'repo-a');
  wf.claim('repo-a', 'M1', 'todo');
  await wf.runEvidence({ repoId: 'repo-a', milestone: 'M1', command: 'echo first', role: 'todo' });
  wf.complete('repo-a', 'M1', 'todo');
  wf.accept('repo-a', 'M1', 'plan');

  await wf.runEvidence({ repoId: 'repo-a', milestone: 'M1', command: 'echo second', role: 'todo' });

  const m = wf.milestone('repo-a', 'M1');
  assert.equal(m.evidence.length, 2);
  assert.ok(m.evidence.some((e) => e.command === 'echo second'));
  const file = path.join(repoAbs, 'docs/evidence/M1.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /echo second/);
  const text = fs.readFileSync(path.join(repoAbs, 'TODO-M1.md'), 'utf8');
  assert.doesNotMatch(text, /echo second/);
});

test('mutations refuse to overwrite an unreadable TODO', {
  skip: typeof process.getuid === 'function' && process.getuid() === 0,
}, () => {
  const { wf } = setup();
  const file = path.join(wf.root, 'repo-a/TODO-M1.md');
  fs.chmodSync(file, 0o000);
  try {
    assert.throws(() => wf.claim('repo-a', 'M1', 'todo'), /EACCES|permission denied/i);
  } finally {
    fs.chmodSync(file, 0o644);
  }
  assert.match(fs.readFileSync(file, 'utf8'), /TODO-M1/);
});

test('accepted milestone becomes committed once its TODO record is committed', async () => {
  const { wf } = setup();
  const repoAbs = path.join(wf.root, 'repo-a');
  wf.claim('repo-a', 'M1', 'todo');
  await wf.runEvidence({ repoId: 'repo-a', milestone: 'M1', command: 'echo ok', role: 'todo' });
  wf.complete('repo-a', 'M1', 'todo');
  wf.accept('repo-a', 'M1', 'plan');
  assert.equal(wf.milestone('repo-a', 'M1').status, 'accepted');

  fs.writeFileSync(path.join(repoAbs, 'src/lib.rs'), 'fn f() { 1 }\n');
  const req = wf.requestCommit({ repoId: 'repo-a', message: 'feat(M1): done', role: 'plan' });
  wf.approve(req.approval.id);
  wf.commitApproved({ repoId: 'repo-a', approvalId: req.approval.id, role: 'plan' });

  assert.equal(wf.milestone('repo-a', 'M1').status, 'committed');
});

test('blocking question surfaces in status and next', () => {
  const { wf } = setup();
  const file = path.join(wf.root, 'repo-a/docs/agent-questions.md');
  appendQuestion(file, {
    id: 'Q-001',
    to: 'PLAN',
    from: 'todo',
    blocking: true,
    context: 'ambiguous API',
  });
  const st = wf.programStatus();
  assert.equal(st.blockingQuestions.length, 1);
  const repo = st.repos.find((r) => r.id === 'repo-a')!;
  assert.ok(repo.problems.some((p) => p.includes('Q-001')));
  assert.ok(st.next.some((n) => n.actor === 'plan' && n.question === 'Q-001'));
});

test('milestone mutations require the active repo', () => {
  const { wf } = setup();
  wf.setActiveRepo('repo-b');
  assert.throws(() => wf.claim('repo-a', 'M1', 'todo'), /不是 active_repo/);
  wf.setActiveRepo('repo-a');
  assert.equal(wf.claim('repo-a', 'M1', 'todo').status, 'implementing');
});

test('init --no-adopt still excludes generated config from git', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-noadopt-'));
  const repo = path.join(root, 'repo-a');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/lib.rs'), 'fn f() {}\n');
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 't@example.com'],
    ['config', 'user.name', 't'],
    ['add', '-A'],
    ['commit', '-qm', 'init'],
  ]) {
    sh(repo, 'git', args);
  }
  init({ root, program: 'no-adopt', repos: ['repo-a'], adopt: false });
  const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.doesNotMatch(status, /\.mcp\.json/);
  assert.doesNotMatch(status, /\.claude\//);
});

/* ------------------------------- scope ---------------------------------- */

test('scope check flags files outside TODO list and ACL', () => {
  const { wf } = setup();
  wf.claim('repo-a', 'M1', 'todo');
  const repoAbs = path.join(wf.root, 'repo-a');
  fs.writeFileSync(path.join(repoAbs, 'src/lib.rs'), 'fn f() { 1 }\n');
  fs.writeFileSync(path.join(repoAbs, 'src/extra.rs'), 'fn g() {}\n');

  const s = wf.scopeCheck('repo-a', 'M1', 'todo');
  assert.equal(s.pass, false, 'todo out-of-scope files block the commit gate');
  assert.equal(s.violations.length, 0, 'ACL allows src/**, so no ACL violation');
  assert.ok(s.warnings.some((w) => w.includes('src/extra.rs')));

  // plan role may not touch src at all — only when ACL enforcement is requested
  const s2 = wf.scopeCheck('repo-a', 'M1', 'plan', { enforceAcl: true });
  assert.equal(s2.pass, false);
  // reviewers default to the implementer's view
  const s3 = wf.scopeCheck('repo-a', 'M1', 'plan');
  assert.equal(s3.pass, true);
});

/* ------------------------------- commit --------------------------------- */

test('commit requires an approved token bound to the exact tree', () => {
  const { wf } = setup();
  const repoAbs = path.join(wf.root, 'repo-a');

  fs.writeFileSync(path.join(repoAbs, 'src/lib.rs'), 'fn f() { 2 }\n');
  const req = wf.requestCommit({ repoId: 'repo-a', message: 'feat: x', role: 'todo' });
  assert.throws(
    () => wf.commitApproved({ repoId: 'repo-a', approvalId: req.approval.id, role: 'todo' }),
    /尚未由用户批准/,
  );

  wf.approve(req.approval.id);
  const note = wf.msgs.list().find((m) => m.refs.approval_id === req.approval.id);
  assert.equal(note?.status, 'acked');
  assert.ok(note?.read_at, 'approving acks and reads the approval notification');
  const res = wf.commitApproved({ repoId: 'repo-a', approvalId: req.approval.id, role: 'todo' });
  assert.ok('head' in res && res.head);
  assert.throws(
    () => wf.commitApproved({ repoId: 'repo-a', approvalId: req.approval.id, role: 'todo' }),
    /已在|已使用/,
  );

  // a branch advance after the request invalidates the base
  fs.writeFileSync(path.join(repoAbs, 'src/lib.rs'), 'fn f() { 2.5 }\n');
  const req2 = wf.requestCommit({ repoId: 'repo-a', message: 'feat: y', role: 'todo' });
  wf.approve(req2.approval.id);
  sh(repoAbs, 'git', ['commit', '--allow-empty', '-m', 'advance']);
  assert.throws(
    () => wf.commitApproved({ repoId: 'repo-a', approvalId: req2.approval.id, role: 'todo' }),
    /分支在请求后已前进/,
  );
});

test('approval ids are short and support unique prefixes', () => {
  const { wf } = setup();
  const repoAbs = path.join(wf.root, 'repo-a');
  fs.writeFileSync(path.join(repoAbs, 'src/lib.rs'), 'fn f() { 1 }\n');
  const req = wf.requestCommit({ repoId: 'repo-a', message: 'feat: short', role: 'todo' });
  assert.ok(req.approval.id.length <= 20, req.approval.id);
  const prefix = req.approval.id.slice(0, 8);
  const approved = wf.approve(prefix);
  assert.equal(approved.id, req.approval.id);
  const res = wf.commitApproved({ repoId: 'repo-a', approvalId: prefix, role: 'todo' });
  assert.ok('head' in res && res.head);
});

test('a canceled approval cannot be approved or committed', () => {
  const { wf } = setup();
  const repoAbs = path.join(wf.root, 'repo-a');
  fs.writeFileSync(path.join(repoAbs, 'src/lib.rs'), 'fn f() { 1 }\n');
  const req = wf.requestCommit({ repoId: 'repo-a', message: 'feat: cancel', role: 'todo' });
  wf.cancelApproval(req.approval.id, 'user', 'changed my mind');
  const stored = wf.approvals().find((a) => a.id === req.approval.id);
  assert.ok(stored?.canceled_at);
  assert.equal(stored?.cancel_reason, 'changed my mind');
  assert.throws(() => wf.approve(req.approval.id), /已.*取消/);
});

test('commit_request files selects a subset and leaves other changes alone', () => {
  const { wf } = setup();
  const repoAbs = path.join(wf.root, 'repo-a');
  fs.writeFileSync(path.join(repoAbs, 'src/lib.rs'), 'fn f() { 1 }\n');
  fs.appendFileSync(path.join(repoAbs, 'PLAN.md'), '\n> planning note\n');
  const req = wf.requestCommit({
    repoId: 'repo-a',
    message: 'feat: only source',
    role: 'todo',
    files: ['src/lib.rs'],
  });
  assert.deepEqual(req.files, ['src/lib.rs']);
  // The real index is untouched by the request.
  assert.equal(sh(repoAbs, 'git', ['diff', '--cached', '--name-only']).trim(), '');

  wf.approve(req.approval.id);
  wf.commitApproved({ repoId: 'repo-a', approvalId: req.approval.id, role: 'todo' });
  assert.match(sh(repoAbs, 'git', ['show', 'HEAD:src/lib.rs']), /fn f\(\) \{ 1 \}/);
  assert.match(fs.readFileSync(path.join(repoAbs, 'PLAN.md'), 'utf8'), /planning note/);
  const status = sh(repoAbs, 'git', ['status', '--porcelain']);
  assert.match(status, /PLAN\.md/);
  assert.doesNotMatch(status, /src\/lib\.rs/);
});

test('pre-commit trusts the approved snapshot over the committer ACL', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-hook-approval-'));
  makeRepo(root, 'repo-a', { todos: { 'TODO-M1.md': todoBody('M1', '待实现') } });
  init({ root, program: 'hook-approval', repos: ['repo-a'], adopt: true, installHooks: true });
  const wf = new Workflow(root);
  const repoAbs = path.join(root, 'repo-a');
  fs.writeFileSync(path.join(repoAbs, 'src/lib.rs'), 'fn f() { 1 }\n');
  const req = wf.requestCommit({ repoId: 'repo-a', message: 'feat: approved', role: 'todo' });
  wf.approve(req.approval.id);
  // main would normally be denied writing source files; the approval covers it.
  wf.commitApproved({ repoId: 'repo-a', approvalId: req.approval.id, role: 'main' });
  assert.equal(sh(repoAbs, 'git', ['log', '-1', '--format=%s']).trim(), 'feat: approved');
});

test('commit scope follows the requesting role, not the committer', () => {
  const { wf } = setup();
  const repoAbs = path.join(wf.root, 'repo-a');
  fs.writeFileSync(path.join(repoAbs, 'src/lib.rs'), 'fn f() { 1 }\n');
  fs.writeFileSync(path.join(repoAbs, 'src/extra.rs'), 'fn g() {}\n');
  const req = wf.requestCommit({ repoId: 'repo-a', message: 'feat: main scope', role: 'main' });
  assert.equal(req.approval.requested_by, 'main');
  wf.approve(req.approval.id);
  // A todo session happens to execute the commit; the approval was requested
  // by main, so main's scope (not todo's) decides.
  wf.commitApproved({ repoId: 'repo-a', approvalId: req.approval.id, role: 'todo' });
  assert.match(sh(repoAbs, 'git', ['show', 'HEAD:src/extra.rs']), /fn g/);
});

test('commit_request rejects files outside the TODO file list', () => {
  const { wf } = setup();
  const repoAbs = path.join(wf.root, 'repo-a');
  fs.writeFileSync(path.join(repoAbs, 'src/extra.rs'), 'fn g() {}\n');
  assert.throws(
    () => wf.requestCommit({ repoId: 'repo-a', message: 'feat: extra', role: 'todo' }),
    /影响文件/,
  );
});

test('plan commits are not limited by the implementation file list', () => {
  const { wf } = setup();
  fs.writeFileSync(path.join(wf.root, 'repo-a/docs/notes.md'), '# notes\n');
  const req = wf.requestCommit({ repoId: 'repo-a', message: 'docs: notes', role: 'plan' });
  assert.ok(req.approval.id);
});

test('working tree hash changes with content', () => {
  const { root } = setup();
  const abs = path.join(root, 'repo-a');
  const before = workingTreeHash(abs);
  fs.writeFileSync(path.join(abs, 'src/lib.rs'), 'fn f() { 99 }\n');
  assert.notEqual(workingTreeHash(abs), before);
});

/* ------------------------------- init ----------------------------------- */

test('init is idempotent and does not overwrite', () => {
  const { root } = setup();
  const planBefore = fs.readFileSync(path.join(root, 'repo-a/PLAN.md'), 'utf8');
  const qBefore = fs.readFileSync(path.join(root, 'repo-a/docs/agent-questions.md'), 'utf8');
  init({ root, program: 'test', repos: ['repo-a', 'repo-b'], adopt: true });
  assert.equal(fs.readFileSync(path.join(root, 'repo-a/PLAN.md'), 'utf8'), planBefore);
  assert.equal(fs.readFileSync(path.join(root, 'repo-a/docs/agent-questions.md'), 'utf8'), qBefore);
});

test('approval ids cannot escape the approvals directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ap-'));
  const a = createApproval(root, { repo: 'x', tree_hash: 'h', message: 'm', files: [] });
  assert.equal(readApproval(root, a.id)?.id, a.id);
  assert.equal(readApproval(root, '../x'), null);
  assert.equal(readApproval(root, '..%2F..%2Fx'), null);
  assert.throws(() => writeApproval(root, { ...a, id: '../../x' }), /非法审批 id/);
});

test('acl resolves symlinks before scope checks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-acl-link-'));
  const repo = path.join(root, 'repo-a');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.symlinkSync(path.join(repo, 'src'), path.join(repo, 'docs', 'evil'), 'dir');
  const d = checkAcl('plan', path.join(repo, 'docs', 'evil', 'pwn.ts'), root, 'repo-a', repo, [
    { id: 'repo-a', abs: repo },
  ]);
  assert.equal(d.allowed, false);
});

test('accept requires the latest evidence to pass', async () => {
  const { wf } = setup();
  wf.claim('repo-a', 'M1', 'todo');
  await wf.runEvidence({ repoId: 'repo-a', milestone: 'M1', command: 'exit 0', role: 'todo' });
  await wf.runEvidence({ repoId: 'repo-a', milestone: 'M1', command: 'exit 7', role: 'todo' });
  wf.complete('repo-a', 'M1', 'todo');
  assert.throws(() => wf.accept('repo-a', 'M1', 'plan'), /最新证据/);
  await wf.runEvidence({ repoId: 'repo-a', milestone: 'M1', command: 'exit 0', role: 'todo' });
  assert.equal(wf.accept('repo-a', 'M1', 'plan').status, 'accepted');
});

test('commit scope uses the accepted milestone, not the next one', async () => {
  const { wf } = setup();
  const repoAbs = path.join(wf.root, 'repo-a');
  fs.writeFileSync(
    path.join(repoAbs, 'TODO-M2.md'),
    '# TODO-M2: second\n\n> 状态：待实现\n\n- **影响文件**：\n  - `src/other.rs`\n',
  );
  wf.claim('repo-a', 'M1', 'todo');
  await wf.runEvidence({ repoId: 'repo-a', milestone: 'M1', command: 'echo ok', role: 'todo' });
  wf.complete('repo-a', 'M1', 'todo');
  wf.accept('repo-a', 'M1', 'plan');
  fs.writeFileSync(path.join(repoAbs, 'src/lib.rs'), 'fn f() { 2 }\n');

  // M2 is the current milestone, but M1 is the accepted one being committed.
  const req = wf.requestCommit({ repoId: 'repo-a', message: 'feat(M1): ok', role: 'todo' });
  assert.equal(req.approval.milestone, 'M1');

  fs.writeFileSync(path.join(repoAbs, 'src/evil.rs'), 'fn evil() {}\n');
  assert.throws(
    () => wf.requestCommit({ repoId: 'repo-a', message: 'feat: evil', role: 'todo' }),
    /影响文件/,
  );
});

test('index changes after the request do not change the approved snapshot', () => {
  const { wf } = setup();
  const repoAbs = path.join(wf.root, 'repo-a');
  fs.writeFileSync(path.join(repoAbs, 'src/lib.rs'), 'fn f() { 1 }\n');
  const req = wf.requestCommit({ repoId: 'repo-a', message: 'feat: x', role: 'todo' });
  fs.writeFileSync(path.join(repoAbs, 'src/lib.rs'), 'fn f() { 2 }\n');
  sh(repoAbs, 'git', ['add', 'src/lib.rs']);
  wf.approve(req.approval.id);
  wf.commitApproved({ repoId: 'repo-a', approvalId: req.approval.id, role: 'todo' });
  // The reviewed snapshot (v1) is committed; the later staged v2 stays local.
  assert.match(sh(repoAbs, 'git', ['show', 'HEAD:src/lib.rs']), /fn f\(\) \{ 1 \}/);
  assert.match(fs.readFileSync(path.join(repoAbs, 'src/lib.rs'), 'utf8'), /fn f\(\) \{ 2 \}/);
  assert.match(sh(repoAbs, 'git', ['status', '--porcelain']), /src\/lib\.rs/);
});

test('worktree edits after the request are not part of the commit', () => {
  const { wf } = setup();
  const repoAbs = path.join(wf.root, 'repo-a');
  fs.writeFileSync(path.join(repoAbs, 'src/lib.rs'), 'fn f() { 1 }\n');
  const req = wf.requestCommit({ repoId: 'repo-a', message: 'feat: snapshot', role: 'todo' });
  // Later worktree edit, not staged.
  fs.writeFileSync(path.join(repoAbs, 'src/lib.rs'), 'fn f() { 2 }\n');
  wf.approve(req.approval.id);
  wf.commitApproved({ repoId: 'repo-a', approvalId: req.approval.id, role: 'todo' });
  assert.match(sh(repoAbs, 'git', ['show', 'HEAD:src/lib.rs']), /fn f\(\) \{ 1 \}/);
  assert.match(fs.readFileSync(path.join(repoAbs, 'src/lib.rs'), 'utf8'), /fn f\(\) \{ 2 \}/);
  assert.match(sh(repoAbs, 'git', ['status', '--porcelain']), /src\/lib\.rs/);
});

test('next asks the user to commit after acceptance', async () => {
  const { wf } = setup();
  wf.claim('repo-a', 'M1', 'todo');
  await wf.runEvidence({ repoId: 'repo-a', milestone: 'M1', command: 'echo ok', role: 'todo' });
  wf.complete('repo-a', 'M1', 'todo');
  wf.accept('repo-a', 'M1', 'plan');
  const next = wf.programStatus().next;
  assert.ok(next.some((n) => n.actor === 'user' && /commit/i.test(n.action)));
});

test('gitInfo parses rename entries without a phantom path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-rename-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/lib.rs'), 'fn f() {}\n');
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 't@example.com'],
    ['config', 'user.name', 't'],
    ['add', '-A'],
    ['commit', '-qm', 'init'],
  ]) {
    sh(repo, 'git', args);
  }
  sh(repo, 'git', ['mv', 'src/lib.rs', 'src/renamed.rs']);
  const info = gitInfo(repo);
  assert.deepEqual(info.changed, ['src/renamed.rs']);
});

test('parseTodo reads a bare 受验 SHA and 改什么 paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-doc2-'));
  const f = path.join(dir, 'TODO-M1.md');
  fs.writeFileSync(
    f,
    `# TODO-M1: x\n\n> 状态：待实现　受验 SHA：${'a'.repeat(40)}\n\n- **改什么**：\n  - \`src/foo.rs\`\n`,
  );
  const d = parseTodo(f);
  assert.equal(d?.sha, 'a'.repeat(40));
  assert.ok(d?.allowedFiles.includes('src/foo.rs'));
  assert.ok(!d?.allowedFiles.includes('/'));
});

test('parseTodo merges multiple file blocks, frontmatter and <!-- files -->', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-doc3-'));
  const f = path.join(dir, 'TODO-M1.md');
  fs.writeFileSync(
    f,
    `---
id: M1
status: todo_ready
files: [src/front.ts]
---
# TODO-M1: x

- **影响文件**：
  - \`src/a.ts\`
- **其他**：
  - 无关内容
- **影响文件**：
  - \`src/b.ts\`

<!-- files: ["src/comment.ts"] -->
`,
  );
  const d = parseTodo(f);
  assert.ok(d);
  assert.deepEqual(
    [...d.allowedFiles].sort(),
    ['src/a.ts', 'src/b.ts', 'src/comment.ts', 'src/front.ts'].sort(),
  );
});

test('scope globs match zero directories and single-character segments', () => {
  assert.equal(matchGlob('src/lib.rs', 'src/**/*.rs'), true);
  assert.equal(matchGlob('src/sub/lib.rs', 'src/**/*.rs'), true);
  assert.equal(matchGlob('src/a.rs', 'src/?.rs'), true);
  assert.equal(matchGlob('src/ab.rs', 'src/?.rs'), false);
});

test('re-claim after a reject notifies plan again', async () => {
  const { wf } = setup();
  wf.claim('repo-a', 'M1', 'todo');
  await wf.runEvidence({ repoId: 'repo-a', milestone: 'M1', command: 'echo ok', role: 'todo' });
  wf.complete('repo-a', 'M1', 'todo');
  wf.reject('repo-a', 'M1', 'plan', 'rework');
  wf.claim('repo-a', 'M1', 'todo');
  const notes = wf.msgs
    .forActor({ role: 'plan', repo: 'repo-a' }, { includeAcked: true })
    .filter((m) => m.subject.includes('开始实现'));
  assert.equal(notes.length, 2);
});
