# Minimal example

One repo, two milestones, an answered question and a small Rust crate.

```bash
cd examples/minimal/demo-service
git init -q
git add -A
git commit -qm init
cd ..
mpt-workflow init --root . --repo demo-service
mpt-workflow status
mpt-workflow web --root . --port 7788
```

What to try:

1. `mpt-workflow next` → it should say the todo agent should claim M1.
2. In an agent session: `WF_ROLE=todo WF_REPO=demo-service claude`, then
   `milestone_claim(M1)`, `evidence_run("cargo test")`, `milestone_complete(M1)`.
3. As the human, approve the commit in the dashboard; M1 moves to `committed`.
4. Add a question with `ask` and answer it in the dashboard's question inbox.

The pre-written `.workflow/program.yaml` is optional: `init` creates one when
missing. It is checked in here so the example is copy-paste runnable.
