# Examples

Each directory is a self-contained workspace you can copy or run in place.
They are kept honest by `tests/examples.test.ts`, which parses every checked-in
`PLAN.md` / `TODO-*.md` / `agent-questions.md`.

| Example | Shows |
|---|---|
| [minimal](minimal/) | One repo, two milestones, a question board and evidence shape |
| [multi-repo](multi-repo/) | Two repos, the serial `active_repo` lock, umbrella contract docs |
| [rust](rust/) | A Rust crate with `cargo test`, Cargo ACL entries and acceptance |

Start with `minimal`:

```bash
cd examples/minimal/demo-service
git init -q && git add -A && git commit -qm init
cd ..
mpt-workflow init --root . --repo demo-service
mpt-workflow status
mpt-workflow web --root . --port 7788
```

Nothing here is required for normal use; `mpt-workflow demo` creates the same
kind of workspace in `$TMPDIR` without touching the repo.
