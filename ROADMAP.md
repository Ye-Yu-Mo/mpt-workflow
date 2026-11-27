# Roadmap

This project is pre-1.0. The priority is a trustworthy workflow before a larger
feature surface.

## 0.4 — hardening and first release

- [x] Trust-chain fixes: data-safe reads, evidence placement, real commit scope,
      derived `committed` state.
- [x] Package as `mpt-workflow` with `mpt-workflow` / `mpt` binaries.
- [x] Coverage gate, CodeQL, macOS CI and a pack/install smoke job.
- [x] Tag-driven release workflow with npm provenance.
- [x] Merge the hardening PRs (#5, #6).
- [x] Publish `0.4.0` and create the first GitHub release.
- [x] Verify `npx mpt-workflow init` on a clean machine.

## 0.5 — adoption

- [x] Dashboard UX: diff review before approve, draft-safe refresh, message
      filters, copyable session commands, onboarding empty states.
- [x] `mpt-workflow demo` and `--version`; npx-stable init configuration.
- [x] Biome lint + formatter (`npm run lint` in CI).

## 0.6 — operations

- [x] `mpt-workflow gc`: dry-run by default; `--apply` removes processed
  messages/used approvals older than 30 days plus stale presence/locks;
  `--evidence-days` for old full evidence logs.
- [x] `doctor` reports `runtime/` size and stale CLI paths in `.mcp.json` /
  hooks.
- [x] Release `0.6.0`.

## 0.7 — QA hardening

- [x] Quickstart, troubleshooting and runnable examples (`minimal`,
  `multi-repo`, `rust`).
- [x] Permission boundary: MCP role/repo binding, fail-closed hooks,
  enforcement-plane ACL, approval/message ID validation, exact-origin CSRF,
  symlink containment, init repair.
- [x] Trust chain: latest evidence, commit/scope milestone, diff/approval
  binding, rename parsing, concurrency locks.
- [x] Dashboard: focus retention and visible write errors.
- [x] Release: idempotent publish, prerelease tags, stronger gates, npm docs
  links.
- [x] Release `0.7.0`.
- [x] Release `0.7.1` (operational leftovers).

## 0.8 — umbrella commits

- [x] `root` sentinel commit approvals for umbrella docs: `main`/`user` only,
      allowlisted paths, no component/gitlink/runtime content.
- [x] Release `0.8.0`.

## 0.9 — trust-chain finish

- [x] Fence-aware evidence parsing, atomic stale-lock reclaim,
      comment-preserving config writes.
- [x] Diff review includes untracked/new files; umbrella pending-doc hint.
- [x] Release `0.9.0`.

## Decided

- [x] **Language**: Chinese-first for the 0.x line. English README for discovery;
      no partial translation. A locale layer is demand-driven, post-1.0.
- [x] **Client support**: Claude Code only for 0.x. Other MCP stdio clients are
      demand-driven; see [docs/support-scope.md](docs/support-scope.md).
- [x] **Platform**: macOS / Linux / WSL2 for now; native Windows is deferred.

## 0.10 — 1.0 readiness

- [x] `schema_version: 1`, preview-first `migrate`, generated MCP JSON Schema.
- [x] Contract snapshot tests and a 0.x-format compatibility lifecycle fixture.
- [x] Release `0.10.0`.
- [x] Release `0.10.1` (schema write guard, question lifecycle).
- [x] Release `0.10.2` (dashboard relay station).
- [x] Release `0.10.3` (pre-1.0 audit fixes, approval lifecycle).

## 1.4 — scoped question ids

- [x] New question ids carry the repo scope; legacy ids still parse.
- [x] Release `1.4.0`.
- [x] Release `1.4.1` (no messaging on active-repo switch; relay filters events).

## 1.3 — evidence and approval lifecycle

- [x] Tracked evidence JSONL, short approval ids/prefixes, manual cancel.
- [x] Release `1.3.0`.
- [x] Release `1.3.1` (verified SHA at completion, todo sha dedupe).

## 1.2 — shared-worktree commits

- [x] Partial `commit_request(files=[...])` via an isolated temporary index.
- [x] Approval-coverage pre-commit, unified scope, `WF_ALLOW_PATHS`.
- [x] Release `1.2.0`.

## 1.1 — multi-session consistency

- [x] Per-session role leases, config hot reload with fail-closed errors.
- [x] `status` session/config fields; explicit `phase_activate` transitions.
- [x] Release `1.1.0`.
- [x] Release `1.1.1` (approval snapshot + requester scope).

## 1.0 — stable contract

Design: [docs/design-1.0-contract.md](docs/design-1.0-contract.md).

- [x] Freeze tool names/schemas and the `program.yaml` schema, with migrations.
- [x] Prove the release train across at least three releases.
- [x] Explicit deprecation policy and upgrade guide.
- [x] Release `1.0.0`.
- Revisit native Windows only if demand and CI feasibility justify it.

## Not planned

- A remote or multi-tenant server, authentication and shared cloud state. The
  design is single-machine and single-user by intent.
- A status database or JSON cache as the record; Markdown + git stays the source
  of truth.
- Auto-push, auto-deploy or auto-merge.
- Replacing general project management or adding arbitrary chat.
