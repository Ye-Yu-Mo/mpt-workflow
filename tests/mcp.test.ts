import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildTools, invokeTool } from '../src/mcp/server.js';
import { init } from '../src/core/init.js';
import { Workflow } from '../src/core/workflow.js';

const CLI = path.resolve(process.cwd(), 'dist/cli.js');

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mcp-'));
  const abs = path.join(root, 'repo-a');
  fs.mkdirSync(path.join(abs, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(abs, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(abs, 'PLAN.md'),
    '# PLAN: repo-a\n\n| M | 名称 |\n|---|---|\n| M1 | first |\n',
  );
  fs.writeFileSync(
    path.join(abs, 'TODO-M1.md'),
    `# TODO-M1: first

> 状态：待实现　受验 SHA：实现完成后回填

## 0. 边界

- **影响文件**：
  - \`src/lib.rs\`

## 3. 验收标准（可执行）

- [ ] echo 通过
`,
  );
  fs.writeFileSync(path.join(abs, 'src/lib.rs'), 'fn f() {}\n');
  git(abs, ['init', '-q']);
  git(abs, ['config', 'user.email', 't@example.com']);
  git(abs, ['config', 'user.name', 't']);
  git(abs, ['add', '-A']);
  git(abs, ['commit', '-qm', 'init']);
  init({ root, program: 'mcp-test', repos: ['repo-a'], adopt: true });
  const wf = new Workflow(root);
  return { root, abs, wf };
}

type Caller = (name: string, args?: Record<string, unknown>) => Promise<{
  text: string;
  isError: boolean;
}>;

function caller(wf: Workflow, role: 'main' | 'plan' | 'todo' | 'user'): Caller {
  const tools = buildTools({ root: wf.root });
  const ctx = { wf, role, repo: 'repo-a' };
  return async (name, args = {}) => {
    const out = await invokeTool(tools, name, args, ctx);
    if (typeof out === 'string') return { text: out, isError: false };
    return { text: out.content.map((c) => c.text).join('\n'), isError: out.isError };
  };
}

test('message tools through the MCP layer', async () => {
  const { wf } = fixture();
  const todo = caller(wf, 'todo');
  const plan = caller(wf, 'plan');
  const main = caller(wf, 'main');

  // todo -> main question is denied by the send ACL
  const denied = await todo('send_message', { to: 'main', kind: 'question', subject: 'x' });
  assert.equal(denied.isError, true);
  assert.match(denied.text, /ACL/);

  // todo -> plan event works
  const sent = await todo('send_message', {
    to: 'plan',
    kind: 'event',
    subject: 'please review',
  });
  assert.ok(!sent.isError, sent.text);

  const inbox = await plan('inbox', {});
  assert.match(inbox.text, /please review/);
  const id = /(msg-\d{8}-\d{6}-[a-z0-9]{4})/.exec(inbox.text)?.[1];
  assert.ok(id, 'message id parsed');

  const ack = await plan('ack_message', { id, note: 'done' });
  assert.ok(!ack.isError, ack.text);
  assert.match(ack.text, /已 ack/);

  // wait_message returns immediately when something is unread
  await todo('send_message', { to: 'plan', kind: 'event', subject: 'second' });
  const waited = await plan('wait_message', { timeout_ms: 1500 });
  assert.match(waited.text, /收到消息/);

  // broadcast is main-only
  const b1 = await todo('broadcast', { subject: 'nope' });
  assert.equal(b1.isError, true);
  const b2 = await main('broadcast', { subject: 'all hands' });
  assert.ok(!b2.isError, b2.text);
  assert.match(b2.text, /已广播/);
});

test('a blocking message blocks the recipient through the tool layer', async () => {
  const { wf } = fixture();
  const plan = caller(wf, 'plan');
  const todo = caller(wf, 'todo');

  const sent = await plan('send_message', {
    to: 'todo',
    kind: 'question',
    subject: 'stop and read this',
    blocking: true,
  });
  assert.ok(!sent.isError, sent.text);

  const blocked = await todo('milestone_claim', { milestone: 'M1' });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /blocking 消息/);

  const id = /(msg-\d{8}-\d{6}-[a-z0-9]{4})/.exec(sent.text)?.[1];
  await todo('ack_message', { id });
  const ok = await todo('milestone_claim', { milestone: 'M1' });
  assert.ok(!ok.isError, ok.text);
});

test('full lifecycle through the MCP tool layer', async () => {
  const { root, abs, wf } = fixture();
  const plan = caller(wf, 'plan');
  const todo = caller(wf, 'todo');

  // role gating
  const badClaim = await plan('milestone_claim', { milestone: 'M1' });
  assert.equal(badClaim.isError, true);
  assert.match(badClaim.text, /不能调用 milestone_claim/);

  const st = await plan('status');
  assert.match(st.text, /todo_ready/);
  const next = await plan('next');
  assert.match(next.text, /todo/);

  // plan asks main; blocking question is visible
  const asked = await plan('ask', {
    to: 'main',
    context: '需要用哪个版本？',
    options: ['A: v1', 'B: v2'],
    blocking: true,
  });
  assert.match(asked.text, /Q-001/);
  const qs = await plan('questions', {});
  assert.match(qs.text, /Q-001/);
  assert.match(qs.text, /blocking/);

  // main answers and the asker closes
  const main = caller(wf, 'main');
  const ans = await main('answer', { id: 'Q-001', answer: '用 A', resolution: 'PLAN §3' });
  assert.ok(!ans.isError, ans.text);
  const closed = await plan('close', { id: 'Q-001' });
  assert.ok(!closed.isError, closed.text);
  assert.equal(wf.findQuestion('Q-001')?.status, 'closed');

  // todo: claim -> evidence -> complete
  const claim = await todo('milestone_claim', { milestone: 'M1' });
  assert.ok(!claim.isError, claim.text);
  assert.match(claim.text, /implementing/);

  const badAccept = await todo('milestone_accept', { milestone: 'M1' });
  assert.equal(badAccept.isError, true);

  // complete without evidence must fail
  const early = await todo('milestone_complete', { milestone: 'M1' });
  assert.equal(early.isError, true);
  assert.match(early.text, /没有任何证据/);

  const ev = await todo('evidence_run', {
    milestone: 'M1',
    command: 'echo hello-from-evidence',
  });
  assert.ok(!ev.isError, ev.text);
  assert.match(ev.text, /exit=0/);

  const done = await todo('milestone_complete', { milestone: 'M1' });
  assert.match(done.text, /review/);

  // plan accepts
  const acc = await plan('milestone_accept', { milestone: 'M1', note: 'ok' });
  assert.ok(!acc.isError, acc.text);
  assert.match(acc.text, /已验收/);
  assert.equal(wf.milestone('repo-a', 'M1').status, 'accepted');

  // commit: request -> user approval (out of band) -> commit
  fs.writeFileSync(path.join(abs, 'src/lib.rs'), 'fn f() { 1 }\n');
  const req = await plan('commit_request', { message: 'feat(M1): first' });
  assert.ok(!req.isError, req.text);
  const id = /审批已创建:\s*(\S+)/.exec(req.text)?.[1];
  assert.ok(id, 'approval id parsed');

  const before = await plan('commit', { approval: id });
  assert.equal(before.isError, true);
  assert.match(before.text, /尚未由用户批准/);

  execFileSync(process.execPath, [CLI, 'approve', id, '--root', root], { encoding: 'utf8' });

  const committed = await plan('commit', { approval: id });
  assert.ok(!committed.isError, committed.text);
  assert.match(committed.text, /已提交/);

  const log = git(abs, ['log', '--oneline', '-1']);
  assert.match(log, /feat\(M1\): first/);

  const again = await plan('commit', { approval: id });
  assert.equal(again.isError, true);
});

test('todo agent is blocked by an open blocking question', async () => {
  const { abs, wf } = fixture();
  fs.appendFileSync(
    path.join(abs, 'docs/agent-questions.md'),
    `\n## Q-009 [open] to: PLAN\n- from: TODO\n- date: 2026-11-24\n- blocking: yes\n- context: stop\n- answer:\n- resolution:\n`,
  );
  assert.equal(wf.programStatus().blockingQuestions.length, 1);

  const input = JSON.stringify({
    cwd: abs,
    tool_name: 'Bash',
    tool_input: { command: 'cargo build' },
  });
  try {
    execFileSync(process.execPath, [CLI, 'hook', 'pretool'], {
      input,
      cwd: abs,
      env: { ...process.env, WF_ROLE: 'todo', WF_REPO: 'repo-a' },
      encoding: 'utf8',
    });
    assert.fail('hook should have blocked');
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /阻塞问题未回答/);
  }
});

test('pretool hook blocks plan writing source and todo writing PLAN', async () => {
  const { abs } = fixture();
  const run = (role: string, tool: string, input: Record<string, unknown>) => {
    try {
      execFileSync(process.execPath, [CLI, 'hook', 'pretool'], {
        input: JSON.stringify({ cwd: abs, tool_name: tool, tool_input: input }),
        cwd: abs,
        env: { ...process.env, WF_ROLE: role, WF_REPO: 'repo-a' },
        encoding: 'utf8',
      });
      return 0;
    } catch (e) {
      return (e as { status: number }).status;
    }
  };

  assert.equal(run('plan', 'Write', { file_path: path.join(abs, 'src/lib.rs') }), 2);
  assert.equal(run('plan', 'Write', { file_path: path.join(abs, 'PLAN.md') }), 0);
  assert.equal(run('todo', 'Write', { file_path: path.join(abs, 'PLAN.md') }), 2);
  assert.equal(run('todo', 'Write', { file_path: path.join(abs, 'src/lib.rs') }), 0);
  assert.equal(run('todo', 'Bash', { command: 'git push origin main' }), 2);
});
