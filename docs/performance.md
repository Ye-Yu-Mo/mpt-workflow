# Performance

`mpt-workflow` is a local, single-user tool. The workload is dominated by
filesystem reads, Markdown/YAML parsing and `git` subprocesses — not CPU.

## Run the benchmark

```bash
npm run build            # not required for the bench itself (it uses tsx)
npm run bench
BENCH_REPOS=8 BENCH_MILESTONES=30 BENCH_MSGS=5000 BENCH_EVIDENCE=1000 npm run bench
```

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `BENCH_REPOS` | 5 | component repos |
| `BENCH_MILESTONES` | 20 | TODO files per repo |
| `BENCH_MSGS` | 2000 | messages written before measuring |
| `BENCH_EVIDENCE` | 500 | JSONL evidence records |
| `BENCH_STATUS_ITERS` | 20 | `programStatus` / git iterations |
| `BENCH_MSG_ITERS` | 100 | message-store iterations |
| `BENCH_HTTP_ITERS` | 10 | dashboard HTTP iterations |
| `BENCH_COMMIT_ITERS` | 10 | 50-file `commit_request` iterations |
| `BENCH_KEEP` | — | `1` keeps the temp workspace |

The workspace is created under `$TMPDIR`; nothing outside it is touched.

## Sample results

macOS 25.5, Node 24.6, v1.4.1:

**5 repos × 20 milestones, 2,000 messages, 500 evidence records**

| Operation | p50 | p95 | Notes |
|---|---:|---:|---|
| `programStatus` | 94 ms | 138 ms | 5 × `git status` |
| MCP `status` | 92 ms | 96 ms | `programStatus` + inbox reads |
| MCP `next` | 88 ms | 103 ms | |
| `messages.list` (cached) | 1.1 ms | 1.4 ms | 2,000 messages |
| `forActor` / `unreadCount` / `blockingFor` | 1.2 ms | 1.6 ms | |
| `GET /api/status` | 85 ms | 96 ms | |
| `GET /api/relay` | 106 ms | 118 ms | 11 recipients |
| `GET /api/messages` | 7 ms | 8 ms | |
| `commit_request` (50 files) | 290 ms | 336 ms | temp index + hashes |
| message `send` | 0.17 ms/msg | — | ~5.7k/s |

**8 repos × 30 milestones, 5,000 messages, 1,000 evidence records**

| Operation | p50 | p95 |
|---|---:|---:|
| `programStatus` | 143 ms | 193 ms |
| MCP `status` / `next` | 135 / 133 ms | 147 / 140 ms |
| `messages.list` | 2.9 ms | 3.3 ms |
| `GET /api/status` | 148 ms | 168 ms |
| `GET /api/relay` | 250 ms | 277 ms |
| `GET /api/messages` | 18.6 ms | 20.7 ms |

## What the numbers mean

- **`git status` is the floor.** Each repo needs one `git status` (~14–17 ms on
  macOS). `status` is O(repos); 8 repos ≈ 130 ms even with everything else
  cached.
- **Messages are cached.** `MessageStore.list()` caches the parsed set keyed by
  the message directory's mtime/size/count; cross-process writes invalidate it.
  Before the cache, a single 2,000-message scan took ~26 ms and `GET /api/relay`
  took ~800 ms.
- **`gitInfo` is one process.** It used `rev-parse` twice plus `status`; it now
  uses `porcelain=v2 --branch -z` once, cutting status time roughly in half.
- **Relay is O(recipients × messages).** It is a local review surface; hundreds
  of milliseconds for 17 recipients and 5k messages is acceptable. Reducing it
  further would mean maintaining per-actor indexes, which the on-disk design
  deliberately avoids.
- **`commit_request` cost is the snapshot**, not the approval: temp index,
  `read-tree`, `add`, `write-tree`, per-file hashes. It is a one-shot user action.

## Practical guidance

- Keep one active repo per program phase; `status` cost grows with the number of
  configured repos.
- Use `gc --apply --older-than 7` (or ack/close messages) if inboxes grow into
  the thousands; the cache keeps reads cheap, but every process still stats the
  directory and copies the list.
- Evidence appends are O(file) per record; the full log stays in
  `.workflow/runtime/evidence/` and the tracked JSONL keeps only a truncated
  tail.
