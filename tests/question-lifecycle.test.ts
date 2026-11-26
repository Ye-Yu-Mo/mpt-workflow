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
