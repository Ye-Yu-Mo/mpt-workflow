import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Workflow } from '../src/core/workflow.js';
import { buildTools, invokeTool } from '../src/mcp/server.js';
import { startWebServer } from '../src/web/server.js';

const CLI = path.resolve(process.cwd(), 'dist/cli.js');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-root-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'milestone'), { recursive: true });
  fs.mkdirSync(path.join(root, '.workflow'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'repo-a/\n');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# umbrella\n');
  fs.writeFileSync(path.join(root, 'docs/a.md'), 'a\n');
  fs.writeFileSync(path.join(root, '.workflow/.gitignore'), 'runtime/\n');
  fs.writeFileSync(
    path.join(root, '.workflow/program.yaml'),
    `program: root-test
repos:
  - id: repo-a
    path: repo-a
phases:
  - id: P1
    title: test
    status: active
    repos: [repo-a]
active_repo: repo-a
contracts: []
`,
  );

  const repo = path.join(root, 'repo-a');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'PLAN.md'),
    '# PLAN: repo-a\n\n| M | 名称 |\n|---|---|\n| M1 | first |\n',
  );
  fs.writeFileSync(
    path.join(repo, 'TODO-M1.md'),
    '# TODO-M1: first\n\n> 状态：待实现\n\n- **影响文件**：\n  - `src/lib.rs`\n',
  );
  fs.writeFileSync(path.join(repo, 'src/lib.rs'), 'fn f() {}\n');
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 't@example.com'],
    ['config', 'user.name', 't'],
    ['add', '-A'],
    ['commit', '-qm', 'repo init'],
  ]) {
    git(repo, args);
  }

  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 't@example.com'],
    ['config', 'user.name', 't'],
    ['add', '-A'],
    ['commit', '-qm', 'root init'],
  ]) {
    git(root, args);
  }

  return { root, repo, wf: new Workflow(root) };
}

test('main can commit umbrella docs through the approval flow', () => {
  const { root, repo, wf } = fixture();
  fs.writeFileSync(path.join(root, 'docs/a.md'), 'a2\n');
  assert.ok(
    wf.programStatus().next.some((n) => n.action === '提交伞仓文档'),
    'status should suggest the pending umbrella commit',
  );

  const req = wf.requestCommit({ repoId: 'root', message: 'docs: a', role: 'main' });
  assert.equal(req.approval.repo, 'root');
  assert.ok(req.files.includes('docs/a.md'));
  assert.equal(req.approval.milestone, undefined);

  wf.approve(req.approval.id);
  const res = wf.commitApproved({ repoId: 'root', approvalId: req.approval.id, role: 'main' });
  assert.ok('head' in res && res.head);
  assert.equal(git(root, ['log', '-1', '--format=%s']).trim(), 'docs: a');
  assert.equal(git(repo, ['log', '-1', '--format=%s']).trim(), 'repo init');
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '');
  assert.ok(!wf.programStatus().next.some((n) => n.action === '提交伞仓文档'));
});

test('plan and todo cannot request or execute a root commit', () => {
  const { root, wf } = fixture();
  fs.writeFileSync(path.join(root, 'docs/a.md'), 'a2\n');
  assert.throws(
    () => wf.requestCommit({ repoId: 'root', message: 'docs', role: 'plan' }),
    /只有 main\/user/,
  );
  assert.throws(
    () => wf.requestCommit({ repoId: 'root', message: 'docs', role: 'todo' }),
    /只有 main\/user/,
  );
});

test('root scope rejects component, runtime, MCP and nested-repo paths', () => {
  const { root, wf } = fixture();

  fs.writeFileSync(path.join(root, 'tmp-dev.md'), 'tmp\n');
  assert.throws(
    () => wf.requestCommit({ repoId: 'root', message: 'docs', role: 'main' }),
    /不允许的路径/,
  );

  fs.rmSync(path.join(root, 'tmp-dev.md'));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude/settings.json'), '{}');
  assert.throws(
    () => wf.requestCommit({ repoId: 'root', message: 'docs', role: 'main' }),
    /不允许的路径/,
  );
  fs.rmSync(path.join(root, '.claude'), { recursive: true, force: true });

  fs.writeFileSync(path.join(root, '.mcp.json'), '{}');
  assert.throws(
    () => wf.requestCommit({ repoId: 'root', message: 'docs', role: 'main' }),
    /不允许的路径/,
  );
  fs.rmSync(path.join(root, '.mcp.json'));

  fs.mkdirSync(path.join(root, 'other-repo'), { recursive: true });
  git(path.join(root, 'other-repo'), ['init', '-q']);
  assert.throws(
    () => wf.requestCommit({ repoId: 'root', message: 'docs', role: 'main' }),
    /不允许的路径/,
  );
});

test('a nested repository inside an allowed docs directory is refused', () => {
  const { root, wf } = fixture();
  const nested = path.join(root, 'docs/nested');
  fs.mkdirSync(nested, { recursive: true });
  git(nested, ['init', '-q']);
  fs.writeFileSync(path.join(nested, 'x.md'), 'x\n');
  assert.throws(
    () => wf.requestCommit({ repoId: 'root', message: 'docs', role: 'main' }),
    /gitlink|嵌套仓库/,
  );
});

test('a new root commit request supersedes older pending approvals', () => {
  const { root, wf } = fixture();
  fs.writeFileSync(path.join(root, 'docs/a.md'), 'a2\n');
  const first = wf.requestCommit({ repoId: 'root', message: 'docs: first', role: 'main' });
  const second = wf.requestCommit({ repoId: 'root', message: 'docs: second', role: 'main' });
  const old = wf.approvals().find((a) => a.id === first.approval.id);
  assert.equal(old?.superseded_by, second.approval.id);
  assert.ok(old?.superseded_at);
  assert.equal(wf.approvals().find((a) => a.id === second.approval.id)?.superseded_by, undefined);
});

test('root approval is bound to the staged content', () => {
  const { root, wf } = fixture();
  fs.writeFileSync(path.join(root, 'docs/a.md'), 'a2\n');
  const req = wf.requestCommit({ repoId: 'root', message: 'docs: a', role: 'main' });
  fs.writeFileSync(path.join(root, 'docs/a.md'), 'a3\n');
  assert.throws(() => wf.approve(req.approval.id), /工作区内容已变化/);
});

test('MCP and CLI can complete a root approval', { skip: !fs.existsSync(CLI) }, async () => {
  const { root, wf } = fixture();
  fs.writeFileSync(path.join(root, 'docs/a.md'), 'a2\n');
  const tools = buildTools({ root });
  const ctx = { wf, role: 'main' as const, repo: null };
  const out = await invokeTool(
    tools,
    'commit_request',
    { message: 'docs: mcp', repo: 'root' },
    ctx,
  );
  const text = typeof out === 'string' ? out : out.content.map((c) => c.text).join('\n');
  const id = /审批已创建:\s*(\S+)/.exec(text)?.[1];
  assert.ok(id, text);

  execFileSync(process.execPath, [CLI, 'approve', id, '--root', root], { encoding: 'utf8' });
  execFileSync(process.execPath, [CLI, 'commit', id, '--root', root], { encoding: 'utf8' });
  assert.equal(git(root, ['log', '-1', '--format=%s']).trim(), 'docs: mcp');
});

test('MCP resolves root when repo is omitted at the umbrella root', async () => {
  const { root, wf } = fixture();
  fs.writeFileSync(path.join(root, 'docs/a.md'), 'a2\n');
  const previous = process.cwd();
  process.chdir(root);
  try {
    const tools = buildTools({ root });
    const ctx = { wf, role: 'main' as const, repo: null };
    const out = await invokeTool(tools, 'commit_request', { message: 'docs: auto' }, ctx);
    const text = typeof out === 'string' ? out : out.content.map((c) => c.text).join('\n');
    const id = /审批已创建:\s*(\S+)/.exec(text)?.[1];
    assert.ok(id, text);
    assert.equal(wf.approvals().find((a) => a.id === id)?.repo, 'root');
  } finally {
    process.chdir(previous);
  }
});

test('root commit without a root git repository is refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-root-nogit-'));
  fs.mkdirSync(path.join(root, '.workflow'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.workflow/program.yaml'),
    'program: nogit\nrepos: []\nphases: []\nactive_repo: null\ncontracts: []\n',
  );
  const wf = new Workflow(root);
  fs.writeFileSync(path.join(root, 'docs.md'), 'x');
  assert.throws(
    () => wf.requestCommit({ repoId: 'root', message: 'docs', role: 'main' }),
    /不是 git 仓库/,
  );
});

test('dashboard API exposes root approvals and root diffs', async () => {
  const { root, wf } = fixture();
  fs.writeFileSync(path.join(root, 'docs/a.md'), 'a2\n');
  fs.writeFileSync(path.join(root, 'docs/new.md'), 'brand new\n');
  const req = wf.requestCommit({ repoId: 'root', message: 'docs: dashboard', role: 'main' });
  assert.ok(req.files.includes('docs/new.md'));
  const server = await startWebServer(wf, 0);
  try {
    const approvals = (await (await fetch(`${server.url}/api/approvals`)).json()) as {
      id: string;
      repo: string;
      stale?: boolean;
    }[];
    const a = approvals.find((x) => x.id === req.approval.id);
    assert.equal(a?.repo, 'root');
    assert.equal(a?.stale, false);

    const diff = (await (await fetch(`${server.url}/api/diff?repo=root`)).json()) as {
      diff: string;
    };
    assert.match(diff.diff, /docs\/a\.md/);
    assert.match(diff.diff, /docs\/new\.md/);
    assert.match(diff.diff, /\+brand new/);
  } finally {
    await server.close();
  }
});
