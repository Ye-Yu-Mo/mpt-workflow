# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0] - 2026-11-26

### Changed

- New question ids include the repo scope (`Q-<repo>-001`, `Q-root-001`); legacy
  `Q-001` ids still parse, and `status`/`next` also print the repo.

## [1.3.1] - 2026-11-26

### Fixed

- `milestone_complete` now records the verified SHA at implementation completion
  (not only at accept), so the TODO no longer lags between review and acceptance.
- `bootstrap` says “no unread messages” with a timestamp and points to `inbox`
  for messages that arrive afterwards.
- `setTodoSha` updates an existing frontmatter `sha:` instead of inserting a
  duplicate key.

## [1.3.0] - 2026-11-26

### Added

- **Tracked evidence file.** `evidence_run` now appends a truncated JSONL record
  to `<repo>/docs/evidence/<M>.jsonl` (full logs stay under
  `.workflow/runtime/evidence/`) instead of dirtying the TODO. Legacy
  `## 证据记录` sections are still parsed; `docs/evidence/**` is treated as
  machine-managed for scope/ACL.
- **Short approval ids.** New approvals use `ap-<base36 time>-<hex>`; CLI/MCP
  accept a unique prefix (`mpt-workflow approve ap-m3k9`).
- **`mpt-workflow cancel <approval-id>`** cancels a pending approval (with an
  optional reason); canceled approvals cannot be approved/committed and are
  hidden from the dashboard.
- `send_message` / CLI `send` tell you the message id, current delivery status
  and the `read_message`/`ack_message` commands to query/handle it.

### Fixed

- `status` and `next` include the question's repo, so same-numbered questions in
  different repos are distinguishable.

## [1.2.0] - 2026-11-26

### Added

- **Partial commit requests.** `commit_request(files=[...])` builds the review
  snapshot in a temporary index containing only the selected paths. The real
  index is never staged by the request or the commit, so PLAN and TODO can
  commit their own files from a shared worktree without `git stash`.
- **Approval-aware pre-commit.** The MCP commit sets `WF_APPROVAL_ID`; the hook
  verifies the committed files exactly match the approved set and skips the
  committer's ACL. A narrow `WF_ALLOW_PATHS` + `WF_ALLOW_REASON` escape hatch
  (and `mpt-workflow commit --allow-path ... --reason ...`) replaces the
  all-or-nothing `WF_ALLOW_COMMIT`.
- **Robust TODO file lists.** `parseTodo` merges every `**影响文件**` block and
  also accepts frontmatter `files: [...]` and
  `<!-- files: ["a.ts", ...] -->`; `scope_check` echoes the parsed list.
- **Focused `next`.** Repo-bound `plan`/`todo` sessions no longer get other
  repos' non-blocking actions in `next` (blocking items still surface).

### Fixed

- `questions(status="closed")` now returns closed questions; only the default
  view hides them.
- `ask` strips a leading `A)` / `B.` / `C、` from option text instead of
  rendering it twice.
- `milestone_accept` ticks `- [ ]` items in `## 验收标准`.
- Superseded approvals report their replacement instead of a generic stale
  error; accepting/committing one is refused.

## [1.1.1] - 2026-11-26

### Fixed

- **Approval commits exactly what was reviewed.** `commit_request` now records
  the exact index tree oid and per-file index hashes. `approve` ignores
  worktree-only edits made after the request, and `commit` records that staged
  snapshot **without re-running `git add`**; later worktree edits stay
  uncommitted. Stale errors list the modified/added/removed staged files instead
  of two opaque hashes. The dashboard reviews the staged diff and warns when
  the worktree has extra unstaged changes. Legacy approvals keep the old
  worktree/staged-hash behavior.
- **Commit scope follows the requester.** Approvals store `requested_by`; the
  commit scope check uses that role, so an approval requested by `main` is not
  re-judged under a `todo` committer's stricter file list.

## [1.1.0] - 2026-11-26

### Added

- **Per-session role leases.** Roles are stored under
  `.workflow/runtime/sessions/<hash>.json`, keyed by `WF_SESSION`, Claude Code's
  `CLAUDE_CODE_SESSION_ID`, or a generated MCP connection key. `bootstrap` and
  `mpt-workflow role --session ID` write the session lease; there is no
  machine-wide `role.json` anymore. `doctor` warns if a legacy file remains.
- **`program.yaml` hot reload.** Every MCP tool call, `status` and dashboard
  request checks mtime/size/inode and reloads the config, so another agent's
  edit is visible without restarting. A parse error keeps the last good config
  and blocks state-changing tools.
- **`status` identity fields.** The status output/JSON now separates
  `session` (current session role/repo/id) from `activeRepo` (global serial
  lock) and reports the loaded config `path`, `version`, `loaded_at`, `mtime`
  and parse error.
- **Explicit phase switches.** `phase_activate(phase=...)` no longer silently
  changes the previously active phase. Without `accept_previous=true` the call
  is refused; with it, the old phase moves to `accepted` and the output lists
  every transition. Transitions are recorded in the `phase_activate` event.

### Fixed

- A broken `program.yaml` now fails closed: the PreToolUse/pre-commit hooks
  refuse instead of silently bypassing the ACL, and MCP tools other than
  `status`/`doctor` return an explicit config error.
- A legacy global `runtime/role.json` is read as a migration fallback with a
  warning; new leases are per-session.

## [1.0.0] - 2026-11-26

### Changed

- **1.0 compatibility contract is in effect.** The 25 MCP tool names, roles and
  input fields, the `program.yaml` schema (`schema_version: 1`), the Markdown
  document contracts, CLI commands/exit codes and hook integration points are
  frozen; changes within 1.x are additive, and removals require a major release
  plus the deprecation ledger. See
  [docs/design-1.0-contract.md](docs/design-1.0-contract.md).
- No code changes since 0.10.3. 0.x workspaces keep working; run
  `mpt-workflow migrate` to make `schema_version` explicit. The upgrade guide is
  [docs/upgrade-1.0.md](docs/upgrade-1.0.md).
- Documentation is updated for the stable line: status, contract checklist,
  upgrade guide, deprecation ledger and architecture reference.

## [0.10.3] - 2026-11-26

### Fixed

- **Evidence metadata injection.** `evidence_run` commands are collapsed to one
  line before being written, and metadata parsing is anchored to the generated
  `- exit:`/`- head:`/`- tree:`/`- dirty:` lines. A command containing newlines
  can no longer forge a passing exit code.
- **Approval lifecycle.** A new `commit_request` supersedes older pending
  approvals for the same repo; the dashboard hides stale approvals behind
  “显示已失效” and counts only actionable ones; runtime state
  (`.workflow/runtime/**`) is excluded from the approval hash even when it is
  not gitignored. Approved-but-stale requests no longer keep resurfacing as
  pending work.
- **Closing an unanswered question** now clears the blocking message on both
  sides, so the addressee is not gated by a question that no longer exists.
- **Lock release** checks the owner token before deleting, so an old holder
  cannot remove a lock another process reclaimed.
- **`saveConfig`** trusts the on-disk `schema_version` and refuses to downgrade a
  newer file even when the caller holds a stale in-memory config; `migrate
  --apply` re-reads under the config lock.
- **`migrate`** handles `schema_version: null` and rejects a non-mapping YAML
  root with a clear error.
- **`next` question labels** such as `TODO@repo` / `plan@repo` map to the role
  instead of silently becoming `main`.
- **Relay prompts** mark message content as data, quote/indent every line, cap
  per-message/total size, and the relay API no longer promotes or expires
  another actor's messages on a polled GET. Dashboard relay errors are visible
  and its buttons keep focus across auto-refresh.

### Changed

- Unknown keys inside `phases[]` are preserved on config mutation.
- `root` is enforced as a reserved repo id: it cannot be configured, activated
  or marked active, and `doctor` reports it.
- 1.0 contract docs list `migrate`, `help`, `hook pre-commit` and
  `WF_ALLOW_COMMIT`; the deprecation ledger is in `docs/deprecation.md`.

## [0.10.2] - 2026-11-26

### Added

- Dashboard **relay station**: pending messages for `plan@repo`, `todo@repo`
  and `main` grouped by recipient, with a ready-to-paste prompt containing the
  bootstrap call, message IDs, ack requirement and question close rule.
  Interactive sessions still need the paste; the card removes the manual
  prompt-writing.

## [0.10.1] - 2026-11-26

### Fixed

- Config mutations refuse a `program.yaml` written by a newer schema instead of
  partially rewriting it; the explicit `schema_version` guard matches `doctor`
  and `migrate`.

### Changed

- Question lifecycle is visible to agents: `bootstrap`, `status`, `questions`
  and the SessionStart hook print the `open → answered → closed` legend; `next`
  tells the addressee to answer and the asker to apply the decision and
  `close`; `ask` reminds the asker to close; the generated question board
  documents the statuses.

## [0.10.0] - 2026-11-26

### Added

- 1.0 compatibility design (`docs/design-1.0-contract.md`) and the first
  contract snapshot test (`tests/contract.test.ts`) covering MCP tool
  names/roles/inputs, `program.yaml` defaults and CLI commands.
- `schema_version: 1` in `program.yaml` (written on the next mutation; missing
  means 1). `mpt-workflow migrate` previews and `--apply`s the 0.x → 1.0
  configuration migration (idempotent, comment-preserving); `doctor` warns when
  the file was written by a newer schema.
- `schemas/mcp-tools.json`, generated from the zod tool inputs by
  `npm run schemas`; CI and the release gate run `schemas:check`.
- `tests/compat.test.ts`: a 0.x-format workspace runs the full
  plan → todo → evidence → accept → commit lifecycle, and every documented
  status label still parses. Upgrade guide: `docs/upgrade-1.0.md`.

## [0.9.0] - 2026-11-26

### Fixed

- **Evidence integrity.** Evidence output is wrapped in a fence longer than any
  fence it contains, and only metadata outside code fences is parsed. A test
  that prints `### E2`, `exit: 0` or `## 验收记录` can no longer forge an entry
  or truncate the evidence section; `section`/`appendToSection` now ignore
  headings inside fences.
- **Lock reclaim.** A stale advisory lock is reclaimed with an atomic rename, so
  two waiters can no longer delete each other's fresh lock.
- **Config comments.** `init` and every config mutation update only the keys
  that changed, preserving hand-written comments and unknown keys; the
  machine-specific `root:` field is no longer written to `program.yaml`.
- **Diff review.** Dashboard diffs include untracked/new files, and the API
  marks a truncated preview instead of silently cutting it.
- **Umbrella hint.** `status`/`next` suggest committing allowlisted umbrella
  docs when the root has pending changes.

## [0.8.0] - 2026-11-25

### Added

- **Umbrella (`root`) commit approvals.** The workspace root can be committed
  through the normal one-shot approval flow using the sentinel repo id `root`
  (`commit_request(repo="root")` → user approve → `commit(repo="root")`, or omit
  `repo` when the MCP process runs at the root). Only `main`/`user` may do it;
  `plan`/`todo` are refused. Root commits are restricted to `CLAUDE.md`,
  `docs/**`, `milestone/**`, `.workflow/program.yaml` and `.workflow/.gitignore`;
  component contents, nested repositories/gitlinks, runtime state, `.mcp.json`,
  `.claude/**` and `.git/**` are rejected before staging. Approvals bind both
  the working-tree and staged hashes, and a changed tree makes them stale. The
  dashboard labels root approvals and shows root diffs; Bash `git commit` stays
  blocked for agents and nothing is ever pushed.

## [0.7.1] - 2026-11-25

### Fixed

- CLI boolean flags are parsed strictly: `--apply false` / `--apply=false` no
  longer delete, and a non-boolean value exits non-zero. `--key=value` is
  supported.
- `gc --apply` reports deletion failures and exits non-zero instead of claiming
  success.
- `next` surfaces blocking questions addressed to PLAN.
- `active_repo` is enforced for claim/complete/evidence/accept/reject.
- Agent-supplied message idempotency keys are namespaced by sender, so they
  cannot suppress workflow notifications.
- `init --no-adopt` excludes generated `.mcp.json` / `.claude` files in repos.
- SessionStart now names the real tool `ask` instead of `question_ask`.

## [0.7.0] - 2026-11-25

### Fixed

- **Release pipeline.** `npm publish` is idempotent (a re-run skips an existing
  version and still creates the GitHub release); prerelease tags use the `next`
  dist-tag; the release gate now runs test typecheck, lint, coverage, version
  sync and `npm pack --dry-run`; checkout no longer persists credentials and
  publish uses `--ignore-scripts` so the npm token is not exposed to lifecycle
  scripts.
- **Packaging/docs.** The lockfile uses the canonical npm registry, the npm
  README is English and its cross-document links are absolute, and the
  CONTRIBUTING/platform/support-scope docs match the actual Node/CI/platform
  matrix. Tests are typechecked in CI.
- **Dashboard refresh.** Auto-refresh no longer steals focus; it aborts the
  render if typing starts while requests are in flight, queues reloads instead
  of dropping them, isolates doctor/events failures, and keeps the open
  milestone/filters usable.
- **Dashboard feedback.** Write failures appear in a fixed toast (not a hidden
  form or an off-screen banner); stale approvals are flagged and cannot be
  approved; blocking messages are always merged into the list even past the
  100-message cap; repos can be activated from their card.
- **Dashboard access.** `localStorage` failures no longer blank the page;
  question/message controls have labels and expanded states; low-contrast
  muted/serious tokens were darkened; copied session commands are shell-quoted.
- **Acceptance gate.** `milestone_accept` now requires the latest evidence entry
  to pass; an older success can no longer hide a newer failing command.
- **Commit scope and approvals.** The commit uses the accepted milestone's TODO
  (not the next implementation milestone), `commit_request` stages the tree and
  records a staged hash, `approve` refuses a stale worktree, and `commit`
  re-checks the staged content. The dashboard marks stale approvals and disables
  the approve button.
- **Concurrency.** Question-board writes, TODO transitions and evidence writes
  take directory locks; config mutations reload the file before saving.
- **Parsing.** Bare `受验 SHA` values, `**改什么**` file lists and `**/` / `?`
  globs are parsed correctly; the claim notification no longer collides after a
  rework loop; status lines with annotations are replaced cleanly.
- `next` now offers the pending commit after acceptance instead of skipping to
  the next milestone.
- **Permission boundary.** MCP seeds the session role from `WF_ROLE`/`WF_REPO`
  and refuses state changes until `bootstrap`; `plan`/`todo` are repo-bound in
  MCP and in the hooks; hooks fail closed on invalid roles, malformed config and
  malformed hook input.
- Agent Bash `git commit` / `git push` (including `-C`, `-c`, `--git-dir`) and
  `mpt-workflow approve|commit` are refused. `.claude/**`, `.mcp.json`,
  `.workflow/runtime/**`, `.git/**` and the question board are denied to agent
  roles, so the enforcement plane cannot be edited through the guarded path.
- Approval and message ids are validated before touching the filesystem; the
  dashboard compares the exact `host:port` Origin and resolves symlinks before
  repo/public-directory containment checks.
- `init` repairs stale MCP/hook CLI paths instead of leaving `doctor`'s
  `stale-cli` warning unfixable.

### Changed

- Tooling: Biome 2 now formats and lints `src/`, `tests/`, `scripts/` and the
  JSON configs (`npm run lint` in CI). TypeScript is on 7.x; GitHub Actions
  checkout/setup-node are on v7, upload-artifact on v7 and action-gh-release on
  v3. `@types/node` stays on 22 and jsdom on 29 to match the advertised Node
  >=22 runtime (jsdom 30+ needs Node 22.22.2); c8 stays on 10 (c8 12 needs Node
  22.12).
- Documented the support scope: Chinese-first runtime, dashboard and MCP tool
  descriptions; Claude Code is the only supported client. Other MCP clients and
  a full locale layer are demand-driven.

### Added

- Runnable [examples](examples/) for a minimal repo, a multi-repo program with
  the serial `active_repo` lock, and a Rust crate with `cargo test` evidence.
- [docs/troubleshooting.md](docs/troubleshooting.md) covering ACL/hooks,
  blocking messages, commit refusals, evidence, dashboard access and `gc`.

## [0.6.0] - 2026-11-25

### Added

- `mpt-workflow gc`: dry-run by default; `--apply` removes processed messages
  and used approvals older than 30 days, stale presence records and stale lock
  directories. `--evidence-days N` optionally removes old full evidence logs.
- `doctor` reports the `runtime/` size and stale absolute CLI paths in
  `.mcp.json` / hooks (for example after an npx cache eviction or a moved
  checkout).

## [0.5.0] - 2026-11-25

### Added

- Dashboard: review the file list, stat and unified diff before approving a
  commit; message filters (未读 / blocking / 全部); copyable
  `WF_ROLE=… WF_REPO=… claude` session command for each next action; visible
  version and last-updated time; error banner with retry; onboarding empty
  states.
- Auto-refresh now pauses while you type or review a milestone, preserves
  question drafts and the open milestone detail, and skips hidden tabs.
- `mpt-workflow demo` creates a disposable workspace under `$TMPDIR`;
  `mpt-workflow --version` prints the package version.
- `init` writes `npx`-stable MCP/hook commands when it runs from the npx cache,
  instead of baking an evictable cache path into `.mcp.json` or git hooks.

## [0.4.0] - 2026-11-25

### Changed

- **Package identity.** The npm package is now `mpt-workflow`; the previous
  name `workflow-mcp` is taken by an unrelated package. Binaries are
  `mpt-workflow` and `mpt` (the generic `wf` alias was dropped). The package is
  no longer `private` and ships a `files` allowlist plus `prepublishOnly`.
- `committed` is now derived from git instead of being an unmaintained status:
  an accepted milestone whose TODO record is clean counts as committed.

### Fixed

- **Data safety.** Mutating reads now use `readTextRequired`; a permission or
  I/O error throws instead of silently returning an empty string that would
  overwrite the user's TODO or questions file.
- **Commit scope.** `commit_request` and `commit` now refuse changes outside the
  current TODO's declared file list, not just ACL violations.
- **Evidence placement.** New evidence is inserted into `## 证据记录` rather
  than appended to EOF, so evidence recorded after an acceptance (a rework loop)
  is still parsed.
- **Dashboard.** Loopback `Host` and same-origin checks close cross-site writes;
  path containment uses `within()`; `/api/files` is limited to workflow
  documents.
- **Evidence timeout.** Commands run in their own process group, so a timeout
  kills the whole tree instead of leaving orphaned test processes.
- **Locks.** `withLock` retries briefly instead of failing immediately when
  another session holds the lock.
- **Pre-commit hook.** Workflow-managed files (`TODO-*.md`,
  `docs/agent-questions.md`, `.mcp.json`, `.claude/**`) are exempt from the
  backstop, so a todo session can commit the milestone it just completed while
  out-of-scope source files are still rejected.
- **Dev-mode init.** `init` warns (and skips hook installation) when
  `dist/cli.js` does not exist, instead of writing hooks that point at a
  missing file.

### Added

- Coverage gate (`npm run test:coverage`, 70% lines/functions/statements, 60%
  branches) and a CI artifact.
- CodeQL analysis and a tag-driven release workflow with npm provenance.
- [docs/platform-support.md](docs/platform-support.md) (macOS / Linux / WSL2)
  and [docs/releasing.md](docs/releasing.md).

## [0.3.0] - 2026-11-25

### Added

- Protocol-level test that spawns the real MCP server over stdio, lists tools,
  calls `status` and checks role gating on the wire.

### Changed

- Require Node.js 22+ (Node 20 reached end-of-life in April 2026). CI now runs
  Node 22 and 24.
- Upgrade `zod` to v4. The MCP SDK supports both v3 and v4; the full suite,
  including the stdio protocol test, passes on v4.

## [0.2.0] - 2026-11-25

### Added

- **Agent messaging.** Persistent, addressed messages between `main`,
  `plan@repo`, `todo@repo`, `user` and `system`, stored as one JSON file per
  message plus an append-only audit log under `.workflow/runtime/messages/`.
- Message lifecycle `queued → unread → read → acked`, with `expired` and
  `escalated` outcomes. Offline recipients see `queued` until their next
  `bootstrap`/`inbox`.
- **Automatic notifications** for `ask`/`answer`/`close`,
  `milestone_claim/complete/accept/reject`, `commit_request`, `commit` and
  `phase_activate`.
- **Blocking messages** gate `milestone_claim/complete/accept/reject` until
  acknowledged; answering a question acks the blocker for its addressee.
  Stale blockers expire after 45 minutes and escalate to `user` and `main`.
- New MCP tools: `send_message`, `inbox`, `read_message`, `ack_message`,
  `wait_message`, `broadcast`, `presence`, `escalate`.
- New CLI commands: `inbox`, `read`, `ack`, `send`, `wait`, `watch`, `escalate`,
  `presence`.
- SessionStart hook now injects unread and blocking messages.
- Dashboard: unread-messages tile and a message panel with read/ack; question
  answering now notifies the asker.
- `docs/architecture.md` and `docs/requirements-messaging.md`.

### Changed

- `status` and `next` surface unread/blocking messages and prioritise blockers.
- `bootstrap` registers presence and returns an unread summary.
- The dashboard web test now starts its own server on an ephemeral port, so it
  runs in CI without a pre-started process.

### Fixed

- Empty repositories are reported as "no milestones" instead of "all done".
- Scope checks ignore workflow-managed files (`TODO-*.md`,
  `docs/agent-questions.md`, `.mcp.json`, `.claude/**`).

## [0.1.0] - 2026-11-24

### Added

- Initial release: MCP server, CLI and local dashboard for a multi-agent,
  multi-repo PLAN → TODO → accept → commit workflow.
- Markdown-derived state for `PLAN.md`, `TODO-Mn.md` and
  `docs/agent-questions.md`; `init --adopt` for existing workspaces.
- Role model (`main`, `plan`, `todo`, `user`) with path ACLs enforced by
  `PreToolUse` hooks and a git `pre-commit` scope check.
- 17 MCP tools covering status, questions, milestone transitions, server-side
  evidence (`evidence_run`), scope checks and commit approvals.
- One-shot commit approvals bound to the working-tree hash; agents cannot push.
- Dashboard with milestone tracks, question inbox, approvals, doctor and
  timeline.
- 16 tests.

[Unreleased]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.10.3...v1.0.0
[0.10.3]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/releases/tag/v0.1.0
