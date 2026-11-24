import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = '/tmp/wftest/root';
const transport = new StdioClientTransport({
  command: 'node',
  args: ['/home/lxu/fut-trade-system/tmp/dist/cli.js', 'mcp', '--root', root, '--role', 'plan', '--repo', 'fut-algo-api'],
  stderr: 'pipe',
});
const client = new Client({ name: 'smoke', version: '1' }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map(t => t.name).join(', '));

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const txt = r.content?.map(c => c.text).join('\n') || '';
  console.log(`\n=== ${name} ${r.isError ? '[ERROR]' : ''} ===\n` + txt.slice(0, 900));
  return r;
}

await call('status');
await call('next');
await call('doctor');
await call('questions', { all: true });
// role gating: plan agent must not claim
await call('milestone_claim', { milestone: 'M3' });
// ask + answer flow
const ask = await call('ask', { to: 'main', context: 'smoke test question', blocking: false, options: ['A: yes', 'B: no'] });
await call('questions', {});
await client.close();
