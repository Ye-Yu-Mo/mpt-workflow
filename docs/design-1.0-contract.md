# 1.0 compatibility contract (design)

> Status: proposal for the 1.0 line, written after v0.9.0.
> This document is a design; it does not change the current behavior.
> Scope: what 1.0 promises to keep stable, how it evolves, and how users
> migrate.

## 1. Why 1.0

The 0.x line moved quickly. 1.0 is not a feature milestone; it is a promise:

- existing workspaces keep parsing and keep running;
- MCP clients can rely on tool names and inputs;
- upgrades within 1.x are additive and documented;
- a breaking change is a major-version event with a migration path.

The product is still local, single-user and Claude Code-first. 1.0 does not add
authentication, remote state, a database or auto-push.

## 2. What is frozen

### 2.1 MCP tools

The tool **names**, **roles** and **input field names** are frozen. Tool text
output is human-facing and may be reworded; agents must not parse it.

| Tool | Roles | Input fields |
|---|---|---|
| `bootstrap` | all | `role`, `repo` |
| `status` | all | `repo` |
| `next` | all | — |
| `doctor` | all | — |
| `questions` | all | `to`, `status`, `blocking`, `all` |
| `ask` | all | `to`, `context`, `blocking`, `blocking_note`, `options`, `recommendation`, `repo` |
| `answer` | all | `id`, `answer`, `resolution` |
| `close` | all | `id`, `resolution` |
| `send_message` | all | `to`, `to_repo`, `kind`, `subject`, `body`, `refs`, `blocking`, `expires_at`, `idempotency_key` |
| `inbox` | all | `role`, `repo`, `unread_only`, `include_acked`, `kind`, `limit` |
| `read_message` | all | `id` |
| `ack_message` | all | `id`, `note` |
| `wait_message` | all | `role`, `repo`, `timeout_ms` |
| `broadcast` | `main` | `kind`, `subject`, `body`, `refs` |
| `presence` | all | `session` |
| `escalate` | all | `id`, `reason` |
| `milestone_claim` | `todo`, `main` | `milestone`, `repo` |
| `milestone_complete` | `todo`, `main` | `milestone`, `repo` |
| `evidence_run` | `todo`, `plan`, `main` | `command`, `milestone`, `repo`, `cwd`, `timeout_ms` |
| `milestone_accept` | `plan`, `main` | `milestone`, `repo`, `note`, `force` |
| `milestone_reject` | `plan`, `main` | `milestone`, `reason`, `repo` |
| `scope_check` | all | `milestone`, `repo`, `as_role` |
| `commit_request` | all (`root`: `main`/`user`) | `message`, `repo`, `milestone` |
| `commit` | all (`root`: `main`/`user`) | `approval`, `repo`, `dry_run` |
| `phase_activate` | `main`, `user` | `repo`, `phase` |

New optional inputs may be added in a minor release. New tools may be added.
Renaming or removing a tool/field requires a major release and an alias period.

The sentinel repo id `root` is part of the contract: it means the umbrella
root's allowlisted docs and is never a configured repo.

### 2.2 `program.yaml`

Frozen: field names, types and defaults.

```yaml
program: string            # defaults to the root directory name
repos:                     # component repositories
  - id: string             # unique, used as repo@id
    path: string           # relative to the root (absolute is accepted)
    branch?: string
    role?: string
    notes?: string
phases:
  - id: string
    title: string          # defaults to id
    status: planned|active|accepted|done   # defaults to planned
    repos: string[]
    exit_criteria?: string[]
active_repo: string|null   # serial lock; null means none
contracts?:                # optional
  - name: string
    ref: string
    pinned_sha?: string|null
    repos?: string[]
```

- `root` is runtime state, not configuration; it is not written back.
- Unknown keys and hand-written comments are preserved on mutation.
- `program.yaml` stays tracked by git.
- 1.0 adds an optional `schema_version: 1`; a missing value is treated as 1.

### 2.3 Markdown documents

| File | Frozen contract |
|---|---|
| `<repo>/PLAN.md` | milestone table `| M1 | title | ... |` and/or `### M1 — title` headings; `版本` / `状态` / `程序阶段` lines |
| `<repo>/TODO-Mn.md` | `# TODO-Mn: title`; status line `> 状态：…` (or front-matter `status:`); `**影响文件**` list; `## 验收标准`; `## 证据记录`; `## 验收记录` |
| `docs/agent-questions.md` | `## Q-n to: role` heading, `- field: value` lines, options, answer/resolution |

Status labels: `草稿`/`planned` → `待实现`/`todo_ready` → `实现中`/`implementing`
→ `待验收`/`review` → `已验收`/`accepted` → `已提交`/`committed`;
`已打回`/`rejected` is the rework branch. `committed` is derived from a clean
working tree, not only from the status line.

The parser stays forgiving: emphasis, parenthetical notes, front-matter and
English labels continue to work. New aliases are additive; removing a label is
a breaking change.

### 2.4 CLI

Commands, positional arguments and flags are frozen:

`init`, `status`, `next`, `doctor`, `gc`, `questions`, `answer`, `inbox`,
`read`, `ack`, `send`, `wait`, `watch`, `escalate`, `presence`, `approve`,
`commit`, `activate`, `role`, `acl`, `web`, `mcp`, `hook`, `demo`, `version`.

Exit codes: `0` success, non-zero failure; hooks use `2` to block. Help text
and human output are not frozen. New flags are additive; boolean flags accept
`--flag`, `--flag=false` and `--flag false`.

### 2.5 Integration points

- Environment: `WF_ROLE`, `WF_REPO`; hook subcommands `hook pretool` and
  `hook session-start` (stdin JSON, exit 0 allow / 2 block).
- On-disk: `<root>/.workflow/program.yaml` and `<root>/.workflow/runtime/` (the
  runtime layout is internal and may change; only the directory boundary is
  promised).
- Dashboard and its HTTP API are **not** a public API; they may change with the
  UI.

## 3. Change policy

| Change | Version |
|---|---|
| new tool, new optional input, new alias, new status synonym | minor |
| new `program.yaml` optional field | minor |
| wording, UI, internal runtime layout, dashboard API | patch/minor |
| remove/rename a tool or required input | major + deprecation |
| change a default that alters state semantics | major |
| change the meaning of an existing field | major |

Deprecation: announce in `CHANGELOG` and `doctor` for at least one minor
release, keep the old behavior working, then remove in the next major. When
possible, accept the old spelling as an alias for the whole 1.x line.

## 4. Migration

- 0.x workspaces are expected to run unchanged on 1.0; no bulk rewrite is
  planned.
- `program.yaml` gains `schema_version: 1` on the next write. Unknown 0.x keys
  stay untouched.
- Status labels and document headings keep their 0.x aliases.
- If a future 1.x adds a required field, `doctor` reports it and
  `mpt-workflow migrate` (planned for 1.0) applies idempotent, preview-first
  edits.
- The upgrade guide lives in `CHANGELOG` plus `docs/troubleshooting.md`; a
  dedicated `docs/upgrade-1.0.md` is added before the release.

## 5. Contract tests

Before 1.0, freeze the surface mechanically:

1. `tests/contract.test.ts` (first version in place)
   - tool names, role matrix and input keys match a checked-in snapshot;
   - `program.yaml` fixtures normalize to the documented defaults;
   - TODO/PLAN/question fixtures parse to the documented states;
   - CLI `--help` lists every frozen command.
2. `schemas/` (generated)
   - JSON Schema exported from the zod tool inputs at build time;
   - CI fails when the generated files differ from the committed ones.
3. `examples/` remain parsed by `tests/examples.test.ts` (already true).
4. A small "compat" fixture runs plan → todo → evidence → accept → commit on
   every supported Node/OS matrix in CI.

## 6. 1.0 checklist

- [x] Tool/config/CLI snapshot test in CI (`tests/contract.test.ts`).
- [ ] Generated JSON Schemas and their CI diff check.
- [ ] Every 0.x status label/heading still parses.
- [ ] `doctor` reports `schema_version` and legacy fields.
- [ ] `migrate` is preview-first and idempotent.
- [ ] Upgrade guide and deprecation ledger exist.
- [ ] At least three release trains (0.7 → 0.9 already exercised) pass.
- [ ] No open P1 correctness/security findings.
- [ ] `CHANGELOG` has no unreleased breaking changes.

## 7. Explicit non-goals for 1.0

- Remote/multi-tenant server, authentication, shared cloud state.
- A status database or JSON cache as the record.
- Auto-push, auto-deploy, auto-merge.
- Native Windows.
- Multiple MCP clients beyond Claude Code (demand-driven; see
  [support-scope.md](support-scope.md)).
- Replacing general project management or adding chat.

## 8. Open questions

1. **Structured MCP output.** Today every tool returns text. A future
   `structuredContent` addition is additive, but deciding the shape now avoids a
   second migration later.
2. **Dashboard API stability.** Keep it internal, or freeze a read-only subset
   for integrations?
3. **MCP protocol version.** Pin the SDK major used by 1.0 and document the
   minimum client capability.
4. **`schema_version` placement.** Top-level in `program.yaml` (proposed) vs a
   separate `.workflow/schema` file.
5. **Deprecation window.** One minor release or one calendar month, whichever
   is longer?
