import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { init } from '../src/core/init.js';

const CLI = path.resolve(process.cwd(), 'dist/cli.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-proto-'));
  const abs = path.join(root, 'repo-a');
  fs.mkdirSync(path.join(abs, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(abs, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(abs, 'PLAN.md'),
    '# PLAN\n\n| M | 名称 |\n|---|---|\n| M1 | first |\n',
  );
  fs.writeFileSync(path.join(abs, 'TODO-M1.md'), '# TODO-M1: first\n\n> 状态：待实现\n');
  fs.writeFileSync(path.join(abs, 'src/lib.rs'), 'fn f() {}\n');
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 't@example.com'],
    ['config', 'user.name', 't'],
    ['add', '-A'],
    ['commit', '-qm', 'init'],
  ]) {
    execFileSync('git', args, { cwd: abs });
  }
  init({ root, program: 'proto-test', repos: ['repo-a'], adopt: true });
  return { root };
}

test('MCP stdio protocol: tool discovery and a call', async (t) => {
  if (!fs.existsSync(CLI)) {
    t.skip('dist/cli.js missing; run npm run build');
    return;
  }
  const { root } = fixture();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp', '--root', root, '--role', 'plan', '--repo', 'repo-a'],
    stderr: 'ignore',
  });
  const client = new Client({ name: 'protocol-test', version: '1' }, { capabilities: {} });

  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes('status'), 'status tool is exposed');
    assert.ok(names.includes('send_message'), 'messaging tools are exposed');
    assert.ok(
      tools.find((x) => x.name === 'send_message')?.inputSchema,
      'tools carry a JSON schema',
    );

    const res = (await client.callTool({ name: 'status', arguments: {} })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    assert.ok(!res.isError, JSON.stringify(res));
    const text = res.content.map((c) => c.text).join('\n');
    assert.match(text, /repo-a/);
    assert.match(text, /M1/);

    // role gating over the wire
    const denied = (await client.callTool({
      name: 'milestone_claim',
      arguments: { milestone: 'M1' },
    })) as { content: { text: string }[]; isError?: boolean };
    assert.equal(denied.isError, true);
    assert.match(denied.content.map((c) => c.text).join(''), /不能调用/);
  } finally {
    await client.close();
    await transport.close();
  }
});

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };

function callText(res: TextResult): string {
  return res.content.map((c) => c.text).join('\n');
}

test('MCP uses WF_ROLE/WF_REPO when --role is absent', async (t) => {
  if (!fs.existsSync(CLI)) {
    t.skip('dist/cli.js missing; run npm run build');
    return;
  }
  const { root } = fixture();
  const env = { ...process.env, WF_ROLE: 'todo', WF_REPO: 'repo-a' } as Record<string, string>;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp', '--root', root],
    env,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'protocol-env', version: '1' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const status = (await client.callTool({ name: 'status', arguments: {} })) as TextResult;
    assert.match(callText(status), /本会话角色: todo/);
    const claim = (await client.callTool({
      name: 'milestone_claim',
      arguments: { milestone: 'M1' },
    })) as TextResult;
    assert.ok(!claim.isError, callText(claim));
    assert.match(callText(claim), /implementing/);
  } finally {
    await client.close();
    await transport.close();
  }
});

test('MCP without a role refuses state changes until bootstrap', async (t) => {
  if (!fs.existsSync(CLI)) {
    t.skip('dist/cli.js missing; run npm run build');
    return;
  }
  const { root } = fixture();
  const env = { ...process.env } as Record<string, string>;
  delete env.WF_ROLE;
  delete env.WF_REPO;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp', '--root', root],
    env,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'protocol-undeclared', version: '1' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const denied = (await client.callTool({
      name: 'milestone_claim',
      arguments: { milestone: 'M1' },
    })) as TextResult;
    assert.equal(denied.isError, true);
    assert.match(callText(denied), /bootstrap/);

    const boot = (await client.callTool({
      name: 'bootstrap',
      arguments: { role: 'todo', repo: 'repo-a' },
    })) as TextResult;
    assert.ok(!boot.isError, callText(boot));

    const claim = (await client.callTool({
      name: 'milestone_claim',
      arguments: { milestone: 'M1' },
    })) as TextResult;
    assert.ok(!claim.isError, callText(claim));
  } finally {
    await client.close();
    await transport.close();
  }
});
