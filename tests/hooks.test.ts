import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const CLI = path.resolve(process.cwd(), 'dist/cli.js');

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-hook-'));
  const abs = path.join(root, 'repo-a');
  fs.mkdirSync(path.join(abs, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(abs, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(abs, 'PLAN.md'),
    '# PLAN: repo-a\n\n| M | 名称 |\n|---|---|\n| M1 | first |\n',
  );
  fs.writeFileSync(
    path.join(abs, 'TODO-M1.md'),
    '# TODO-M1: first\n\n> 状态：实现中\n\n- **影响文件**：\n  - `src/lib.rs`\n',
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
  execFileSync(
    process.execPath,
    [CLI, 'init', '--root', root, '--repo', 'repo-a', '--install-hooks'],
    { encoding: 'utf8' },
  );
  return { root, abs };
}

test('installed pre-commit hook lets a todo session commit its own milestone', {
  skip: !fs.existsSync(CLI),
}, () => {
  const { abs } = fixture();
  // Simulate what the workflow tools write: the TODO status and source change.
  fs.appendFileSync(path.join(abs, 'TODO-M1.md'), '\n> 证据时间：now\n');
  fs.writeFileSync(path.join(abs, 'src/lib.rs'), 'fn f() { 1 }\n');
  git(abs, ['add', '-A']);
  git(abs, ['commit', '-qm', 'feat(M1): work'], { WF_ROLE: 'todo', WF_REPO: 'repo-a' });
  assert.match(git(abs, ['log', '-1', '--format=%s']), /feat\(M1\): work/);
});

test('installed pre-commit hook blocks files outside the TODO list', {
  skip: !fs.existsSync(CLI),
}, () => {
  const { abs } = fixture();
  fs.writeFileSync(path.join(abs, 'src/extra.rs'), 'fn g() {}\n');
  git(abs, ['add', '-A']);
  try {
    git(abs, ['commit', '-qm', 'feat: extra'], { WF_ROLE: 'todo', WF_REPO: 'repo-a' });
    assert.fail('pre-commit should have blocked the out-of-scope file');
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    assert.equal(err.status, 1);
    assert.match(String(err.stderr), /影响文件/);
  }
});
