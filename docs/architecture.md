# Architecture

> Status: current as of v0.4.0.

`mpt-workflow` is a state layer over documents that already exist in a repo. It
does not own the plan; it reads the plan, derives state, enforces role-scoped
writes, records evidence, mediates approvals, and carries messages between
sessions.

## 1. Layers

```
┌──────────────────────────────────────────────────────────────────┐
│ 4. Presentation     CLI · MCP server (stdio) · local dashboard   │
├──────────────────────────────────────────────────────────────────┤
│ 3. Coordination     messages · presence · blocking · approvals   │
├──────────────────────────────────────────────────────────────────┤
│ 2. Derivation       parsers · state machines · scope checks      │
├──────────────────────────────────────────────────────────────────┤
│ 1. Source of truth  Markdown + program.yaml (+ git)              │
└──────────────────────────────────────────────────────────────────┘

Enforcement is orthogonal to these layers:
  Claude Code PreToolUse hook ─┐
  git pre-commit hook ─────────┴─→ the same ACL engine as layer 2
```

The single most important invariant: **there is no status database.** Every
`status` call re-reads Markdown and git. If the process dies, nothing is lost.
The only durable non-Markdown state is the append-only message/event store and
one-shot approvals, both under `.workflow/runtime/` (gitignored).

## 2. Source of truth

| File | Owns |
|---|---|
| `PLAN.md` | milestone overview: `\| M1 \| name \| ... \|` rows or `### M1 — name` headings |
| `TODO-Mn.md` | milestone status, declared files, acceptance criteria, evidence, review record |
| `docs/agent-questions.md` | questions with `## Q-001 [open] to: main` headings |
| `.workflow/program.yaml` | repos, phases, active repo, contract pins |
| git | branch, HEAD, working-tree hash, diffs |

Status is read from, in order: YAML front matter `status:`, a `状态：` marker
(including emphasised forms like `**已验收（...）**`), or absence → `planned`.
The parser is intentionally tolerant so repos can be adopted without rewriting
their history.

### Why Markdown instead of a database

The primary consumer of the plan is a human reviewing a diff. A database would
make state invisible to `git diff`, and every state change would become an
opaque binary. Markdown costs some parsing robustness and buys reviewability,
portability, and zero migration.

The trade-off is handled by never trusting a hand-written status field for
decisions that matter: `accept` re-reads git, verifies the evidence tree, and
appends a review record.

## 3. State machines

**Milestone** (`TODO-Mn.md`):

```
planned ──(write TODO)──▶ todo_ready ──claim──▶ implementing
   ▲                          ▲                     │
   │                          │                  complete
   │                          │                     ▼
   └──── rejected ◀──reject── review ◀─────────────┘
                                │
                              accept
                                ▼
                            accepted ──commit──▶ committed
```

`committed` is **derived, never written**: an accepted milestone counts as
committed once its `TODO-Mn.md` record is clean in git (the acceptance itself
has landed in history). Nothing rewrites the TODO after the commit, so the
approval stays bound to exactly the tree the user reviewed.

Transitions are implemented in `Workflow` (`src/core/workflow.ts`) and exposed by
both MCP tools and the CLI, so there is one implementation.

**Question**: `open → answered → applied → closed`, or `canceled`.

**Message**: `queued → unread → read → acked`, plus `expired` / `failed`.
Delivery is at-least-once: the message is written before any wake-up attempt.

**Program phase**: `planned → active → accepted → done`. Only one repository is
`active_repo` at a time (a serial lock); `main` changes it.

## 4. Roles and ACL

| Role | Address | Write scope |
|---|---|---|
| `main` | `main` | umbrella `docs/**`, `CLAUDE.md`, `.workflow/program.yaml`, and repo `PLAN.md`/`TODO-*.md`/`docs/**`; no source |
| `plan` | `plan@repo` | the bound repo's `PLAN.md`, `TODO-*.md`, `docs/**`, `MS-*/**`; no source, no other repos |
| `todo` | `todo@repo` | the bound repo except `PLAN.md`/`TODO-*.md`; no umbrella |
| `user` | `user` | everything |

Paths inside **any** configured repo are normalised relative to that repo, so a
rule is repo-relative for all repos, not just the bound one. Deny rules win over
allow rules.

The role is **self-declared**: the MCP process is per-session (stdio), so
`bootstrap(role, repo)` scopes that process. It prevents accidental
cross-role work; it is not authentication. Concurrent sessions should pass
`WF_ROLE`/`WF_REPO` so the hook process sees the same role.

## 5. Enforcement

An MCP server cannot stop `Edit`/`Write`, so the ACL is enforced twice outside
it:

1. **`PreToolUse` hook** (`.claude/settings.json`): receives the tool call on
   stdin, maps `Edit`/`Write`/`NotebookEdit` to a path and checks the ACL;
   blocks `git push`; requires an approved, unused, hash-matching approval for
   `git commit`. Exit code 2 blocks the call and feeds the reason back to the
   model.
2. **git `pre-commit` hook**: checks staged files against the current
   milestone's declared file list. It is a backstop for shell writes the
   `PreToolUse` hook could not parse.

Both are guardrails. `--no-verify` and `WF_ALLOW_COMMIT=1` bypass them by
design: the human is the final authority, and the hooks must not be able to lock
the user out of their own repository.

Bash path checks are best-effort: only obvious `>`/`>>` redirects are inspected.
A command that writes via an interpreter is not detectable without sandboxing,
which is out of scope.

## 6. Evidence and approvals

`evidence_run` is the only trusted evidence path:

- runs `bash -lc <command>` in the repo (same privileges as the user),
- captures exit code, stdout/stderr, `HEAD`, and the tree oid of the working
  tree (via `git stash create`, which does not modify the worktree),
- writes the full log to `.workflow/runtime/evidence/<repo>/<M>/`,
- appends a truncated copy plus metadata to `## 证据记录` in the TODO.

`accept` refuses without a passing (`exit == 0`) evidence entry and warns when
the tree changed after the latest evidence. It records the acceptor and the
review note; a `todo`-role session cannot accept.

`commit_request` snapshots a content hash of the working tree (tracked diff +
untracked file contents) and returns an approval id. `approve` is a separate,
human-only action (CLI or dashboard). `commit` refuses if the hash has changed,
so approval always refers to exactly what was reviewed. The approval is
single-use and local-only; there is no push path.

## 7. Messages

Messages are addressed to `role` or `role@repo`. Storage is one JSON file per
message, which keeps inspection and recovery trivial at this volume; a SQLite
store would be a drop-in replacement behind the same interface if the volume
ever justifies it.

- **Send ACL** mirrors the role model: `todo@repo → plan@repo`,
  `todo → main` (alert only), `plan → main`, `plan → todo@repo`,
  `plan → user` (alert only); `main`, `user`, `system` unrestricted.
- **Idempotency** is keyed by an explicit `idempotency_key`. Workflow-emitted
  events derive a key from `program:repo:event:milestone[:sha][:actor]`, so
  replays do not duplicate notifications.
- **Blocking** messages are checked before every milestone transition for the
  recipient. Answering a question acks the corresponding blocker for the
  addressee, including when a human answers on their behalf.
- **Expiry** is lazy: evaluated on `status`/`inbox`/`next`/`send`. Expired
  blockers produce an escalation to `user` and `main`.
- **Wake-up** is best-effort: a SessionStart hook injects unread/blocking
  summaries, and agents can long-poll with `wait_message`. Message delivery
  never depends on a wake-up succeeding.

## 8. Storage

```
<root>/.workflow/
├── program.yaml        tracked: program, repos, phases, active_repo, contracts
├── .gitignore          runtime/
└── runtime/            gitignored
    ├── events.jsonl    tool-call audit
    ├── messages/       <msg-id>.json, audit.jsonl, presence/*.json
    ├── approvals/      <ap-id>.json (one-shot commit approvals)
    ├── evidence/       full command output
    ├── locks/          advisory directory locks
    └── role.json       machine-wide role lease (single-session convenience)
```

All writes are atomic (temp file + rename). Writes that must not interleave
(program config, approvals) take a directory lock with a stale timeout.

`.mcp.json` and `.claude/settings.json` written by `init` are added to
`.git/info/exclude`: they contain machine-specific absolute paths and should not
appear in the user's diff.

## 9. Extension points

- **New MCP tool**: add a `ToolSpec` in `src/mcp/server.ts`; put mutations in
  `Workflow`; add a core test and an MCP-layer role test.
- **New document format**: extend `src/core/docs.ts` or
  `src/core/questions.ts`; keep backwards compatibility and add a parser test.
- **New notification**: emit next to the mutation with an idempotency key.
- **New storage backend**: implement the `MessageStore` surface; nothing else
  depends on the file layout.

## 10. Rejected alternatives

| Alternative | Why not |
|---|---|
| Three MCP servers, one per role, filtered by tool list | A project `.mcp.json` exposes all servers to every session; filtering by registration does not work. One server + per-process role does. |
| Enforce ACL only in MCP tools | Agents write with `Edit`/`Write`, bypassing MCP entirely. |
| Store status in SQLite/JSON as the record | Loses `git diff` reviewability, which is the point of keeping plans in Markdown. |
| Auto-commit after acceptance | Removes the human review step the workflow exists to protect. |
| Push notifications from the server | MCP is pull-based; the server cannot wake an idle session. Hooks + polling + the dashboard are the honest options. |
| MS (milestone snapshot) automation in v1 | Low frequency, and duplicating the prose skill would drift. Not implemented. |

## 11. Known limitations

- Role identity is self-declared; enforcement prevents mistakes, not adversaries.
- Bash writes are only partially checked; the pre-commit hook is the backstop.
- One active repo at a time; true parallel implementation across repos is not
  supported by design.
- Single machine, single user. No multi-tenant isolation, no remote state.
- Native Windows is not supported: `evidence_run` and the installed hooks use
  bash. See [platform-support.md](platform-support.md).
- MS generation, push automation and desktop notifications are out of scope.
