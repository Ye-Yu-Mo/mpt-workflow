import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/core/config.js';
import { buildTools } from '../src/mcp/server.js';

const CLI = path.resolve(process.cwd(), 'dist/cli.js');

/**
 * Intentional 1.0 surface lock (docs/design-1.0-contract.md).
 * Adding an optional field/tool is fine; changing a name or removing one means
 * updating this file and the changelog together.
 */
const TOOL_CONTRACT: Record<string, { roles: string; inputs: string[] }> = {
  bootstrap: { roles: 'main,plan,todo,user', inputs: ['role', 'repo'] },
  status: { roles: 'main,plan,todo,user', inputs: ['repo'] },
  next: { roles: 'main,plan,todo,user', inputs: [] },
  doctor: { roles: 'main,plan,todo,user', inputs: [] },
  questions: { roles: 'main,plan,todo,user', inputs: ['to', 'status', 'blocking', 'all'] },
  ask: {
    roles: 'main,plan,todo,user',
    inputs: ['to', 'context', 'blocking', 'blocking_note', 'options', 'recommendation', 'repo'],
  },
  answer: { roles: 'main,plan,todo,user', inputs: ['id', 'answer', 'resolution'] },
  close: { roles: 'main,plan,todo,user', inputs: ['id', 'resolution'] },
  send_message: {
    roles: 'main,plan,todo,user',
    inputs: [
      'to',
      'to_repo',
      'kind',
      'subject',
      'body',
      'refs',
      'blocking',
      'expires_at',
      'idempotency_key',
    ],
  },
  inbox: {
    roles: 'main,plan,todo,user',
    inputs: ['role', 'repo', 'unread_only', 'include_acked', 'kind', 'limit'],
  },
  read_message: { roles: 'main,plan,todo,user', inputs: ['id'] },
  ack_message: { roles: 'main,plan,todo,user', inputs: ['id', 'note'] },
  wait_message: { roles: 'main,plan,todo,user', inputs: ['role', 'repo', 'timeout_ms'] },
  broadcast: { roles: 'main', inputs: ['kind', 'subject', 'body', 'refs'] },
  presence: { roles: 'main,plan,todo,user', inputs: ['session'] },
  escalate: { roles: 'main,plan,todo,user', inputs: ['id', 'reason'] },
  milestone_claim: { roles: 'todo,main', inputs: ['milestone', 'repo'] },
  milestone_complete: { roles: 'todo,main', inputs: ['milestone', 'repo'] },
  evidence_run: {
    roles: 'todo,plan,main',
    inputs: ['command', 'milestone', 'repo', 'cwd', 'timeout_ms'],
  },
  milestone_accept: { roles: 'plan,main', inputs: ['milestone', 'repo', 'note', 'force'] },
  milestone_reject: { roles: 'plan,main', inputs: ['milestone', 'reason', 'repo'] },
  scope_check: { roles: 'main,plan,todo,user', inputs: ['milestone', 'repo', 'as_role'] },
  commit_request: {
    roles: 'main,plan,todo,user',
    inputs: ['message', 'repo', 'milestone', 'files'],
  },
  commit: { roles: 'main,plan,todo,user', inputs: ['approval', 'repo', 'dry_run'] },
  phase_activate: { roles: 'main,user', inputs: ['repo', 'phase', 'accept_previous'] },
};

test('MCP tool names, roles and input fields match the 1.0 contract', () => {
  const tools = buildTools({ root: process.cwd() });
  assert.equal(tools.length, Object.keys(TOOL_CONTRACT).length);
  for (const tool of tools) {
    const expected = TOOL_CONTRACT[tool.name];
    assert.ok(expected, `unexpected tool ${tool.name}; update the 1.0 contract`);
    assert.equal(tool.roles.join(','), expected.roles, `${tool.name} roles`);
    assert.deepEqual(Object.keys(tool.schema ?? {}), expected.inputs, `${tool.name} inputs`);
  }
});

test('program.yaml defaults match the 1.0 contract', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-contract-'));
  fs.mkdirSync(path.join(root, '.workflow'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.workflow/program.yaml'),
    `program: demo
repos:
  - id: repo-a
    path: repo-a
phases:
  - id: P1
    repos: [repo-a]
`,
  );
  const cfg = loadConfig(root);
  assert.ok(cfg);
  assert.equal(cfg.schema_version, 1);
  assert.equal(cfg.root, path.resolve(root));
  assert.equal(cfg.program, 'demo');
  assert.equal(cfg.active_repo, null);
  assert.deepEqual(cfg.contracts, []);
  assert.equal(cfg.phases[0].title, 'P1');
  assert.equal(cfg.phases[0].status, 'planned');
  assert.deepEqual(cfg.phases[0].exit_criteria, []);
});

test('generated schemas match the tool inventory', () => {
  const file = path.resolve(process.cwd(), 'schemas/mcp-tools.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    schema_version: number;
    tools: Record<string, { roles: string[]; input: { properties?: Record<string, unknown> } }>;
  };
  assert.equal(doc.schema_version, 1);
  const tools = buildTools({ root: process.cwd() });
  assert.deepEqual(Object.keys(doc.tools).sort(), tools.map((t) => t.name).sort());
  for (const tool of tools) {
    assert.deepEqual(
      Object.keys(doc.tools[tool.name].input.properties ?? {}),
      Object.keys(tool.schema ?? {}),
      `${tool.name} schema drift`,
    );
  }
});

test('CLI help still lists every frozen command', { skip: !fs.existsSync(CLI) }, () => {
  const help = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  for (const cmd of [
    'init',
    'status',
    'next',
    'doctor',
    'migrate',
    'gc',
    'questions',
    'answer',
    'inbox',
    'read',
    'ack',
    'send',
    'wait',
    'watch',
    'escalate',
    'presence',
    'approve',
    'commit',
    'activate',
    'role',
    'acl',
    'web',
    'mcp',
    'hook',
    'demo',
    'version',
  ]) {
    assert.match(help, new RegExp(`\\b${cmd}\\b`), `missing command ${cmd}`);
  }
});
