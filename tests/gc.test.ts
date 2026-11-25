import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { approvalsDir, evidenceDir, locksDir, runtimeDir } from '../src/core/config.js';
import { runGc } from '../src/core/gc.js';
import { Workflow } from '../src/core/workflow.js';

const OLD = '2020-01-01T00:00:00.000Z';
const NOW = new Date().toISOString();

function writeJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-gc-'));
  const rt = runtimeDir(root);
  const msgDir = path.join(rt, 'messages');
  writeJson(path.join(msgDir, 'old-acked.json'), {
    id: 'old-acked',
    status: 'acked',
    created_at: OLD,
    acked_at: OLD,
  });
  writeJson(path.join(msgDir, 'new-acked.json'), {
    id: 'new-acked',
    status: 'acked',
    created_at: NOW,
    acked_at: NOW,
  });
  writeJson(path.join(msgDir, 'old-unread.json'), {
    id: 'old-unread',
    status: 'unread',
    created_at: OLD,
  });
  writeJson(path.join(msgDir, 'old-expired.json'), {
    id: 'old-expired',
    status: 'expired',
    created_at: OLD,
    expires_at: OLD,
  });
  writeJson(path.join(msgDir, 'presence/old.json'), { last_seen: OLD });
  writeJson(path.join(msgDir, 'presence/new.json'), { last_seen: NOW });
  writeJson(path.join(approvalsDir(root), 'ap-old-used.json'), {
    id: 'ap-old-used',
    created_at: OLD,
    used_at: OLD,
  });
  writeJson(path.join(approvalsDir(root), 'ap-old-pending.json'), {
    id: 'ap-old-pending',
    created_at: OLD,
  });

  const lock = path.join(locksDir(root), 'old.lock');
  fs.mkdirSync(lock, { recursive: true });
  const oldDate = new Date(OLD);
  fs.utimesSync(lock, oldDate, oldDate);

  const ev = path.join(evidenceDir(root), 'repo', 'M1');
  fs.mkdirSync(ev, { recursive: true });
  const oldEv = path.join(ev, 'old.log');
  const newEv = path.join(ev, 'new.log');
  fs.writeFileSync(oldEv, 'old output');
  fs.writeFileSync(newEv, 'new output');
  fs.utimesSync(oldEv, oldDate, oldDate);

  return { root, msgDir, oldEv, newEv, lock };
}

test('gc dry-run reports eligible state without deleting anything', () => {
  const { root, msgDir, oldEv, lock } = fixture();
  const r = runGc(root, { olderThanDays: 30, evidenceDays: 30, apply: false });

  assert.equal(r.apply, false);
  assert.equal(r.messages.total, 4);
  assert.deepEqual(r.messages.removable.map((p) => path.basename(p)).sort(), [
    'old-acked.json',
    'old-expired.json',
  ]);
  assert.equal(r.approvals.removable.length, 1);
  assert.equal(r.presence.removable.length, 1);
  assert.equal(r.locks.removable.length, 1);
  assert.equal(r.evidence.files, 2);
  assert.equal(r.evidence.removable.length, 1);
  assert.ok(r.evidence.removableBytes > 0);

  assert.ok(fs.existsSync(path.join(msgDir, 'old-acked.json')));
  assert.ok(fs.existsSync(oldEv));
  assert.ok(fs.existsSync(lock));
});

test('gc apply deletes only eligible state', () => {
  const { root, msgDir, oldEv, newEv, lock } = fixture();
  const r = runGc(root, { olderThanDays: 30, evidenceDays: 30, apply: true });

  assert.equal(r.apply, true);
  assert.ok(!fs.existsSync(path.join(msgDir, 'old-acked.json')));
  assert.ok(!fs.existsSync(path.join(msgDir, 'old-expired.json')));
  assert.ok(fs.existsSync(path.join(msgDir, 'new-acked.json')));
  assert.ok(
    fs.existsSync(path.join(msgDir, 'old-unread.json')),
    'unread messages are never removed',
  );
  assert.ok(!fs.existsSync(path.join(msgDir, 'presence/old.json')));
  assert.ok(fs.existsSync(path.join(msgDir, 'presence/new.json')));
  assert.ok(!fs.existsSync(lock));
  assert.ok(!fs.existsSync(oldEv));
  assert.ok(fs.existsSync(newEv));
  assert.ok(!fs.existsSync(path.join(approvalsDir(root), 'ap-old-used.json')));
  assert.ok(fs.existsSync(path.join(approvalsDir(root), 'ap-old-pending.json')));
  assert.ok(r.runtimeBytesAfter <= r.runtimeBytesBefore);
});

test('doctor reports stale CLI references and runtime size', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-doc-'));
  fs.mkdirSync(path.join(root, '.workflow'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.workflow/program.yaml'),
    'program: gc-test\nrepos: []\nphases: []\nactive_repo: null\ncontracts: []\n',
  );
  fs.writeFileSync(
    path.join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        workflow: {
          command: 'node',
          args: ['/definitely/missing/dist/cli.js', 'mcp', '--root', root],
        },
      },
    }),
  );

  const findings = new Workflow(root).doctor();
  assert.ok(findings.some((f) => f.code === 'stale-cli' && f.level === 'WARN'));
  assert.ok(findings.some((f) => f.code === 'runtime-size'));
});
