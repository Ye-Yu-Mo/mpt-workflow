import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { configPath, loadConfig, saveConfig } from '../src/core/config.js';
import { init } from '../src/core/init.js';
import { readRoleLease, setRoleLease } from '../src/core/session.js';
import { Workflow } from '../src/core/workflow.js';
import { buildTools, invokeTool } from '../src/mcp/server.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-session-'));
  for (const id of ['repo-a', 'repo-b']) {
    const abs = path.join(root, id);
    fs.mkdirSync(path.join(abs, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(abs, 'src.txt'), 'x\n');
    git(abs, ['init', '-q']);
    git(abs, ['config', 'user.email', 't@example.com']);
    git(abs, ['config', 'user.name', 't']);
    git(abs, ['add', '-A']);
    git(abs, ['commit', '-qm', 'init']);
  }
  init({ root, program: 'session-test', repos: ['repo-a', 'repo-b'], adopt: true });
  return { root, abs: path.join(root, 'repo-a'), wf: new Workflow(root) };
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function withEnvAsync<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('config changes made by one process are visible to another instance', () => {
  const { root, wf } = fixture();
  const other = new Workflow(root);
  wf.setActiveRepo('repo-b');
  assert.equal(other.programStatus().activeRepo, 'repo-b');
});

test('phase activation is explicit about the previous active phase', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-phase-'));
  fs.mkdirSync(path.join(root, '.workflow'), { recursive: true });
  fs.writeFileSync(
    configPath(root),
    `program: phase-test
repos: []
phases:
  - id: P1
    title: one
    status: active
    repos: []
  - id: P2
    title: two
    status: planned
    repos: []
active_repo: null
contracts: []
`,
  );
  const wf = new Workflow(root);
  assert.throws(() => wf.updatePhase('P2', 'active'), /仍为 active/);
  const changes = wf.updatePhase('P2', 'active', { acceptPrevious: true });
  assert.deepEqual(changes, [
    { id: 'P1', from: 'active', to: 'accepted', auto: true },
    { id: 'P2', from: 'planned', to: 'active', auto: false },
  ]);
  const cfg = loadConfig(root);
  assert.equal(cfg?.phases.find((p) => p.id === 'P1')?.status, 'accepted');
  assert.equal(cfg?.phases.find((p) => p.id === 'P2')?.status, 'active');
});

test('a refused phase switch does not change active_repo', async () => {
  const { root, wf } = fixture();
  const cfg = loadConfig(root);
  assert.ok(cfg);
  cfg.phases.push({
    id: 'P2',
    title: 'two',
    status: 'planned',
    repos: [],
    exit_criteria: [],
  });
  saveConfig(root, cfg);
  wf.refreshConfig();
  const before = wf.programStatus().activeRepo;

  const tools = buildTools({ root });
  const ctx = { wf, role: 'main' as const, repo: null };
  const out = await invokeTool(tools, 'phase_activate', { repo: 'repo-b', phase: 'P2' }, ctx);
  assert.equal((out as { isError?: boolean }).isError, true);
  assert.match((out as { content: { text: string }[] }).content[0].text, /仍为 active/);
  assert.equal(wf.programStatus().activeRepo, before);
});

test('a broken config blocks tools instead of using the old snapshot', async () => {
  const { root, wf } = fixture();
  const tools = buildTools({ root });
  const ctx = { wf, role: 'todo' as const, repo: 'repo-a', declared: true };
  const textOf = (out: unknown): string =>
    typeof out === 'string'
      ? out
      : ((out as { content?: { text: string }[] }).content ?? []).map((c) => c.text).join('\n');
  fs.writeFileSync(configPath(root), 'program: [broken\n');
  const blocked = await invokeTool(tools, 'milestone_claim', { milestone: 'M1' }, ctx);
  assert.equal((blocked as { isError?: boolean }).isError, true);
  assert.match(textOf(blocked), /配置不可用/);
  const status = await invokeTool(tools, 'status', {}, ctx);
  assert.match(textOf(status), /解析失败/);
});

test('a legacy global role file is read as a migration fallback', () => {
  const { root } = fixture();
  fs.mkdirSync(path.join(root, '.workflow/runtime'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.workflow/runtime/role.json'),
    JSON.stringify({ role: 'plan', repo: 'repo-a', at: '2026-01-01T00:00:00Z' }),
  );
  withEnv({ WF_ROLE: undefined, WF_REPO: undefined, WF_SESSION: 'no-session-file' }, () => {
    const lease = readRoleLease(root, 'no-session-file');
    assert.equal(lease?.role, 'plan');
    assert.equal(lease?.source, 'legacy');
  });
});

test('leases are stored per session, not in one global file', () => {
  const { root } = fixture();
  withEnv({ WF_ROLE: undefined, WF_REPO: undefined, WF_SESSION: 'sess-1' }, () => {
    setRoleLease(root, { role: 'plan', repo: 'repo-a', at: '2026-01-01T00:00:00Z' });
    assert.equal(readRoleLease(root, 'sess-1')?.role, 'plan');
    assert.equal(readRoleLease(root, 'sess-2'), null);
    assert.equal(fs.existsSync(path.join(root, '.workflow/runtime/role.json')), false);
  });
  withEnv({ WF_ROLE: undefined, WF_REPO: undefined, WF_SESSION: 'sess-2' }, () => {
    setRoleLease(root, { role: 'todo', repo: 'repo-a', at: '2026-01-01T00:00:00Z' });
    assert.equal(readRoleLease(root)?.role, 'todo');
  });
  withEnv({ WF_ROLE: undefined, WF_REPO: undefined, WF_SESSION: 'sess-1' }, () => {
    assert.equal(readRoleLease(root)?.role, 'plan');
  });
});

test('status separates session identity from the global active repo', () => {
  const { root } = fixture();
  withEnv({ WF_ROLE: undefined, WF_REPO: undefined, WF_SESSION: 'sess-status' }, () => {
    setRoleLease(root, { role: 'plan', repo: 'repo-a', at: '2026-01-01T00:00:00Z' });
    const wf = new Workflow(root);
    const st = wf.programStatus();
    assert.equal(st.activeRepo, 'repo-a');
    assert.equal(st.session?.role, 'plan');
    assert.equal(st.session?.repo, 'repo-a');
    assert.equal(st.session?.id, 'sess-status');
    assert.equal(st.config.version.length, 12);
    assert.ok(st.config.loaded_at);
    assert.equal(st.config.error, undefined);
  });
});

test('program.yaml is reloaded when its mtime/size changes', () => {
  const { root } = fixture();
  const wf = new Workflow(root);
  const before = wf.programStatus();
  const file = configPath(root);
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(
    file,
    `${text.replace('program: session-test', 'program: hot-reloaded')}# reload\n`,
  );
  const after = wf.programStatus();
  assert.equal(after.program, 'hot-reloaded');
  assert.notEqual(after.config.version, before.config.version);

  fs.writeFileSync(file, 'program: [broken\n');
  const broken = wf.programStatus();
  assert.match(broken.config.error || '', /无法解析/);
  assert.equal(broken.program, 'hot-reloaded');
});

test('bootstrap writes a session lease and status shows it', async () => {
  const { root, wf } = fixture();
  await withEnvAsync(
    { WF_ROLE: undefined, WF_REPO: undefined, CLAUDE_CODE_SESSION_ID: 'sess-mcp' },
    async () => {
      const tools = buildTools({ root });
      const ctx = { wf, role: 'user' as const, repo: null };
      const out = await invokeTool(tools, 'bootstrap', { role: 'plan', repo: 'repo-a' }, ctx);
      assert.match(String(out), /会话/);
      assert.equal(readRoleLease(root, 'sess-mcp')?.role, 'plan');
      const status = await invokeTool(tools, 'status', {}, ctx);
      assert.match(String(status), /当前会话: plan@repo-a/);
      assert.match(String(status), /全局 active repo: repo-a/);
      assert.match(String(status), /配置: [0-9a-f]{12}/);
    },
  );
});
