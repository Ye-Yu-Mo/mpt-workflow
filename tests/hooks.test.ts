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

function hookStatus(
  role: string | null,
  repo: string | null,
  cwd: string,
  tool: string,
  input: Record<string, unknown>,
  sessionId?: string,
): { status: number; stderr: string } {
  const env = { ...process.env } as Record<string, string>;
  delete env.WF_SESSION;
  delete env.CLAUDE_CODE_SESSION_ID;
  if (role) env.WF_ROLE = role;
  else delete env.WF_ROLE;
  if (repo) env.WF_REPO = repo;
  else delete env.WF_REPO;
  try {
    execFileSync(process.execPath, [CLI, 'hook', 'pretool'], {
      input: JSON.stringify({ cwd, tool_name: tool, tool_input: input, session_id: sessionId }),
      cwd,
      env,
      encoding: 'utf8',
    });
    return { status: 0, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    return { status: err.status ?? -1, stderr: String(err.stderr ?? '') };
  }
}

function twoRepoFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-hook2-'));
  for (const id of ['repo-a', 'repo-b']) {
    const abs = path.join(root, id);
    fs.mkdirSync(path.join(abs, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(abs, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(abs, 'PLAN.md'),
      `# PLAN: ${id}\n\n| M | 名称 |\n|---|---|\n| M1 | first |\n`,
    );
    fs.writeFileSync(
      path.join(abs, 'TODO-M1.md'),
      `# TODO-M1: first\n\n> 状态：实现中\n\n- **影响文件**：\n  - \`src/lib.rs\`\n`,
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
  }
  execFileSync(
    process.execPath,
    [CLI, 'init', '--root', root, '--repo', 'repo-a', '--repo', 'repo-b', '--install-hooks'],
    { encoding: 'utf8' },
  );
  return { root, a: path.join(root, 'repo-a'), b: path.join(root, 'repo-b') };
}

test('pretool blocks cross-repo writes and enforcement-plane files', {
  skip: !fs.existsSync(CLI),
}, () => {
  const { root, a, b } = twoRepoFixture();

  assert.equal(
    hookStatus('plan', 'repo-a', a, 'Write', { file_path: path.join(b, 'PLAN.md') }).status,
    2,
  );
  assert.equal(
    hookStatus('todo', 'repo-a', a, 'Edit', { file_path: path.join(b, 'src/lib.rs') }).status,
    2,
  );
  assert.equal(
    hookStatus('todo', 'repo-a', a, 'Write', { file_path: path.join(a, '.claude/settings.json') })
      .status,
    2,
  );
  assert.equal(
    hookStatus('todo', 'repo-a', a, 'Write', { file_path: path.join(a, '.mcp.json') }).status,
    2,
  );
  assert.equal(
    hookStatus('todo', 'repo-a', a, 'Write', { file_path: path.join(a, 'docs/agent-questions.md') })
      .status,
    2,
  );
  assert.equal(
    hookStatus('main', null, root, 'Write', {
      file_path: path.join(root, '.workflow/runtime/approvals/ap-x.json'),
    }).status,
    2,
  );
});

test('pretool blocks git global options and self-approval', { skip: !fs.existsSync(CLI) }, () => {
  const { root, a, b } = twoRepoFixture();
  for (const command of [
    `git -C ${b} push`,
    'git -c user.name=x commit -m x',
    'git --git-dir=.git push',
    'mpt-workflow approve ap-x',
    'mpt-workflow commit ap-x',
  ]) {
    const r = hookStatus('todo', 'repo-a', a, 'Bash', { command });
    assert.equal(r.status, 2, command);
  }
  assert.equal(
    hookStatus('todo', 'repo-a', a, 'Bash', { command: 'git status --short' }).status,
    0,
  );
  // Root/umbrella commits go through the MCP approval tool too; the hook still
  // refuses a main session's Bash git commit at the umbrella root.
  const rootCommit = hookStatus('main', null, root, 'Bash', {
    command: 'git commit -m "docs: umbrella"',
  });
  assert.equal(rootCommit.status, 2);
  assert.match(rootCommit.stderr, /MCP/);
});

test('pretool fails closed on invalid role, malformed config and malformed input', {
  skip: !fs.existsSync(CLI),
}, () => {
  const { a } = twoRepoFixture();
  const invalidRole = hookStatus('PLAN', 'repo-a', a, 'Write', {
    file_path: path.join(a, 'src/lib.rs'),
  });
  assert.equal(invalidRole.status, 2);
  assert.match(invalidRole.stderr, /无效角色/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-badcfg-'));
  fs.mkdirSync(path.join(root, '.workflow'), { recursive: true });
  fs.writeFileSync(path.join(root, '.workflow/program.yaml'), 'program: [unclosed\n');
  assert.equal(
    hookStatus('todo', 'repo-a', root, 'Write', { file_path: path.join(root, 'x.ts') }).status,
    2,
  );

  try {
    execFileSync(process.execPath, [CLI, 'hook', 'pretool'], {
      input: 'not json',
      env: { ...process.env, WF_ROLE: 'todo', WF_REPO: 'repo-a' },
      encoding: 'utf8',
    });
    assert.fail('malformed hook input should fail closed');
  } catch (e) {
    assert.equal((e as { status?: number }).status, 2);
  }
});

test('pre-commit refuses to commit in a repo the role is not bound to', {
  skip: !fs.existsSync(CLI),
}, () => {
  const { b } = twoRepoFixture();
  fs.writeFileSync(path.join(b, 'src/lib.rs'), 'fn f() { 1 }\n');
  git(b, ['add', '-A']);
  try {
    git(b, ['commit', '-qm', 'pwn'], { WF_ROLE: 'plan', WF_REPO: 'repo-a' });
    assert.fail('cross-repo pre-commit should have blocked');
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    assert.equal(err.status, 1);
    assert.match(String(err.stderr), /不能在 repo-b 提交/);
  }
});

test('init repairs stale MCP and hook CLI paths', { skip: !fs.existsSync(CLI) }, () => {
  const { root, a } = twoRepoFixture();
  const mcpFile = path.join(root, '.mcp.json');
  const settingsFile = path.join(a, '.claude/settings.json');
  const preCommit = path.join(a, '.git/hooks/pre-commit');
  const missing = '/definitely/missing/dist/cli.js';

  const mcp = JSON.parse(fs.readFileSync(mcpFile, 'utf8')) as {
    mcpServers: { workflow: { command: string; args: string[] } };
  };
  mcp.mcpServers.workflow.args = [missing, 'mcp', '--root', root];
  fs.writeFileSync(mcpFile, JSON.stringify(mcp, null, 2) + '\n');
  fs.writeFileSync(settingsFile, fs.readFileSync(settingsFile, 'utf8').replaceAll(CLI, missing));
  fs.writeFileSync(preCommit, fs.readFileSync(preCommit, 'utf8').replaceAll(CLI, missing));

  execFileSync(
    process.execPath,
    [CLI, 'init', '--root', root, '--repo', 'repo-a', '--repo', 'repo-b', '--install-hooks'],
    { encoding: 'utf8' },
  );

  assert.ok(!fs.readFileSync(mcpFile, 'utf8').includes(missing));
  assert.ok(!fs.readFileSync(settingsFile, 'utf8').includes(missing));
  assert.ok(!fs.readFileSync(preCommit, 'utf8').includes(missing));
  const repaired = JSON.parse(fs.readFileSync(mcpFile, 'utf8')) as {
    mcpServers: { workflow: { args: string[] } };
  };
  assert.ok(repaired.mcpServers.workflow.args[0].endsWith('cli.js'));
  assert.ok(fs.existsSync(repaired.mcpServers.workflow.args[0]));
});

test('pretool reads the per-session lease instead of a global role file', {
  skip: !fs.existsSync(CLI),
}, () => {
  const { root, a, b } = twoRepoFixture();
  const env = { ...process.env } as Record<string, string>;
  delete env.WF_ROLE;
  delete env.WF_REPO;
  delete env.WF_SESSION;
  delete env.CLAUDE_CODE_SESSION_ID;
  execFileSync(
    process.execPath,
    [CLI, 'role', 'plan', '--repo', 'repo-a', '--root', root, '--session', 'sess-hook'],
    { cwd: a, env, encoding: 'utf8' },
  );

  assert.equal(
    hookStatus(null, null, a, 'Write', { file_path: path.join(a, 'PLAN.md') }, 'sess-hook').status,
    0,
  );
  assert.equal(
    hookStatus(null, null, a, 'Write', { file_path: path.join(b, 'PLAN.md') }, 'sess-hook').status,
    2,
  );
  // A different session has no lease: no role is declared.
  assert.equal(
    hookStatus(null, null, a, 'Write', { file_path: path.join(b, 'PLAN.md') }, 'sess-other').status,
    0,
  );
  assert.equal(fs.existsSync(path.join(root, '.workflow/runtime/role.json')), false);
});

test('WF_ALLOW_PATHS exempts only the named paths', { skip: !fs.existsSync(CLI) }, () => {
  const { a } = twoRepoFixture();
  fs.writeFileSync(path.join(a, 'src/extra.rs'), 'fn g() {}\n');
  git(a, ['add', 'src/extra.rs']);
  git(a, ['commit', '-qm', 'feat: allowed'], {
    WF_ROLE: 'todo',
    WF_REPO: 'repo-a',
    WF_ALLOW_PATHS: 'src/extra.rs',
    WF_ALLOW_REASON: 'reviewed manually',
  });

  fs.writeFileSync(path.join(a, 'src/extra2.rs'), 'fn h() {}\n');
  git(a, ['add', 'src/extra2.rs']);
  try {
    git(a, ['commit', '-qm', 'feat: blocked'], { WF_ROLE: 'todo', WF_REPO: 'repo-a' });
    assert.fail('a different out-of-scope file should still be blocked');
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    assert.equal(err.status, 1);
    assert.match(String(err.stderr), /影响文件/);
    assert.match(String(err.stderr), /mpt-workflow commit/);
  }
});
