import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Workflow } from '../src/core/workflow.js';
import { createDemoWorkspace } from '../src/core/demo.js';

const CLI = path.resolve(process.cwd(), 'dist/cli.js');

test('demo workspace has a ready milestone and a user message', () => {
  const { root } = createDemoWorkspace();
  const wf = new Workflow(root);
  assert.equal(wf.milestone('demo-service', 'M1').status, 'todo_ready');
  assert.equal(wf.programStatus().repos.length, 1);
  assert.ok(wf.msgs.forActor({ role: 'user' }).some((m) => m.subject.includes('M1')));
});

test('CLI --version prints the package version', { skip: !fs.existsSync(CLI) }, () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
    version: string;
  };
  const out = execFileSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' }).trim();
  assert.equal(out, pkg.version);
});

test('CLI demo runs end-to-end', { skip: !fs.existsSync(CLI) }, () => {
  const out = execFileSync(process.execPath, [CLI, 'demo'], { encoding: 'utf8', timeout: 120_000 });
  assert.match(out, /Demo workspace:/);
  assert.match(out, /todo_ready/);
  assert.match(out, /mpt-workflow web --root/);
});

test('CLI gc is a dry run by default', { skip: !fs.existsSync(CLI) }, () => {
  const { root } = createDemoWorkspace();
  const out = execFileSync(process.execPath, [CLI, 'gc', '--root', root], { encoding: 'utf8' });
  assert.match(out, /dry-run/);
  assert.match(out, /未删除任何文件/);
});
