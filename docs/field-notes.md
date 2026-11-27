# Field notes: running mpt-workflow on a 4-repo, 8-milestone program

> Written after a real two-day rollout: 4 repos, 5 roles/sessions, ~30
> milestones, 4 contract revisions and a production-like acceptance run.
> Intended as a companion to the README, not a replacement.
> Versions used: 0.8.0 → 1.4.2; notes updated for the 1.2+ approval model.

## What the state machine actually bought us

- **No silent scope creep.** Every milestone had a TODO with an explicit file
  list; the pre-commit scope check refused commits that touched anything else.
- **No self-acceptance.** `milestone_complete` is the implementer's hand-off,
  `milestone_accept` is a different session's judgement. Two real defects were
  caught at accept time that unit tests had missed.
- **Auditable approvals.** Commits could not happen without a user-approved
  snapshot; the audit log recorded who requested, who approved, and the exact
  tree that was committed.
- **Cheap context hand-off.** `status` / `next` / `inbox` replaced "what was I
  doing" conversations between sessions.

## The loop that worked

```text
main:   bootstrap(main) → status → next → write PLAN.md / phase notes
plan:   bootstrap(plan, repo) → read PLAN → write TODO-<M>.md
todo:   bootstrap(todo, repo) → milestone_claim → implement → evidence_run
        → milestone_complete
plan:   read evidence + diff → milestone_accept
main:   commit_request(files=[...]) → user approves → commit
        (push stays manual)
```

Two habits made the biggest difference:

1. **`status` / `next` before touching anything.** Every session started there;
   it resolved most "which repo am I allowed to touch" confusion.
2. **Request the commit for exactly what should land.** An approval pins an
   immutable staged snapshot. Edits made after `commit_request` are simply not
   part of that commit (they do not invalidate it); re-request if you need them
   included. A branch advance does invalidate the approval.

## Practices that prevented real incidents

### 1. Declare impact files with the exact marker

The scope checker parses `- **影响文件**:` blocks (or frontmatter `files:` /
`<!-- files: [...] -->`). A "summary" block titled
`**影响文件（本 M 提交范围汇总）**` is silently ignored, and the commit is then
rejected with a confusing per-file error. Always use the exact marker, and run
`scope_check` before `commit_request`.

### 2. Let the implementer commit its own work

An approval records the **requesting role** and the exact file set. Commit scope
is judged against that role, and the pre-commit hook validates that the
committed files match the approved set instead of re-applying the committer's
ACL. In practice, letting the `todo` session execute its own approved commit is
still the least surprising path, especially when the worktree is shared. For a
legacy/foreign path, use the narrow escape hatch (`WF_ALLOW_PATHS` /
`commit --allow-path`) with a reason rather than `WF_ALLOW_COMMIT`.

### 3. Use `handoff`/`question` for anything a human must see

Since 1.4.1 the dashboard relay hides pure `event` notifications. A task sent as
`event` lands in the agent's inbox but is invisible on the dashboard — it looks
like "the message never arrived". Send actionable items as `handoff` or
`question`; reserve `event` for audit-only notices.

### 4. Blocking messages are a stop condition

A `blocking` question or alert must be answered or acked. Unacked blocking
messages keep showing in `status` and can wedge an otherwise finished milestone.

### 5. Keep evidence in the repo, not in the TODO

`evidence_run` writes to `docs/evidence/<M>.jsonl`; the TODO stays readable.
Acceptance is much easier when the evidence file is part of the commit. Legacy
`## 证据记录` sections still parse.

### 6. One active repo at a time is a feature

The serial lock forced an ordering we would otherwise have ignored. Two repos
were "implementing" at one point; the resulting evidence calls failed until we
switched the active repo back. Sequence milestones, don't parallelise repos.

### 7. Restart the MCP process after upgrading

Upgrading the tool updates files on disk; running MCP servers keep the old code.
`program.yaml` is reloaded on mtime changes (1.1.0+), but code upgrades still
need every agent session restarted.

## Anti-patterns we hit (and how to avoid them)

| Anti-pattern | Symptom | Fix |
|---|---|---|
| Editing files after `commit_request` | the later edit is absent from the commit | request again if it should be included |
| Two sessions writing the same worktree | repeated ACL denials under a role you don't own | each session bootstraps its role first; prefer `files=[...]` |
| Hand-writing PLAN/TODO status | state machine disagrees with the file | only `milestone_*` tools change status |
| Sending tasks as `event` | task invisible on dashboard | use `handoff` |
| Free-text file lists in TODO | scope check rejects valid commits | exact `**影响文件**` marker / frontmatter |
| Committing from the wrong role | a legacy/manual commit is ACL-denied | let the implementer commit; approved MCP commits validate the approved set |
| Trusting a stale process | another session sees an old `active_repo` | 1.1.0+ hot reload; restart only for a code upgrade |

## Case notes

- **Approval churn (0.8.0).** Approvals were bound to the whole worktree,
  including untracked files, so any concurrent doc edit made them unapprovable
  before the user had read them. Fixed in 1.1.1 by binding an immutable staged
  tree; 1.2.0 added partial `files=[...]` snapshots.
- **Role overwrite (0.8.0).** A single machine-wide `role.json` meant the last
  session to bootstrap won; `main` was judged as `plan` and denied. Fixed in
  1.1.0 with per-session leases.
- **Stale `active_repo` (0.8.0).** The MCP server loaded `program.yaml` once at
  startup; a switch in another session was invisible until restart. Fixed in
  1.1.0 with mtime-based hot reload.
- **Reject storm.** A test strategy retried a permanently-failing order every
  snapshot (50 ms), producing 554 rejected rows and tripping `reject_burst`.
  Not a tool bug — but a good reminder that **retry policy belongs to the
  strategy**, while the control plane should stay out of business decisions
  (order direction, whether to stop).

## A minimal checklist for a new workspace

1. `init` with one repo per component; keep the umbrella repo as `root`.
2. Write `program.yaml` phases that match how you actually ship (not org chart).
3. For each milestone: PLAN section → TODO with exact impact files → claim →
   evidence → complete → accept.
4. Only two people write status: the planner accepts, the implementer completes.
5. Before committing: `scope_check`, then `commit_request(files=[...])` for the
   exact paths, then hand the approval id to the user.
6. Never push from an agent; keep push manual.
