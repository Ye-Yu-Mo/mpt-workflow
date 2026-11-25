# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Ye-Yu-Mo/mpt-workflow/releases/tag/v0.1.0
