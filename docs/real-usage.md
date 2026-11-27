# Real usage flow: one program, four repos, three agent roles

This is the exact flow we ran in production for a 4-repo program (contract /
strategy / engine / backtest), including the commands, the order they were
issued in, and the checkpoints that mattered. It is a companion to
[field-notes.md](field-notes.md); commands and behavior are updated for 1.4.2.

Names below (`fut-algo-api`, `fut-algo-strategy`, `fut-algo-system`,
`fut-algo-backtest`, milestones `M1..M8`) are the real ones from that run.

## 0. One-time setup

```bash
mpt-workflow init --root ~/fut-trade-system --program fut-trade-system \
  --repo fut-algo-api --repo fut-algo-strategy \
  --repo fut-algo-system --repo fut-algo-backtest --install-hooks
```

Then edit `.workflow/program.yaml` once:

```yaml
phases:
  - id: P1
    title: contract freeze
    status: active
    repos: [fut-algo-api]
  - id: P2
    title: per-repo implementation (serial)
    status: planned
    repos: [fut-algo-strategy, fut-algo-system, fut-algo-backtest]
contracts:
  - name: fut-contract
    ref: fut-contract-v0.3.1
    pinned_sha: be6dbd7...
```

The umbrella repo itself is never listed as a repo; commits to it use the
sentinel `repo="root"`.

## 1. Every session starts the same way

Each agent session runs `bootstrap` first, then reads `status` and `next`:

```text
bootstrap(role="main")                  # no repo
bootstrap(role="plan", repo="fut-algo-strategy")
bootstrap(role="todo", repo="fut-algo-strategy")
```

```bash
mpt-workflow status --root ~/fut-trade-system
mpt-workflow next   --root ~/fut-trade-system
```

`status` answers three questions in one screen: which phase is active, which
repo is the serial lock holder, and which milestone each repo is on. `next`
turns that into "[role] action — repo#milestone".

Rule we followed: **nobody changes files before `status`/`next`.**

## 2. The per-milestone loop (the part that repeats)

### 2.1 Planner writes the milestone plan and TODO

`main` (or the repo's `plan` agent) appends a milestone section to
`<repo>/PLAN.md`, then the `plan` agent writes `<repo>/TODO-<M>.md`:

```markdown
## 0. 前置条件与边界
- **影响文件**：            <- exact marker, parsed by scope_check
  - `src/framework/fut_probe.rs`
  - `tests/h4_registration.rs`
  - `docs/fut-probe.md`
```

Checkpoint: `scope_check` must parse the file list (it echoes it back):

```text
scope_check(repo="fut-algo-strategy", milestone="M8")
PASS ... 影响文件清单: src/framework/fut_probe.rs, ...
```

### 2.2 Activate the repo (serial lock)

```text
phase_activate(repo="fut-algo-strategy", phase="P2")
active repo = fut-algo-strategy
```

If another phase is active, the call is refused unless `accept_previous=true`;
with the flag the output lists every transition. We switched active repo ~6
times during the run; the lock prevented two repos from "implementing" at once
(an earlier attempt failed evidence calls until we switched back).

### 2.3 Implementer claims, implements, records evidence

```text
milestone_claim(milestone="M8")

evidence_run(repo="fut-algo-strategy", milestone="M8",
             command="cargo test --workspace --locked --features probe-strategy")
exit 0   -> appended to docs/evidence/M8.jsonl

milestone_complete(milestone="M8")
```

Evidence lands in `<repo>/docs/evidence/M8.jsonl` (machine-managed, committed
with the milestone); full logs stay under `.workflow/runtime/evidence/`. The
TODO is not modified by evidence, and `milestone_complete` records the verified
SHA.

### 2.4 Planner accepts (a different session)

```text
milestone_accept(milestone="M8")
```

Acceptance is deliberately a different role than completion. In our run this is
where two real defects were caught (a startup gate timing out at 10 s, and
residual orders being parsed as `i32`).

### 2.5 Main requests the commit for the exact files

```text
scope_check(repo="fut-algo-system", milestone="M6")     # PASS, 14 files
commit_request(repo="fut-algo-system", message="feat(M6): ...")
approval ap-mwyndoob-c931fe created: 18 files
```

`commit_request(files=[...])` can restrict the snapshot to selected paths; omit
`files` to include every change. The request builds a review snapshot in a
temporary index; the real index is untouched.

### 2.6 User approves, main commits

```bash
mpt-workflow approve ap-mwyndoob-c931fe
mpt-workflow commit  ap-mwyndoob-c931fe
# or, from an agent: commit(approval="ap-mwyndoob-c931fe", repo="fut-algo-system")
```

The approval stores the **staged snapshot** (tree oid + per-file index hashes).
Anything written after `commit_request` is *not* committed; it stays in the
worktree (the dashboard warns when there are unstaged changes). A branch move
invalidates the approval; make it stale-free by re-requesting after a new
commit lands.

### 2.7 Push is always manual

No agent ever pushes. In this run the user pushed the API contract branch and
tag by hand after an explicit decision.

## 3. Questions (decisions that block a milestone)

Planner raises a decision as a question, not as chat:

```text
ask(to="main", repo="fut-algo-strategy", blocking=false,
    subject="M8 lock expectation vs reality")
-> Q-018   (legacy id from that run; 1.4+ uses Q-fut-algo-strategy-001)
```

Main answers through the tool (the `resolution` field says where to write it
back):

```text
answer(id="Q-018", answer="accept 4-line lock diff ...",
       resolution="update TODO-M8 T2 and PLAN v0.5")
```

The asker applies the resolution and closes:

```text
close(id="Q-018", resolution="applied to TODO-M8 T2 / PLAN v0.5")
```

Only `answer` without `close` leaves the question "answered" forever — that
state repeatedly showed up in `next` and was the most common loose end.

## 4. Messages: actionable vs. audit

- `handoff` / `question` → shown on the dashboard relay, meant to be acted on.
- `event` → audit only; since 1.4.1 it is hidden from the relay (a task sent as
  `event` lands in the inbox but looks "never delivered").
- `blocking=true` → must be answered or acked; it stays in `status` until then.

```text
send_message(to="plan", to_repo="fut-algo-strategy", kind="handoff",
             subject="[todo] write TODO-M8", blocking=false)
ack_message(id="msg-...", note="received")
```

Active-repo switches are not messages; they update `status` and the audit log.

## 5. Cross-repo dependency, in practice

The API contract had to be re-frozen (0.3.0 → 0.3.1) before strategy could link
it. The sequence that worked:

1. `phase_activate(repo="fut-algo-api")`, plan writes `TODO-M5`, todo
   implements + evidence, plan accepts.
2. The API commit was requested by `main`; the files were written by `todo`.
   Since 1.2.0 the pre-commit hook validates that the committed files match the
   approved set and skips the committer's ACL, so either session can execute it.
   We still let the `todo` session commit to keep ownership obvious.
3. User pushed branch + tag manually.
4. `phase_activate(repo="fut-algo-strategy")` — strategy M6 switched its pin,
   removed the local `[patch]`, and verified a clean `git clone` build.
5. Only then did the engine repo upgrade its pin.

## 6. What the umbrella repo commits look like

Umbrella documents (CLAUDE.md, docs/**, decisions) go through the same approval
machinery with the sentinel repo:

```text
commit_request(repo="root", message="docs: record M6/M8 completion ...")
approval ap-mwyq5y3y-7b5425 created: 4 files
```

Root commits are restricted to a whitelist (`CLAUDE.md`, `docs/**`,
`milestone/**`, `.workflow/program.yaml`, `.workflow/.gitignore`) and cannot
contain component repos, runtime state or nested gitlinks.

## 7. Daily close-out

```bash
mpt-workflow status
mpt-workflow gc --root ~/fut-trade-system            # dry run
git -C <repo> status --short                          # no leftovers
```

We also kept two habits:

- cancel or let the dashboard hide used/stale approvals so only pending ones are
  visible (`mpt-workflow cancel <id> --reason "..."` retires a pending one);
- drop temporary stashes only after the plan files are committed (we kept two
  stashes of PLAN versions until the final commit).

## 8. Failure modes we actually hit (command-level)

| Situation | What you see | What to do |
|---|---|---|
| Edited files after `commit_request` | the later edit is absent from the commit | request again if it should be included |
| TODO impact list uses a "summary" heading | `scope_check` misses it, commit rejected per-file | use exactly `- **影响文件**:` |
| `main` requests a commit containing `todo`-only files | approved MCP commit accepts the snapshot; a manual `git commit` is ACL-checked | use the MCP commit; for a manual/legacy path use `WF_ALLOW_PATHS` with a reason |
| Task sent as `event` | visible in inbox, hidden on dashboard | resend as `handoff` |
| Two repos "implementing" | evidence/complete calls fail with "activate repo first" | switch active repo back, finish serially |
| MCP upgraded but behaviour unchanged | old process still runs old code | restart the session / reconnect MCP |
