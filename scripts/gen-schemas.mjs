import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
// Import the TypeScript source (run via `node --import tsx`) so a stale dist
// build cannot produce a valid-looking but outdated schema file.
const source = path.join(root, 'src', 'mcp', 'server.ts');
if (!fs.existsSync(source)) {
  console.error(`[schemas] ${source} 不存在`);
  process.exit(1);
}

const { buildTools } = await import(pathToFileURL(source).href);
const tools = buildTools({ root }).sort((a, b) => a.name.localeCompare(b.name));

const doc = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'mpt-workflow MCP tools (v1)',
  schema_version: 1,
  tools: {},
};
for (const tool of tools) {
  const input = z.toJSONSchema(z.object(tool.schema ?? {}), { io: 'input' });
  delete input.$schema;
  doc.tools[tool.name] = { roles: tool.roles, input };
}

const text = `${JSON.stringify(doc, null, 2)}\n`;
const target = path.join(root, 'schemas', 'mcp-tools.json');
if (process.argv.includes('--check')) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (current !== text) {
    console.error('[schemas] schemas/mcp-tools.json 已过期；运行 npm run schemas 并提交');
    process.exit(1);
  }
  console.log(`[schemas] up to date (${tools.length} tools)`);
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  console.log(`[schemas] wrote ${path.relative(root, target)} (${tools.length} tools)`);
}
