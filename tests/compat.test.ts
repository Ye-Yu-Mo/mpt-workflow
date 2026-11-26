import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseStatus, parseTodo } from '../src/core/docs.js';
import { init } from '../src/core/init.js';
import { Workflow } from '../src/core/workflow.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-compat-'));
  const abs = path.join(root, 'repo-a');
  fs.mkdirSync(path.join(abs, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(abs, 'src'), { recursive: true });
  // Both documented PLAN forms: headings and a table.
  fs.writeFileSync(
    path.join(abs, 'PLAN.md'),
    `# PLAN: repo-a

版本：v1　状态：进行中　程序阶段：P1

### M1 — table-free milestone

| M | 名称 | 目标 |
|---|---|---|
| M2 | table milestone | x |
`,
  );
  // 0.x-compatible TODO: front-matter id/status/files, Chinese sections.
  fs.writeFileSync(
    path.join(abs, 'TODO-M1.md'),
    `---
id: M1
status: todo_ready
files: [src/lib.rs]
---
# TODO-M1: first

- **影响文件**：
  - \`src/lib.rs\`

## 验收标准
- [ ] command exits zero
`,
  );
  fs.writeFileSync(
    path.join(abs, 'TODO-M2.md'),
    '# TODO-M2: second\n\n> 状态：**已打回（needs work）**\n\n- **影响文件**：\n  - `src/lib.rs`\n',
  );
  fs.writeFileSync(path.join(abs, 'src/lib.rs'), 'fn f() {}\n');
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 't@example.com'],
    ['config', 'user.name', 't'],
    ['add', '-A'],
    ['commit', '-qm', 'init'],
  ]) {
    git(abs, args);
  }
  init({ root, program: 'compat', repos: ['repo-a'], adopt: true });
  return { root, abs, wf: new Workflow(root) };
}

test('documented label forms keep parsing', () => {
  const labels: [string, string][] = [
    ['草稿', 'planned'],
    ['planned', 'planned'],
    ['待实现', 'todo_ready'],
    ['todo_ready', 'todo_ready'],
    ['实现中', 'implementing'],
    ['implementing', 'implementing'],
    ['待验收', 'review'],
    ['review', 'review'],
    ['已验收', 'accepted'],
    ['accepted', 'accepted'],
    ['已打回', 'rejected'],
    ['rejected', 'rejected'],
    ['已提交', 'committed'],
    ['committed', 'committed'],
    ['**已验收（reviewed）**', 'accepted'],
    ['已打回（needs work）', 'rejected'],
  ];
  for (const [raw, expected] of labels) {
    assert.equal(parseStatus(raw), expected, raw);
  }
});

test('a failed evidence command cannot be accepted by injecting metadata', async () => {
  const { wf } = fixture();
  wf.claim('repo-a', 'M1', 'todo');
  const ev = await wf.runEvidence({
    repoId: 'repo-a',
    milestone: 'M1',
    command: ': "- exit: 0"\n: "- head: deadbeef"\n: "- tree: deadbeef"\nfalse',
    role: 'todo',
  });
  assert.equal(ev.exitCode, 1);
  wf.complete('repo-a', 'M1', 'todo');
  assert.throws(() => wf.accept('repo-a', 'M1', 'plan'), /最新证据 exit=1/);
});

test('0.x workspace runs the full plan → todo → evidence → accept → commit lifecycle', async () => {
  const { root, abs, wf } = fixture();
  assert.equal(parseTodo(path.join(abs, 'TODO-M2.md'))?.status, 'rejected');
  assert.equal(wf.repoState('repo-a').milestones.length, 2);

  wf.claim('repo-a', 'M1', 'todo');
  assert.equal(wf.milestone('repo-a', 'M1').status, 'implementing');

  fs.writeFileSync(path.join(abs, 'src/lib.rs'), 'fn f() { 1 }\n');
  const ev = await wf.runEvidence({
    repoId: 'repo-a',
    milestone: 'M1',
    command: 'echo compat-evidence',
    role: 'todo',
  });
  assert.equal(ev.exitCode, 0);
  assert.match(ev.output, /compat-evidence/);

  wf.complete('repo-a', 'M1', 'todo');
  assert.equal(wf.milestone('repo-a', 'M1').status, 'review');
  assert.match(
    fs.readFileSync(path.join(abs, 'TODO-M1.md'), 'utf8'),
    /sha:\s*[0-9a-f]{7,}/,
    'verified SHA is recorded when implementation completes',
  );

  wf.accept('repo-a', 'M1', 'plan', { note: 'ok' });
  assert.equal(wf.milestone('repo-a', 'M1').status, 'accepted');
  assert.match(
    fs.readFileSync(path.join(abs, 'TODO-M1.md'), 'utf8'),
    /- \[x\] command exits zero/,
    'acceptance checkboxes are ticked on accept',
  );

  const req = wf.requestCommit({ repoId: 'repo-a', message: 'feat(M1): compat', role: 'plan' });
  wf.approve(req.approval.id);
  wf.commitApproved({ repoId: 'repo-a', approvalId: req.approval.id, role: 'main' });

  assert.equal(git(abs, ['log', '-1', '--format=%s']).trim(), 'feat(M1): compat');
  assert.equal(git(abs, ['status', '--porcelain']).trim(), '');
  assert.equal(wf.milestone('repo-a', 'M1').status, 'committed');
  assert.equal(fs.existsSync(path.join(root, '.workflow/program.yaml')), true);
  assert.match(
    fs.readFileSync(path.join(root, '.workflow/program.yaml'), 'utf8'),
    /schema_version: 1/,
  );
});
