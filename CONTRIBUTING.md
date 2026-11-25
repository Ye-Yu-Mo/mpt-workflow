# Contributing

Thanks for taking the time to contribute. This is a small tool with a strong
opinion about how multi-agent work should be enforced; changes that sharpen that
opinion are more welcome than changes that add surface area.

## Before you start

- **Open an issue first** for anything larger than a bug fix or a small docs
  change. Describe the problem, the workflow it affects, and the alternative you
  considered.
- **Security issues** do not go in the issue tracker. See [SECURITY.md](SECURITY.md).
- By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

```bash
node --version        # must be >= 20
npm install
npm run typecheck
npm run build
npm test
```

The test suite uses Node's built-in runner through `tsx`; there is no separate
test framework, database, or network dependency. One test starts the dashboard on
an ephemeral port and drives it with jsdom.

Useful commands:

```bash
npm run dev -- status --root /tmp/some-workspace   # run the CLI from source
node dist/cli.js web --root /tmp/some-workspace    # dashboard
```

## Layout

```
src/core/    parsing, state derivation, ACL, git, evidence, approvals, messages
src/mcp/     MCP server and tool definitions
src/web/     HTTP API and the single-page dashboard (src/web/public)
tests/       node:test suites
docs/        architecture and requirement notes
```

State lives in Markdown; see [docs/architecture.md](docs/architecture.md) for the
invariants. In particular:

- Do not introduce a second source of truth (no SQLite status table, no JSON
  status cache).
- Do not trust hand-written status fields; derive them.

## Adding an MCP tool

1. Add a `ToolSpec` entry in `buildTools()` in `src/mcp/server.ts`:
   - `name` — short, snake_case, no `workflow_` prefix.
   - `roles` — the roles that may call it. Be conservative.
   - `schema` — zod fields; keep it small, every field costs context in every
     session.
   - `handler` — return a string, or `err(...)` for a user-facing failure.
2. If the tool mutates state, put the mutation in `Workflow` (`src/core/workflow.ts`)
   rather than in the handler, so the CLI and the dashboard share it.
3. If it should emit a notification, add it next to the mutation with an
   idempotency key.
4. Add a test:
   - `tests/core.test.ts` for the state machine,
   - `tests/mcp.test.ts` for role gating and the tool contract.
5. Update the tool table in `README.md` and `README.zh-CN.md`.

## Changing the parser

`src/core/docs.ts` handles `PLAN.md` and `TODO-Mn.md`; `src/core/questions.ts`
handles `docs/agent-questions.md`. Both are intentionally forgiving. When adding
a format case, add a fixture-style test in `tests/core.test.ts` with a realistic
snippet, and keep backwards compatibility with the formats already documented in
the README.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- Keep each PR focused. A PR that mixes a parser change with a UI redesign is
  hard to review.
- Include the reasoning in the PR description: what problem, what alternative
  you rejected, and what you did **not** verify.
- Add a `CHANGELOG.md` entry under `## [Unreleased]`.
- CI must be green (Node 20, 22 and 24).

## PR checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] New behaviour is covered by a test
- [ ] `README.md` / `README.zh-CN.md` updated if user-facing
- [ ] `CHANGELOG.md` updated
- [ ] No new runtime dependency unless justified (the tool targets a small
      dependency surface)
- [ ] No secrets, tokens, or machine-specific paths committed

## Release process (maintainers)

1. Update `package.json` version and `src/version.ts` to the same value.
2. Move `## [Unreleased]` entries in `CHANGELOG.md` under the new version.
3. `npm run build && npm test`.
4. Commit `chore(release): vX.Y.Z`, then `git tag -a vX.Y.Z -m "vX.Y.Z"` and push
   the branch and tag.
