import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { init } from '../src/core/init.js';
import {
  appendQuestion,
  defaultQuestionsHeader,
  QUESTION_STATUS_HELP,
  questionsFile,
} from '../src/core/questions.js';
import { Workflow } from '../src/core/workflow.js';
import { buildTools, invokeTool } from '../src/mcp/server.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-question-'));
  const abs = path.join(root, 'repo-a');
  fs.mkdirSync(path.join(abs, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(abs, 'src.txt'), 'x\n');
  git(abs, ['init', '-q']);
  git(abs, ['config', 'user.email', 't@example.com']);
  git(abs, ['config', 'user.name', 't']);
  git(abs, ['add', '-A']);
  git(abs, ['commit', '-qm', 'init']);
  init({ root, program: 'q-test', repos: ['repo-a'], adopt: true });
  const wf = new Workflow(root);
  const file = questionsFile(abs);
  appendQuestion(file, {
    id: 'Q-001',
    to: 'user',
    from: 'plan',
    blocking: false,
    context: 'Which option should we take?',
  });
  return { root, abs, wf };
}

test('the question board documents its status lifecycle', () => {
  assert.match(defaultQuestionsHeader(), /open/);
  assert.match(defaultQuestionsHeader(), /answered/);
  assert.match(defaultQuestionsHeader(), /close/);
});

test('question labels with @repo map to the role, not main', () => {
  const { abs, wf } = fixture();
  const file = questionsFile(abs);
  appendQuestion(file, {
    id: 'Q-002',
    to: 'plan',
    from: 'TODO@repo-a',
    blocking: false,
    context: 'todo asked this',
  });
  appendQuestion(file, {
    id: 'Q-003',
    to: 'TODO@repo-a',
    from: 'plan',
    blocking: false,
    context: 'plan asks todo',
  });
  const q2 = wf.findQuestion('Q-002');
  assert.ok(q2);
  wf.answerQuestion(q2, 'do it', undefined, { role: 'plan', repo: 'repo-a' });

  const next = wf.programStatus().next.filter((n) => n.question);
  const answered = next.find((n) => n.question === 'Q-002');
  assert.equal(answered?.actor, 'todo');
  assert.equal(answered?.action, '应用回答并 close');
  const open = next.find((n) => n.question === 'Q-003');
  assert.equal(open?.actor, 'todo');
  assert.equal(open?.action, '回答非阻塞问题');
});

test('closing an unanswered blocking question clears the blocker', async () => {
  const { wf } = fixture();
  const tools = buildTools({ root: wf.root });
  const ctx = { wf, role: 'todo' as const, repo: 'repo-a' };
  const out = await invokeTool(
    tools,
    'ask',
    { to: 'PLAN', context: 'need a decision', blocking: true, repo: 'repo-a' },
    ctx,
  );
  const id = /Q-\d+/.exec(String(out))?.[0];
  assert.ok(id, String(out));
  assert.ok(wf.msgs.blockingFor({ role: 'plan', repo: 'repo-a' }).length > 0);

  const q = wf.findQuestion(id);
  assert.ok(q);
  wf.closeQuestion(q, 'withdrawn', { role: 'user' });
  assert.equal(wf.msgs.blockingFor({ role: 'plan', repo: 'repo-a' }).length, 0);
});

test('next tells both sides what to do and close finishes the loop', async () => {
  const { wf } = fixture();
  const q = wf.findQuestion('Q-001');
  assert.ok(q);

  const openNext = wf.programStatus().next.filter((n) => n.question === 'Q-001');
  assert.deepEqual(
    openNext.map((n) => `${n.actor}:${n.action}`),
    ['user:回答非阻塞问题'],
  );

  const tools = buildTools({ root: wf.root });
  const ctx = { wf, role: 'plan' as const, repo: 'repo-a' };
  const bootstrap = await invokeTool(tools, 'bootstrap', { role: 'plan', repo: 'repo-a' }, ctx);
  assert.match(String(bootstrap), /问题协议/);

  wf.answerQuestion(q, 'Take option A.', undefined, { role: 'user' });
  assert.equal(wf.findQuestion('Q-001')?.status, 'answered');

  const answeredNext = wf.programStatus().next.filter((n) => n.question === 'Q-001');
  assert.deepEqual(
    answeredNext.map((n) => `${n.actor}:${n.action}`),
    ['plan:应用回答并 close'],
  );

  const listed = await invokeTool(tools, 'questions', {}, ctx);
  assert.match(String(listed), new RegExp(QUESTION_STATUS_HELP.slice(0, 10)));

  const answered = wf.findQuestion('Q-001');
  assert.ok(answered);
  wf.closeQuestion(answered, 'Applied A to TODO-M1.', { role: 'plan' });
  assert.equal(wf.findQuestion('Q-001')?.status, 'closed');
  assert.equal(wf.programStatus().next.filter((n) => n.question === 'Q-001').length, 0);
});
