import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig, saveConfig } from '../src/core/config.js';
import { migrateConfig, previewConfigMigration, SCHEMA_VERSION } from '../src/core/migrate.js';

const CLI = path.resolve(process.cwd(), 'dist/cli.js');

function legacyRoot(config: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-migrate-'));
  fs.mkdirSync(path.join(root, '.workflow'), { recursive: true });
  fs.writeFileSync(path.join(root, '.workflow/program.yaml'), config);
  return root;
}

const LEGACY = `# hand-written
program: legacy
root: /old/machine/path
repos:
  - id: repo-a
    path: repo-a
phases:
  - id: P1
    title: phase
    status: active
    repos:
      - repo-a
active_repo: repo-a
contracts: []
custom_key: keep-me
`;

test('migrate previews without writing and keeps comments', () => {
  const root = legacyRoot(LEGACY);
  const file = path.join(root, '.workflow/program.yaml');
  const before = fs.readFileSync(file, 'utf8');
  const r = previewConfigMigration(root);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.ok(r.changes.some((c) => c.includes('schema_version')));
  assert.ok(r.changes.some((c) => c.includes('root')));
  assert.match(r.after, /schema_version: 1/);
  assert.match(r.after, /# hand-written/);
  assert.match(r.after, /custom_key: keep-me/);
  assert.doesNotMatch(r.after, /^root:/m);
});

test('migrate applies once and is idempotent', () => {
  const root = legacyRoot(LEGACY);
  const file = path.join(root, '.workflow/program.yaml');
  const applied = migrateConfig(root, true);
  assert.equal(applied.applied, true);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, new RegExp(`schema_version: ${SCHEMA_VERSION}`));

  const again = migrateConfig(root, true);
  assert.deepEqual(again.changes, []);
  assert.equal(again.applied, false);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('migrate refuses invalid YAML and a newer schema version', () => {
  const broken = legacyRoot('program: [unclosed\n');
  assert.throws(() => previewConfigMigration(broken), /不是合法 YAML/);

  const future = legacyRoot('program: p\nschema_version: 2\nrepos: []\nphases: []\n');
  assert.throws(() => previewConfigMigration(future), /高于当前支持/);
  const cfg = loadConfig(future);
  assert.ok(cfg);
  assert.throws(() => saveConfig(future, cfg), /高于当前支持/);
});

test('CLI migrate is a preview unless --apply is passed', { skip: !fs.existsSync(CLI) }, () => {
  const root = legacyRoot(LEGACY);
  const file = path.join(root, '.workflow/program.yaml');
  const preview = execFileSync(process.execPath, [CLI, 'migrate', '--root', root], {
    encoding: 'utf8',
  });
  assert.match(preview, /迁移预览/);
  assert.match(preview, /预览模式/);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /schema_version/);

  execFileSync(process.execPath, [CLI, 'migrate', '--root', root, '--apply'], {
    encoding: 'utf8',
  });
  assert.match(fs.readFileSync(file, 'utf8'), /schema_version: 1/);
  const again = execFileSync(process.execPath, [CLI, 'migrate', '--root', root], {
    encoding: 'utf8',
  });
  assert.match(again, /已是最新/);
});
