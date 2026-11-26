# Troubleshooting

Start with:

```bash
mpt-workflow doctor
```

`doctor` checks config, git state, missing documents, blocking questions,
runtime size and stale absolute CLI paths.

## `mpt-workflow: command not found`

- Install it: `npm install -g mpt-workflow`
- Or run `npx mpt-workflow <command>`.
- If you are **inside the `mpt-workflow` source checkout**, npm exec can confuse
  the local package name. Run `npx` from your workspace, or use the built CLI:
  `node /path/to/mpt-workflow/dist/cli.js`.

## MCP server does not load

- Confirm `.mcp.json` exists in the directory where the session starts (root and
  each repo). `init` writes both.
- Run `mpt-workflow doctor`: `stale-cli` means `.mcp.json` or a hook points at a
  `cli.js` that no longer exists (evicted npx cache, moved checkout, missing
  build).
- Fix by re-running `mpt-workflow init --install-hooks` (or `npm run build` in a
  source checkout), then restart the Claude Code session.
- `init` writes npx-pinned commands when run through npx, so the config survives
  cache eviction; a global install uses the absolute CLI path.

## My edits are not blocked by the role ACL

The ACL is enforced by hooks, and the role is self-declared:

- Every agent session must run `bootstrap(role="plan"|"todo"|"main", repo=...)`
  or start with `WF_ROLE` / `WF_REPO`.
- No role declared → the pre-tool hook only blocks `git push`; file writes are
  not checked.
- Hooks are not installed → run `mpt-workflow init --install-hooks`.
- `--no-verify` and `WF_ALLOW_COMMIT=1` bypass the guardrails by design; so does
  editing `.git/hooks`.
- Bash writes are only best-effort checked (obvious `>` redirects). Use the
  pre-commit hook as the backstop.

## A milestone transition is refused

- **blocking message**: `mpt-workflow inbox --role <role> --repo <repo>` then
  `mpt-workflow ack <msg-id>`. Only ack clears the block; marking read does not.
- **blocking question**: answer it in the dashboard or `docs/agent-questions.md`.
  `status` / `next` show the open blocker.
- **wrong state**: `claim` needs `todo_ready`/`rejected`; `complete` needs
  `implementing` and at least one evidence run; `accept` needs `review`, a
  passing evidence entry and a plan/main role.
- **no TODO**: `claim` requires `TODO-Mn.md`. Have the plan agent write it first.

## Commit is refused

- `审批 ... 尚未由用户批准`: the human must approve the one-shot approval:
  `mpt-workflow approve ap-...` or the dashboard.
- `工作区内容已变化`: the tree changed after approval. Approving a stale tree is
  also refused; run `commit_request` again after the final edit.
- `暂存区内容已变化`: the staged content changed after approval. Re-request and
  approve again.
- `scope 检查未通过`: changed files are outside the current TODO's
  **影响文件** list (todo role) or violate the ACL. Update the TODO or revert.
- `pre-commit scope 检查未通过`: the git hook repeats the TODO/ACL check. The
  user can bypass with `WF_ALLOW_COMMIT=1` or `--no-verify`, but that is an
  explicit escape hatch.
- Bash `git commit` / `git push` is refused for `main`/`plan`/`todo` sessions.
  Use the MCP `commit` tool after approval; the human pushes.
- `mpt-workflow approve` / `mpt-workflow commit` are user actions too; the hook
  blocks them from agent Bash.
- Role/repo binding: `plan` and `todo` can only act on their bound repo. Use
  `main` for cross-repo work.
- `WF_ROLE` is case-sensitive (`main`, `plan`, `todo`, `user`); an invalid role
  or a missing `WF_REPO` makes the hook fail closed (exit 2).
- **Umbrella (`root`) commit refused**:
  - `只有 main/user 能提交伞仓`: `plan@repo`/`todo@repo` cannot commit root; ask
    the main or user session.
  - `伞仓提交包含不允许的路径`: only `CLAUDE.md`, `docs/**`, `milestone/**`,
    `.workflow/program.yaml` and `.workflow/.gitignore` are allowed. Move code
    into its component repo, and keep `.mcp.json`, `.claude/**` and runtime state
    out of the umbrella index.
  - `伞仓包含 gitlink/嵌套仓库`: a nested git repository (a component checked out
    inside the root) is staged. Add its directory to the root `.gitignore` (or
    `.git/info/exclude`) and commit it in its own repo.
  - `伞仓不是 git 仓库`: run `git init` in the workspace root first; root commits
    are optional, but they need a repository.
  - `伞仓没有可提交的改动`: nothing changed under the allowlist.
  - The user can still commit the umbrella by hand (`git commit`); the MCP flow
    exists so the diff is reviewed first.

## `evidence_run` fails or times out

- It runs `/bin/bash -lc <command>` **inside the repo**, as your user. Check the
  command works from the repo root.
- The default timeout is 15 minutes; pass `timeout_ms` for longer builds.
- A non-zero exit is recorded and does not pass acceptance. Re-run the command
  after fixing it.
- A timeout kills the whole process group (no orphan test processes).
- Evidence is written to `.workflow/runtime/evidence/<repo>/<M>/`; the TODO gets
  a truncated copy under `## 证据记录`.
- Evidence output is fenced and parsed fence-aware: a test printing `### E2`,
  `exit: 0` or `## 验收记录` cannot create a fake entry or cut the section
  short. Only the metadata lines before the fence are treated as evidence.

## Dashboard is blank or returns 403

- Open `http://127.0.0.1:<port>`, not a LAN hostname. The server binds loopback
  and rejects non-local `Host` headers.
- Cross-origin writes are refused. Use the dashboard directly; do not embed it
  in another page.
- If the page shows a load error, use its **重试** button and check the terminal
  running `mpt-workflow web`.
- Only these write actions exist: answer/close a question, approve a commit, ack
  a message, switch the active repo.

## `gc` / runtime growth

- `mpt-workflow gc` is a **dry run**. It lists processed messages, used
  approvals, stale presence and stale locks older than the threshold.
- `mpt-workflow gc --apply` deletes them. Unread messages and pending approvals
  are never deleted.
- Evidence is kept unless you pass `--evidence-days N`.
- `--older-than N` changes the processed-state threshold (default 30 days).
- `doctor` warns when `runtime/` exceeds 100 MB.

## Node.js / platform

- Node.js **22+** is required.
- macOS, Linux and WSL2 are supported. Native Windows is not supported yet:
  `evidence_run` and the hooks use bash. See
  [platform-support.md](platform-support.md).

## Where state lives

```
<root>/.workflow/program.yaml    tracked; program, repos, phases, contracts
<root>/.workflow/runtime/        gitignored; messages, approvals, evidence, events, locks
<repo>/PLAN.md                   milestone list
<repo>/TODO-Mn.md                status, declared files, acceptance, evidence
<repo>/docs/agent-questions.md   questions and answers
```

There is no status database. Deleting `runtime/` loses messages/approvals/audit
but not the plan state; `status` rebuilds from Markdown and git.
