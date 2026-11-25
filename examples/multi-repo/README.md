# Multi-repo example

Two repos in one program, with a serial `active_repo` lock and an umbrella
contract document.

```bash
cd examples/multi-repo/api
git init -q && git add -A && git commit -qm init
cd ../worker
git init -q && git add -A && git commit -qm init
cd ..
mpt-workflow init --root . --repo api --repo worker
mpt-workflow status
mpt-workflow activate api
```

What to try:

1. `mpt-workflow next` with `api` active → plan should write `api/TODO-M1.md`
   (it already exists) or todo should claim it.
2. `mpt-workflow activate worker` → the serial lock moves; `api` implementations
   pause.
3. `WF_ROLE=plan WF_REPO=api claude` and `WF_ROLE=todo WF_REPO=worker claude`
   are two separate sessions with different ACLs.
4. Cross-repo questions go through `main`; the contract lives in
   `docs/contracts/health.md`.

Only one repo is active at a time by design. The inactive repo's milestone track
stays visible but its implementation work should wait.
