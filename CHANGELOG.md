# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Config mutations refuse a `program.yaml` written by a newer schema instead of
  partially rewriting it; the explicit `schema_version` guard matches `doctor`
  and `migrate`.

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

[Unreleased]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.10.0...HEAD
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
