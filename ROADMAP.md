# Roadmap

This project is pre-1.0. The priority is a trustworthy workflow before a larger
feature surface.

## 0.4 — hardening and first release

- [x] Trust-chain fixes: data-safe reads, evidence placement, real commit scope,
      derived `committed` state.
- [x] Package as `mpt-workflow` with `mpt-workflow` / `mpt` binaries.
- [x] Coverage gate, CodeQL, macOS CI and a pack/install smoke job.
- [x] Tag-driven release workflow with npm provenance.
- [ ] Merge the hardening PRs (#5, #6).
- [ ] Publish `0.4.0` and create the first GitHub release.
- [ ] Verify `npx mpt-workflow init` on a clean machine.

## 0.5 — adoption

- English model-facing contract (MCP tool descriptions and server instructions);
  decide the locale strategy for CLI output and the dashboard.
- Quickstart, troubleshooting and 2–3 real examples (`minimal`, `multi-repo`,
  `rust`).
- Biome lint + formatter.
- Message/evidence retention (`archive` / `gc`) and a runtime-size doctor check.
- `doctor` checks for stale hook/CLI paths.
- More MCP clients in the docs (Cursor, Codex CLI, VS Code).

## 1.0 — stable contract

- Freeze tool names/schemas and the `program.yaml` schema, with migrations.
- Prove the release train across at least three releases.
- Explicit deprecation policy and upgrade guide.
- Decide native Windows support from demand and CI feasibility.

## Not planned

- A remote or multi-tenant server, authentication and shared cloud state. The
  design is single-machine and single-user by intent.
- A status database or JSON cache as the record; Markdown + git stays the source
  of truth.
- Auto-push, auto-deploy or auto-merge.
- Replacing general project management or adding arbitrary chat.
