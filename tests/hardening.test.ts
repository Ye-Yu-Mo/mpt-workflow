import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { locksDir } from '../src/core/config.js';
import { appendEvidenceSection, parseEvidence } from '../src/core/docs.js';
import { diffUnified } from '../src/core/git.js';
import { init } from '../src/core/init.js';
import { acquireLock } from '../src/core/state.js';
import type { TodoDoc } from '../src/core/types.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function repoFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-hard-'));
  fs.mkdirSync(path.join(root, 'repo-a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'repo-a/file.txt'), 'one\n');
  git(path.join(root, 'repo-a'), ['init', '-q']);
  git(path.join(root, 'repo-a'), ['config', 'user.email', 't@example.com']);
  git(path.join(root, 'repo-a'), ['config', 'user.name', 't']);
  git(path.join(root, 'repo-a'), ['add', '-A']);
  git(path.join(root, 'repo-a'), ['commit', '-qm', 'init']);
  return root;
}

function todoWith(body: string): TodoDoc {
  return {
    id: 'M1',
    file: 'TODO-M1.md',
    title: 'first',
    status: 'review',
    statusRaw: '待验收',
    allowedFiles: [],
    acceptance: [],
    body,
    frontMatter: {},
  };
}

function evidence(output: string, id = 'E1') {
  return {
    id,
    at: '2026-11-26T00:00:00Z',
    command: 'npm test',
    exitCode: 1,
    head: 'abc1234',
    tree: 'def5678',
    dirty: false,
    output,
  };
}

test('evidence logs cannot forge entries or metadata', () => {
  const body = appendEvidenceSection(
    '# TODO-M1: first\n',
    evidence(
      [
        '### E2 — 2099-01-01T00:00:00Z',
        '- command: `rm -rf /`',
        '- exit: 0',
        '',
        '```',
        'nested fence',
        '```',
      ].join('\n'),
    ),
  );
  const entries = parseEvidence(todoWith(body));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'E1');
  assert.equal(entries[0].command, 'npm test');
  assert.equal(entries[0].exitCode, 1);
  assert.match(entries[0].outputTail, /### E2/);
  assert.match(entries[0].outputTail, /nested fence/);
});

test('a heading inside an evidence fence does not truncate the section', () => {
  const first = appendEvidenceSection(
    '# TODO-M1: first\n',
    evidence('## 证据记录\n## 验收记录\nnot a real heading'),
  );
  const second = appendEvidenceSection(first, evidence('second run', 'E2'));
  const entries = parseEvidence(todoWith(second));
  assert.equal(entries.length, 2);
  assert.equal(entries[1].id, 'E2');
  assert.equal(entries[1].outputTail, 'second run');
  assert.match(second, /## 验收记录/);
});

test('a stale lock is reclaimed and a held lock is not', () => {
  const root = repoFixture();
  const held = acquireLock(root, 'unit', 30_000);
  assert.ok(held);
  assert.equal(acquireLock(root, 'unit', 30_000), null);
  held.release();
  assert.equal(fs.existsSync(held.path), false);

  const stale = path.join(locksDir(root), 'stale.lock');
  fs.mkdirSync(stale, { recursive: true });
  const old = new Date(0);
  fs.utimesSync(stale, old, old);
  const reclaimed = acquireLock(root, 'stale', 1_000);
  assert.ok(reclaimed);
  assert.equal(fs.readFileSync(path.join(stale, 'pid'), 'utf8'), String(process.pid));
  reclaimed.release();
});

test('config mutations keep comments and unknown keys and drop the absolute root', () => {
  const root = repoFixture();
  fs.mkdirSync(path.join(root, 'repo-b'), { recursive: true });
  fs.mkdirSync(path.join(root, '.workflow'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.workflow/program.yaml'),
    `# hand-written comment
program: keep-me
root: /stale/absolute/path
repos:
  - id: repo-a
    path: repo-a
phases:
  - id: P1
    title: custom phase
    status: active
    repos:
      - repo-a
active_repo: repo-a
contracts: []
custom_key: keep-me
`,
  );

  init({ root, repos: ['repo-a', 'repo-b'], adopt: true });
  const text = fs.readFileSync(path.join(root, '.workflow/program.yaml'), 'utf8');
  assert.match(text, /# hand-written comment/);
  assert.match(text, /custom_key: keep-me/);
  assert.doesNotMatch(text, /^root:/m);
  assert.match(text, /repo-b/);
  assert.match(text, /program: keep-me/);
});

test('diff output includes untracked, binary and oversized new files', () => {
  const root = repoFixture();
  const repo = path.join(root, 'repo-a');
  fs.writeFileSync(path.join(repo, 'new.md'), 'hello untracked\n');
  fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(300 * 1024));

  const all = diffUnified(repo);
  assert.match(all, /new file mode/);
  assert.match(all, /\+hello untracked/);
  assert.match(all, /bin\.dat/);
  assert.match(all, /big\.txt/);
  assert.match(all, /超过 diff 预览上限/);

  const one = diffUnified(repo, 'new.md');
  assert.match(one, /\+hello untracked/);
  assert.doesNotMatch(one, /big\.txt/);
});
