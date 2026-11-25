import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { init } from '../src/core/init.js';
import { actorKey, canSend } from '../src/core/messages.js';
import { Workflow } from '../src/core/workflow.js';

const CLI = path.resolve(process.cwd(), 'dist/cli.js');

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-msg-'));
  const abs = path.join(root, 'repo-a');
  fs.mkdirSync(path.join(abs, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(abs, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(abs, 'PLAN.md'),
    '# PLAN: repo-a\n\n| M | 名称 |\n|---|---|\n| M1 | first |\n',
  );
  fs.writeFileSync(
    path.join(abs, 'TODO-M1.md'),
    `# TODO-M1: first\n\n> 状态：待实现\n\n- **影响文件**：\n  - \`src/lib.rs\`\n`,
  );
  fs.writeFileSync(path.join(abs, 'src/lib.rs'), 'fn f() {}\n');
  git(abs, ['init', '-q']);
  git(abs, ['config', 'user.email', 't@example.com']);
  git(abs, ['config', 'user.name', 't']);
  git(abs, ['add', '-A']);
  git(abs, ['commit', '-qm', 'init']);
  init({ root, program: 'msg-test', repos: ['repo-a'], adopt: true });
  return { root, abs, wf: new Workflow(root) };
}

/* --------------------------------- ACL ---------------------------------- */

test('message ACL matches the role matrix', () => {
  const plan = { role: 'plan' as const, repo: 'a' };
  const todo = { role: 'todo' as const, repo: 'a' };
  const otherTodo = { role: 'todo' as const, repo: 'b' };

  assert.equal(canSend(plan, { role: 'main' }, 'event').ok, true);
  assert.equal(canSend(plan, todo, 'event').ok, true);
  assert.equal(canSend(plan, otherTodo, 'event').ok, false);
  assert.equal(canSend(plan, { role: 'user' }, 'event').ok, false);
  assert.equal(canSend(plan, { role: 'user' }, 'alert').ok, true);

  assert.equal(canSend(todo, plan, 'question').ok, true);
  assert.equal(canSend(todo, { role: 'main' }, 'question').ok, false);
  assert.equal(canSend(todo, { role: 'main' }, 'alert').ok, true);

  assert.equal(canSend({ role: 'main' }, otherTodo, 'event').ok, true);
  assert.equal(canSend({ role: 'user' }, todo, 'event').ok, true);
  assert.equal(canSend({ role: 'system' }, { role: 'user' }, 'alert').ok, true);
});

test('send enforces ACL and body size', () => {
  const { wf } = fixture();
  assert.throws(
    () =>
      wf.msgs.send({
        from: { role: 'todo', repo: 'repo-a' },
        to: { role: 'main' },
        kind: 'question',
        subject: 'x',
      }),
    /ACL 拒绝/,
  );
  assert.throws(
    () =>
      wf.msgs.send({
        from: { role: 'todo', repo: 'repo-a' },
        to: { role: 'plan', repo: 'repo-a' },
        kind: 'question',
        subject: 'x',
        body: 'a'.repeat(33 * 1024),
      }),
    /32KB/,
  );
});

/* ------------------------------ delivery -------------------------------- */

test('offline delivery: queued -> unread on next bootstrap, then acked', () => {
  const { wf } = fixture();
  const main = { role: 'main' as const };

  // main has no presence -> message is queued
  const { message } = wf.msgs.send({
    from: { role: 'plan', repo: 'repo-a' },
    to: main,
    kind: 'event',
    subject: 'M1 accepted',
  });
  assert.equal(message.status, 'queued');

  // a fresh Workflow instance reads the same state (server restart)
  const wf2 = new Workflow(wf.root);
  assert.equal(wf2.msgs.get(message.id)?.status, 'queued');

  // main comes online
  wf2.msgs.ping(main);
  wf2.msgs.promoteQueued(main);
  assert.equal(wf2.msgs.get(message.id)?.status, 'unread');
  assert.equal(wf2.msgs.unreadCount(main), 1);

  wf2.msgs.ack(message.id, 'seen');
  assert.equal(wf2.msgs.unreadCount(main), 0);
  assert.equal(wf2.msgs.get(message.id)?.status, 'acked');
  assert.equal(wf2.msgs.get(message.id)?.ack_note, 'seen');
  assert.ok(wf2.msgs.get(message.id)?.read_at, 'ack implies read');
});

test('idempotency key produces one message', () => {
  const { wf } = fixture();
  const a = wf.msgs.send({
    from: { role: 'plan', repo: 'repo-a' },
    to: { role: 'main' },
    kind: 'event',
    subject: 'same',
    idempotency_key: 'k-1',
  });
  const b = wf.msgs.send({
    from: { role: 'plan', repo: 'repo-a' },
    to: { role: 'main' },
    kind: 'event',
    subject: 'same',
    idempotency_key: 'k-1',
  });
  assert.equal(a.message.id, b.message.id);
  assert.equal(b.duplicate, true);
  assert.equal(wf.msgs.list().length, 1);
});

/* ------------------------------- blocking ------------------------------- */

test('blocking message gates milestone transitions until acked', () => {
  const { wf } = fixture();
  const plan = { role: 'plan' as const, repo: 'repo-a' };
  const todo = { role: 'todo' as const, repo: 'repo-a' };

  const { message } = wf.msgs.send({
    from: todo,
    to: plan,
    kind: 'question',
    subject: 'which API?',
    blocking: true,
  });

  assert.throws(() => wf.claim('repo-a', 'M1', 'plan'), /blocking 消息/);

  wf.msgs.ack(message.id);
  const claimed = wf.claim('repo-a', 'M1', 'plan');
  assert.equal(claimed.status, 'implementing');
});

test('expired blocking message escalates to the user', () => {
  const { wf } = fixture();
  const { message } = wf.msgs.send({
    from: { role: 'todo', repo: 'repo-a' },
    to: { role: 'plan', repo: 'repo-a' },
    kind: 'question',
    subject: 'stale',
    blocking: true,
    expires_at: new Date(Date.now() - 1000).toISOString(),
  });
  wf.programStatus(); // triggers expireDue
  assert.equal(wf.msgs.get(message.id)?.status, 'expired');
  const escalated = wf.msgs.forActor({ role: 'user' }, { limit: 10 });
  assert.ok(escalated.some((m) => m.kind === 'alert' && m.refs.message_id === message.id));
});

/* --------------------------- automatic events --------------------------- */

test('milestone lifecycle emits notifications', () => {
  const { wf } = fixture();

  wf.claim('repo-a', 'M1', 'todo');
  const afterClaim = wf.msgs.forActor({ role: 'plan', repo: 'repo-a' });
  assert.ok(afterClaim.some((m) => m.subject.includes('开始实现')));

  // evidence + complete
  return (async () => {
    await wf.runEvidence({
      repoId: 'repo-a',
      milestone: 'M1',
      command: 'echo ok',
      role: 'todo',
    });
    wf.complete('repo-a', 'M1', 'todo');
    const planInbox = wf.msgs.forActor({ role: 'plan', repo: 'repo-a' });
    assert.ok(planInbox.some((m) => m.subject.includes('待验收')));

    wf.accept('repo-a', 'M1', 'plan', { note: 'ok' });
    const mainInbox = wf.msgs.forActor({ role: 'main' });
    const userInbox = wf.msgs.forActor({ role: 'user' });
    assert.ok(mainInbox.some((m) => m.subject.includes('已验收')));
    assert.ok(userInbox.some((m) => m.subject.includes('已验收')));
  })();
});

test('question lifecycle notifies and clears the blocker', async () => {
  const { wf } = fixture();

  // todo asks plan a blocking question through the file + message
  const todo = { role: 'todo' as const, repo: 'repo-a' };
  const plan = { role: 'plan' as const, repo: 'repo-a' };
  const { appendQuestion } = await import('../src/core/questions.js');
  appendQuestion(path.join(wf.repoRef('repo-a').abs, 'docs/agent-questions.md'), {
    id: 'Q-001',
    to: 'PLAN',
    from: 'TODO',
    blocking: true,
    context: 'which version?',
  });
  wf.msgs.send({
    from: todo,
    to: plan,
    kind: 'question',
    subject: 'Q-001 which version?',
    refs: { question_id: 'Q-001' },
    blocking: true,
  });
  assert.equal(wf.msgs.blockingFor(plan).length, 1);

  const q = wf.findQuestion('Q-001')!;
  wf.answerQuestion(q, 'use v1', 'PLAN §3', plan);

  assert.equal(wf.msgs.blockingFor(plan).length, 0, 'answering acks the blocker');
  const todoInbox = wf.msgs.forActor(todo);
  assert.ok(todoInbox.some((m) => m.kind === 'answer'));
});

/* ------------------------------- hooks ---------------------------------- */

test('session-start hook injects unread messages', () => {
  if (!fs.existsSync(CLI)) return;
  const { abs, wf } = fixture();
  const plan = { role: 'plan' as const, repo: 'repo-a' };
  wf.msgs.send({
    from: { role: 'todo', repo: 'repo-a' },
    to: plan,
    kind: 'event',
    subject: 'needs your review',
  });

  const out = execFileSync(process.execPath, [CLI, 'hook', 'session-start'], {
    cwd: abs,
    env: { ...process.env, WF_ROLE: 'plan', WF_REPO: 'repo-a', CLAUDE_PROJECT_DIR: abs },
    encoding: 'utf8',
  });
  assert.match(out, /未读消息/);
  assert.match(out, /needs your review/);
});

/* -------------------------------- CLI ----------------------------------- */

test('CLI inbox/ack round-trip', () => {
  if (!fs.existsSync(CLI)) return;
  const { root, abs, wf } = fixture();
  const plan = { role: 'plan' as const, repo: 'repo-a' };
  const { message } = wf.msgs.send({
    from: { role: 'todo', repo: 'repo-a' },
    to: plan,
    kind: 'event',
    subject: 'cli check',
  });

  const env = { ...process.env, WF_ROLE: 'plan', WF_REPO: 'repo-a' };
  const inbox = execFileSync(process.execPath, [CLI, 'inbox', '--root', root], {
    cwd: abs,
    env,
    encoding: 'utf8',
  });
  assert.match(inbox, /cli check/);

  execFileSync(process.execPath, [CLI, 'ack', message.id, '--note', 'done', '--root', root], {
    cwd: abs,
    env,
    encoding: 'utf8',
  });
  assert.equal(new Workflow(root).msgs.get(message.id)?.status, 'acked');
});

test('actorKey formats addresses', () => {
  assert.equal(actorKey({ role: 'plan', repo: 'x' }), 'plan@x');
  assert.equal(actorKey({ role: 'main' }), 'main');
  assert.equal(actorKey({ role: 'user' }), 'user');
});
