# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/releases/tag/v0.1.0
