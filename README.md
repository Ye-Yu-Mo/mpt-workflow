# mpt-workflow

**A local MCP server, CLI and dashboard that turn a multi-agent, multi-repo
PLAN → TODO → implement → accept → commit workflow into an enforceable state machine.**

[中文](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/README.zh-CN.md)

[![CI](https://github.com/Ye-Yu-Mo/mpt-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/Ye-Yu-Mo/mpt-workflow/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mpt-workflow.svg)](https://www.npmjs.com/package/mpt-workflow)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

> Status: 1.x stable. See [ROADMAP.md](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/ROADMAP.md) for the current release and
> next steps.

---

## Try it in 60 seconds

```bash
npx mpt-workflow demo
# prints a disposable workspace; then run the printed command:
npx mpt-workflow web --root <printed path> --port 7788
```

The demo creates everything under `$TMPDIR`; nothing outside it is touched.
Larger, checked-in workspaces live in [examples/](https://github.com/Ye-Yu-Mo/mpt-workflow/tree/main/examples/).

## Why

Running several Claude Code sessions against several git repos looks fine until
it doesn't:

- **Nobody knows where the work stands.** A new session has to be told "you are
  the PLAN agent for `my-service`, M3 is accepted, M4 has no TODO yet".
- **Roles are advisory.** The PLAN agent is told not to edit source. Nothing
  stops it.
- **The human is the message bus.** You copy a question from the TODO session
  into the PLAN session, then copy the answer back.
- **"It passes" is unverifiable.** Evidence is typed into a document by the same
  agent that wrote the code.
- **Commits happen mid-thought.** You wanted to review the diff first.

This tool keeps the workflow in Markdown (so it stays reviewable), and adds a
state layer on top: derived status, role-scoped writes, server-executed
evidence, one-shot commit approvals, and persistent messaging between agents.

## How it works

```
                        ┌─────────────────────────────────────────┐
   PLAN.md / TODO-Mn.md │              mpt-workflow                │
   docs/agent-questions │  parse → derive state → gate → notify    │
   .workflow/program.yaml        │            │           │
                        └────────┼────────────┼───────────┼────────┘
                                 │            │           │
                          MCP tools     PreToolUse    pre-commit
                          (Claude)        hooks         hooks
                                 │            │           │
                            ┌────▼────────────▼───────────▼────┐
                            │  Claude Code sessions by role    │
                            │  main · plan@repo · todo@repo    │
                            └───────────────┬──────────────────┘
                                            │
                                   ┌────────▼─────────┐
                                   │ localhost:7788   │
                                   │ dashboard (user) │
                                   └──────────────────┘
```

Three principles:

1. **Markdown is the source of truth.** `PLAN.md`, `TODO-Mn.md`,
   `docs/agent-questions.md`, `.workflow/program.yaml` are human-readable and
   git-reviewable. The tool derives state from them; it never invents a second
   database of record.
2. **The MCP server is not the enforcement boundary.** Agents edit files with
   `Edit`/`Write`, which never touches MCP. Real enforcement is a
   `PreToolUse` hook (blocks out-of-role writes and `git push`) plus a
   `pre-commit` hook (scope check).
3. **The human approves, the machine remembers.** Commits use a one-shot
   approval bound to the exact working-tree hash; messages and status survive
   restarts and new sessions.

## Requirements

- Node.js **22+** (Node 20 reached end-of-life in April 2026)
- git
- macOS, Linux, or WSL2. Native Windows is not supported yet — see
  [docs/platform-support.md](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/docs/platform-support.md).
- [Claude Code](https://claude.com/claude-code) — the supported MCP client and
  hook host. Other MCP stdio clients can connect, but hook-based enforcement is
  Claude Code-specific.

## Language and clients

This project is **Chinese-first**: CLI output, the dashboard, MCP tool
descriptions and server instructions are Chinese. The English README is for
discovery. We do not ship half-translations; a full locale layer is a
demand-driven, post-1.0 option.

**Claude Code is the supported client.** It provides the `PreToolUse` /
`SessionStart` hooks that enforce the role ACL and commit gate. Other MCP stdio
clients are not documented yet: without those hooks, only the MCP tools and the
git pre-commit hook enforce anything. See
[docs/support-scope.md](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/docs/support-scope.md) for the reasoning and what would
change it.

## Install

```bash
npm install -g mpt-workflow
mpt-workflow --help

# or run it without a global install
npx mpt-workflow --help
```

The npm package name is **`mpt-workflow`**. `workflow-mcp` is already taken by
an unrelated package, so do not install or run that name.

Source install (for development):

```bash
git clone git@github.com:Ye-Yu-Mo/mpt-workflow.git
cd mpt-workflow
npm install
npm run build
node dist/cli.js --help
```

`npm link` puts the `mpt-workflow` and `mpt` binaries on your `PATH`.

## Quick start

```bash
# Try it in a throwaway workspace (nothing outside $TMPDIR is touched)
mpt-workflow demo

# Adopt an existing multi-repo workspace (idempotent; never overwrites files)
mpt-workflow init --root /path/to/workspace

# Add the enforcement hooks (recommended)
mpt-workflow init --root /path/to/workspace --install-hooks

# See where things stand
mpt-workflow status --root /path/to/workspace
mpt-workflow next

# Open the dashboard
mpt-workflow web --root /path/to/workspace --port 7788
```

Every command also works as `npx mpt-workflow <command>`.

## Examples

| Example | Shows |
|---|---|
| [examples/minimal](https://github.com/Ye-Yu-Mo/mpt-workflow/tree/main/examples/minimal/) | One repo, two milestones, a question board |
| [examples/multi-repo](https://github.com/Ye-Yu-Mo/mpt-workflow/tree/main/examples/multi-repo/) | Serial `active_repo` lock and umbrella contract docs |
| [examples/rust](https://github.com/Ye-Yu-Mo/mpt-workflow/tree/main/examples/rust/) | `cargo test` evidence and the Cargo ACL entries |

They are parsed by `tests/examples.test.ts`, so the checked-in Markdown cannot
silently rot.

Want to see it work first? `mpt-workflow demo` builds a throwaway workspace,
adopts it, prints status and sends a message. Nothing outside `$TMPDIR` is
touched. From a source checkout, `./scripts/demo.sh` does the same.

`init` writes:

| Path | Purpose |
|---|---|
| `.workflow/program.yaml` | program, repos, phases, active repo, contracts — **tracked in git** |
| `.workflow/.gitignore` | keeps `runtime/` out of git |
| `<root>/.mcp.json`, `<repo>/.mcp.json` | registers the MCP server (excluded via `.git/info/exclude`) |
| `<repo>/docs/agent-questions.md` | created only if missing |
| `.claude/settings.json` | only with `--install-hooks` |
| `.git/hooks/pre-commit` | only with `--install-hooks` |

## Roles

| Role | Address | May write | Must not write |
|---|---|---|---|
| `main` | `main` | umbrella docs, decisions, `PLAN.md`/`TODO-*.md` | source code, tests, manifests |
| `plan` | `plan@repo` | repo `PLAN.md`, `TODO-*.md`, `docs/**`, `MS-*/**` | source, manifests, other repos |
| `todo` | `todo@repo` | anything in the bound repo | `PLAN.md`, `TODO-*.md`, umbrella |
| `user` | `user` | everything (final authority) | — |

The umbrella root is a **sentinel** (`root`), not a configured repo: no role can
plan or implement there, and only `main`/`user` may commit its docs (see
[Umbrella (`root`) commits](#umbrella-root-commits)).

Declare the role per session. The lease is stored **per session key** — Claude
Code's session id, `WF_SESSION`, or a generated MCP key — not in one global
file. Environment variables remain the simplest way to run sessions
concurrently; `bootstrap` writes the same per-session lease:

```bash
WF_ROLE=plan WF_REPO=my-service claude
WF_ROLE=todo WF_REPO=my-service claude
WF_ROLE=main claude
```

Or call `bootstrap(role="plan", repo="my-service")` as the first tool in the
session.

`status` reports two separate things: **当前会话** (this session's role/repo)
and **全局 active repo** (the serial lock in `program.yaml`), plus the loaded
`program.yaml` version hash and timestamp. `program.yaml` is reloaded when its
mtime/size changes, so another agent's edit is visible without restarting the
server.

## The daily loop

```
plan   writes TODO-M3.md          (plain Write)
todo   milestone_claim(M3)
todo   ... code ...
todo   evidence_run("cargo test --workspace --locked")
todo   milestone_complete(M3)     → plan gets a message
plan   milestone_accept(M3)       → main and user get a message
user   reviews the diff in the dashboard, clicks Approve
agent  commit_request → commit    (local only, never pushes)
```

Every transition is idempotent and recorded. `next` tells each role what to do
based on derived state.

## Commit safety

```
agent: commit_request(message="feat: ...")
   → scope check, returns a one-shot approval id
user:  approve in the dashboard, or `mpt-workflow approve ap-xxx`
agent: commit(approval="ap-xxx")   (MCP tool)
   → refuses if the working tree changed since approval
   → local git commit only; push is always manual
```

The approval is a **guardrail against mistakes**, not an authorization system:
the server runs as your OS user. It exists so a human sees the diff before it
lands. `commit_request` stages the tree and binds the approval to the **exact
index tree oid** (plus per-file hashes). The dashboard reviews that staged diff,
and `commit` records that snapshot without re-running `git add`, so later
worktree edits are simply not part of this commit. Only changes to the staged
index make the approval stale (the error lists the files). Agent Bash calls to
`git commit` / `git push` (and `mpt-workflow approve|commit`) are refused by the
hook; commits go through the MCP tool, and the human pushes.

### Umbrella (`root`) commits

The workspace root is usually its own git repository holding the umbrella
documents. It is addressed with the sentinel repo id **`root`**, which is never
listed in `program.yaml.repos` and has no PLAN/TODO/milestone state:

```bash
# from the root, with role main:
commit_request(repo="root", message="docs: update umbrella contracts")
# user approves in the dashboard or: mpt-workflow approve ap-...
commit(repo="root", approval="ap-...")
```

`repo` may be omitted when the MCP process runs at the umbrella root. Only
`main` and `user` may commit it — `plan`/`todo` are refused, and `root` does not
change the repo binding of a session.

A root commit may contain **only** these paths:

| Allowed | Purpose |
|---|---|
| `CLAUDE.md` | umbrella agent instructions |
| `docs/**` | umbrella documentation |
| `milestone/**` | cross-repo milestones and contracts |
| `.workflow/program.yaml` | program config (tracked) |
| `.workflow/.gitignore` | keeps `runtime/` untracked |

Anything else is refused before staging: component-repo contents, nested
repositories/gitlinks, `.workflow/runtime/**`, `.mcp.json`, `.claude/**`, `.git/**`
and ad-hoc files. The approval is bound to the working tree and staged hashes
like any other commit; a later edit makes it stale. Root commits are local only;
`git push` stays a human action.

## Questions

Questions live in `docs/agent-questions.md`, but they have a status lifecycle.
The asker owns the last step:

| Status | Meaning | Who acts |
|---|---|---|
| `open` | waiting for an answer | the addressee (`to`) |
| `answered` | answer written; apply it | the asker (`from`) |
| `closed` | the asker/user closed it | — |
| `applied` | legacy/hand-written: a resolution exists without an explicit status | — |
| `canceled` | withdrawn | — |

```
ask ──▶ open ──answer──▶ answered ──apply + close──▶ closed
```

After receiving an answer, the asker must **write the conclusion into
`PLAN.md` / `TODO-Mn.md` / `decisions` and then call `close(id,
resolution=...)`**. A question that is only answered stays in the unclosed
list forever. `next` surfaces both sides: `回答非阻塞问题` for the addressee and
`应用回答并 close` for the asker. `bootstrap` and the SessionStart hook always
print the status legend; the MCP `status`/`questions` tools print it when an
answered question is in the list. Blocking (`blocking: yes`) questions stop
claim/complete/accept/reject until answered.

## Messaging and notifications

Agents don't need a human relay anymore. Events and messages are persisted,
queryable and acknowledged:

| Event | From → To |
|---|---|
| `ask` / `answer` / `close` | question participants |
| `milestone_claim` / `complete` | `todo@repo → plan@repo` |
| `milestone_accept` | `plan@repo → main, user` |
| `milestone_reject` | `plan@repo → todo@repo` |
| `commit_request` | any → `user` |
| `commit` | any → `main, user` |
| `phase_activate` | `main → all plan/todo` |

```bash
mpt-workflow inbox --role plan --repo my-service --unread
mpt-workflow read msg-...
mpt-workflow ack msg-... --note "handled"
mpt-workflow wait --role plan --repo my-service --timeout 60000
mpt-workflow watch --role main
```

- **At-least-once.** A message is a file on disk; a failed wake-up never loses it.
  Offline recipients see `queued`, promoted to `unread` on their next
  `bootstrap`/`inbox`.
- **Blocking** messages prevent `milestone_claim/complete/accept/reject` until
  acknowledged, and are surfaced first by `next` and by the SessionStart hook.
- **Expiry.** Blocking messages expire after 45 minutes by default and escalate
  to `user` and `main`.
- **Send ACL.** `todo@repo → plan@same-repo`; `todo → main` only for `alert`;
  `plan → main`; `plan → todo@same-repo`; `plan → user` only for `alert`;
  `main`, `user` and `system` are unrestricted. Cross-repo traffic goes through
  `main`.
- **Waking another agent.** An interactive Claude Code session cannot be
  injected with text from this process. Use the dashboard **relay station**:
  it groups pending messages per recipient and generates a prompt with the
  bootstrap call, message IDs, and the ack/close steps. Paste it into that
  agent's session.

## Dashboard

`mpt-workflow web` serves a single-page, local-only dashboard:

- program progress, blocking issues, unread messages, in-flight milestones
- repo cards with a milestone track, evidence and current state
- question inbox — answer inline (writes back to Markdown, notifies the asker),
  adopt the recommendation, or copy a relay message
- message panel with read/ack and **未读 / blocking / 全部** filters
- **Relay station** — pending messages for `plan@repo`, `todo@repo` and `main`
  grouped by recipient, each with a ready-to-paste prompt (bootstrap, message
  IDs, ack and question-close rules). Interactive Claude Code sessions cannot be
  woken from another process, so the final paste is still yours; the dashboard
  removes the manual prompt-writing.
- pending commit approvals with a **diff review** (file list, stat, unified
  diff, including new/untracked files) before you approve; a changed worktree is
  flagged and approval is disabled. A new `commit_request` supersedes older
  pending approvals for the repo; stale ones are hidden behind **显示已失效**,
  and an oversized diff is marked as truncated
- copyable agent session command (`WF_ROLE=… WF_REPO=… claude`) for each next
  action, and a **设为 active** control on each repo card
- environment checks and an event timeline
- inline write errors (a fixed toast), so a failed ack/answer/approve is visible

The dashboard auto-refreshes every 15 seconds, but **pauses while you are
typing or reviewing a milestone**, preserves drafts and the open milestone
detail, restores focus after a refresh, and shows a retry banner if the API
fails.

The only write actions are: answer/close a question, approve a commit, ack a
message, mark a message read, switch the active repo.

## Maintenance

```bash
mpt-workflow doctor                          # runtime size + stale CLI paths
mpt-workflow migrate                         # preview the 1.0 config migration
mpt-workflow migrate --apply                 # add schema_version, drop machine-specific root
mpt-workflow gc                              # dry run: list eligible state
mpt-workflow gc --apply                      # delete processed messages/approvals
                                             # older than 30 days + stale presence/locks
mpt-workflow gc --apply --evidence-days 90   # also delete full evidence logs older than 90 days
```

`gc` is a dry run unless you pass `--apply`. It never removes unread messages or
pending approvals, and evidence logs are kept unless `--evidence-days` is set
(the TODO keeps a truncated tail). Use `--older-than N` to change the processed
state threshold.

## MCP tools

| Tool | Roles | Purpose |
|---|---|---|
| `bootstrap` | all | declare role, get ACL + unread summary |
| `status` / `next` / `doctor` | all | state, recommended action, environment checks |
| `questions` | all | list questions |
| `ask` / `answer` / `close` | by addressee | question lifecycle |
| `milestone_claim` / `milestone_complete` | todo, main | start / finish implementation |
| `evidence_run` | todo, plan, main | execute a command, record exit code + tree oid + output |
| `milestone_accept` / `milestone_reject` | plan, main | accept with evidence / reject with reason |
| `scope_check` | all | diff vs declared files and role ACL |
| `commit_request` / `commit` | all (root: main/user) | request approval, commit with it |
| `phase_activate` | main, user | serial repo lock; phase switch is explicit (`accept_previous`) |
| `send_message` / `inbox` / `read_message` / `ack_message` | all (ACL) | targeted messages |
| `wait_message` | all | long-poll for the next message |
| `broadcast` / `presence` / `escalate` | main / all / all | broadcast, presence, escalation |

Machine-readable input schemas:
[`schemas/mcp-tools.json`](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/schemas/mcp-tools.json)
(generated by `npm run schemas`; `npm run schemas:check` fails when stale). The
1.0 compatibility promise for these names and fields is in
[docs/design-1.0-contract.md](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/docs/design-1.0-contract.md).

## What it reads

The parser is deliberately forgiving so existing repos can be adopted without a
rewrite:

- **Milestones** from a `PLAN.md` table (`| M1 | name | ... |`) or headings
  (`### M1 — name`), unioned with `TODO-M*.md` files.
- **Status** from YAML front matter (`status: implementing`) or a Chinese/English
  marker (`状态：已验收`, `**已验收（...）**`).
- **Allowed files** from the `**影响文件**` list in each TODO.
- **Questions** from `## Q-001 [open] to: main` blocks.
- **Evidence** from a `## 证据记录` section.

Empty or missing files degrade gracefully: a repo without a `PLAN.md` shows up
as "no milestones", not an error.

## Safety model

Read [SECURITY.md](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/SECURITY.md) before running this on a shared machine.

- `evidence_run` executes arbitrary shell commands **as your user**, by design.
  It has the same trust level as your terminal.
- The dashboard binds `127.0.0.1` only and has no authentication.
- Hooks are guardrails, not a sandbox; `git commit --no-verify` and
  `WF_ALLOW_COMMIT=1` bypass the scope check.
- Bash-path ACLs only inspect obvious redirects. Use the pre-commit hook as the
  backstop.

## Repository layout

```
src/core/     parsing, state machine, ACL, git, evidence, approvals, messages
src/mcp/      MCP server (25 tools)
src/web/      HTTP API + single-page dashboard
src/cli.ts    init / status / doctor / web / mcp / hook / inbox / send ...
tests/        node:test suites (incl. real examples + MCP stdio)
docs/         architecture and requirement notes
```

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run typecheck:tests  # typecheck the test suite too
npm run lint        # Biome: formatting + lint
npm run format      # Biome: write safe fixes
npm test            # runs the node:test suites via tsx
npm run build       # tsc + copies the dashboard assets into dist/
```

See [CONTRIBUTING.md](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/CONTRIBUTING.md) for the full workflow, and
[docs/architecture.md](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/docs/architecture.md) for the design rationale.
Stuck? See [docs/troubleshooting.md](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/docs/troubleshooting.md).

## License

[MIT](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/LICENSE)
