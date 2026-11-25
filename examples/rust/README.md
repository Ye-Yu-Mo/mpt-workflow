# Rust example

A real `cargo test` crate with a checked-in `Cargo.lock`.

```bash
cd examples/rust/rust-service
cargo test --locked
git init -q && git add -A && git commit -qm init
cd ..
mpt-workflow init --root . --repo rust-service
mpt-workflow status
```

What to try:

1. As todo: `WF_ROLE=todo WF_REPO=rust-service claude`, then
   `milestone_claim(M1)` and `evidence_run("cargo test --locked")`.
2. As plan: `milestone_accept(M1)`, then the human approves the commit in the
   dashboard.
3. The ACL hard-codes `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml` and
   `.cargo/**` as plan/main-denied. A todo agent may change them, but should
   declare them in the TODO's **影响文件** list so the scope check and pre-commit
   hook agree.
4. `doctor` warns if `Cargo.lock` is dirty; dependency drift is treated as a
   contract risk.
