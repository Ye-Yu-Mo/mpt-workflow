#!/usr/bin/env node
/**
 * Synthetic load test for the workflow core, message store and dashboard.
 *
 *   node --import tsx scripts/bench.mjs
 *   BENCH_REPOS=8 BENCH_MILESTONES=30 BENCH_MSGS=5000 npm run bench
 *
 * It creates a throwaway workspace under $TMPDIR and prints p50/p95/ops per
 * operation. Nothing outside $TMPDIR is touched (unless BENCH_KEEP=1, which
 * keeps the workspace for inspection and prints its path).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { configPath } from '../src/core/config.ts';
import { appendEvidenceFile } from '../src/core/docs.ts';
import { gitInfo } from '../src/core/git.ts';
import { init } from '../src/core/init.ts';
import { buildTools, invokeTool } from '../src/mcp/server.ts';
import { startWebServer } from '../src/web/server.ts';
import { Workflow } from '../src/core/workflow.ts';

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
};
const REPOS = num('BENCH_REPOS', 5);
const MILESTONES = num('BENCH_MILESTONES', 20);
const MSGS = num('BENCH_MSGS', 2000);
const EVIDENCE = num('BENCH_EVIDENCE', 500);
const STATUS_ITERS = num('BENCH_STATUS_ITERS', 20);
const MSG_ITERS = num('BENCH_MSG_ITERS', 100);
const HTTP_ITERS = num('BENCH_HTTP_ITERS', 10);
const COMMIT_ITERS = num('BENCH_COMMIT_ITERS', 10);
const KEEP = process.env.BENCH_KEEP === '1';

function git(cwd, args) {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo(root, id) {
  const repo = path.join(root, id);
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const planRows = Array.from(
    { length: MILESTONES },
    (_, i) => `| M${i + 1} | milestone ${i + 1} | x |`,
  ).join('\n');
  fs.writeFileSync(
    path.join(repo, 'PLAN.md'),
    `# PLAN: ${id}\n\n版本：bench\n\n| M | 名称 | 目标 |\n|---|---|---|\n${planRows}\n`,
  );
  for (let i = 1; i <= MILESTONES; i++) {
    const status = i === 1 ? '待实现' : '草稿';
    fs.writeFileSync(
      path.join(repo, `TODO-M${i}.md`),
      `# TODO-M${i}: milestone ${i}\n\n> 状态：${status}\n\n- **影响文件**：\n  - \`src/mod-${i}.txt\`\n\n## 验收标准\n- [ ] exit 0\n`,
    );
    fs.writeFileSync(path.join(repo, `src/mod-${i}.txt`), `module ${i}\n`);
  }
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'bench@example.com']);
  git(repo, ['config', 'user.name', 'bench']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'init']);
  return repo;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function record(name, times, extra = '') {
  const sorted = [...times].sort((a, b) => a - b);
  const total = times.reduce((a, b) => a + b, 0);
  const mean = total / times.length;
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const max = sorted[sorted.length - 1];
  console.log(
    `${name.padEnd(32)} n=${String(times.length).padEnd(4)} ` +
      `mean=${mean.toFixed(2).padStart(8)}ms p50=${p50.toFixed(2).padStart(8)}ms ` +
      `p95=${p95.toFixed(2).padStart(8)}ms max=${max.toFixed(2).padStart(8)}ms ` +
      `${extra}`,
  );
  return { name, mean, p50, p95, max };
}

function benchSync(name, fn, iters, extra = '') {
  for (let i = 0; i < Math.min(2, iters); i++) fn();
  const times = [];
  for (let i = 0; i < iters; i++) {
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  return record(name, times, extra);
}

async function benchAsync(name, fn, iters, extra = '') {
  for (let i = 0; i < Math.min(2, iters); i++) await fn();
  const times = [];
  for (let i = 0; i < iters; i++) {
    const t = performance.now();
    await fn();
    times.push(performance.now() - t);
  }
  return record(name, times, extra);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-bench-'));
const ids = Array.from({ length: REPOS }, (_, i) => `svc-${i + 1}`);
console.log(
  `workspace=${root}\nrepos=${REPOS} milestones/repo=${MILESTONES} messages=${MSGS} ` +
    `evidence=${EVIDENCE} node=${process.version}`,
);
for (const id of ids) makeRepo(root, id);
init({ root, program: 'bench', repos: ids, adopt: true });
const wf = new Workflow(root);
const tools = buildTools({ root });

// Evidence: distribute JSONL records over the first milestone of each repo.
const perRepoEvidence = Math.ceil(EVIDENCE / REPOS);
for (const id of ids) {
  const repoAbs = path.join(root, id);
  for (let i = 0; i < perRepoEvidence; i++) {
    appendEvidenceFile(repoAbs, 'M1', {
      id: `E${i + 1}`,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      command: `echo bench-${i}`,
      exitCode: 0,
      head: 'deadbee',
      tree: 'deadbee',
      dirty: false,
      outputTail: `line ${i}\n`.repeat(10),
    });
  }
}

// Message store: spread messages over plan/todo/main.
const tSend = performance.now();
for (let i = 0; i < MSGS; i++) {
  const target = i % 3;
  const repo = ids[i % ids.length];
  const actor =
    target === 0
      ? { role: 'plan', repo }
      : target === 1
        ? { role: 'todo', repo }
        : { role: 'main' };
  wf.msgs.send({
    from: { role: 'system' },
    to: actor,
    kind: i % 11 === 0 ? 'handoff' : 'event',
    subject: `bench message ${i}`,
    body: `body ${i}\n`.repeat(3),
    repo: actor.repo,
  });
}
const sendMs = performance.now() - tSend;
console.log(
  `message send: ${sendMs.toFixed(0)}ms total, ${(
    (MSGS / sendMs) *
    1000
  ).toFixed(0)} ops/s (${(sendMs / MSGS).toFixed(2)}ms/msg)`,
);

const firstRepo = ids[0];
const planActor = { role: 'plan', repo: firstRepo };
const statusCtx = { wf, role: 'main', repo: null };

benchSync('workflow.programStatus', () => wf.programStatus(), STATUS_ITERS);
benchSync(
  'gitInfo (one repo)',
  () => gitInfo(path.join(root, firstRepo)),
  STATUS_ITERS,
);
benchSync('workflow.repoState', () => wf.repoState(firstRepo), STATUS_ITERS);
benchSync('workflow.allQuestions', () => wf.allQuestions(), STATUS_ITERS);
benchSync('messages.list', () => wf.msgs.list(), MSG_ITERS);
benchSync('mcp status tool', () => invokeTool(tools, 'status', {}, statusCtx), STATUS_ITERS);
benchSync('mcp next tool', () => invokeTool(tools, 'next', {}, statusCtx), STATUS_ITERS);
benchSync(
  'messages.forActor(50)',
  () => wf.msgs.forActor(planActor, { unreadOnly: true, limit: 50 }),
  MSG_ITERS,
);
benchSync('messages.unreadCount', () => wf.msgs.unreadCount(planActor), MSG_ITERS);
benchSync('messages.blockingFor', () => wf.msgs.blockingFor(planActor), MSG_ITERS);
benchSync('config stat (no reload)', () => wf.refreshConfig(), 1000);
benchSync('config read+parse', () => {
  const text = fs.readFileSync(configPath(root), 'utf8');
  return text.length;
}, 1000);

// Snapshot request over 50 changed files.
const repoDir = path.join(root, firstRepo);
for (let i = 0; i < 50; i++) {
  fs.writeFileSync(path.join(repoDir, `src/bench-${i}.txt`), `bench ${i}\n`);
}
const changedFiles = Array.from({ length: 50 }, (_, i) => `src/bench-${i}.txt`);
benchSync(
  'commit_request (50 files)',
  () => {
    wf.requestCommit({
      repoId: firstRepo,
      message: `bench ${Math.random()}`,
      role: 'main',
      files: changedFiles,
    });
  },
  COMMIT_ITERS,
);

const server = await startWebServer(wf, 0);
try {
  await benchAsync(
    'GET /api/status',
    async () => {
      const res = await fetch(`${server.url}/api/status`);
      await res.json();
    },
    HTTP_ITERS,
  );
  await benchAsync(
    'GET /api/relay',
    async () => {
      const res = await fetch(`${server.url}/api/relay`);
      await res.json();
    },
    HTTP_ITERS,
  );
  await benchAsync(
    'GET /api/messages?role=plan',
    async () => {
      const res = await fetch(
        `${server.url}/api/messages?role=plan&repo=${encodeURIComponent(firstRepo)}`,
      );
      await res.json();
    },
    HTTP_ITERS,
  );
} finally {
  await server.close();
}

const rss = process.memoryUsage().rss / 1024 / 1024;
console.log(`rss=${rss.toFixed(0)}MB workspace=${root}`);
if (!KEEP) fs.rmSync(root, { recursive: true, force: true });
else console.log(`kept (BENCH_KEEP=1): ${root}`);
