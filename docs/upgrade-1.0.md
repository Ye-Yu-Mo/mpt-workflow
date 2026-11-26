# Upgrading to 1.0

This guide covers a workspace created by 0.x. The 1.0 line keeps the existing
Markdown contracts and tool names; see
[design-1.0-contract.md](design-1.0-contract.md) for the full promise.

## 1. Install

```bash
npm install -g mpt-workflow@latest
mpt-workflow doctor
```

`doctor` warns if `program.yaml` was written by a **newer** schema
(`schema-version`). Upgrade the CLI first; never hand-downgrade the file.

## 2. Preview the configuration migration

```bash
mpt-workflow migrate
```

It reports what would change and prints the resulting YAML:

- add `schema_version: 1`;
- remove the machine-specific `root:` field (the runtime path is derived from
  where the workspace is opened);
- keep comments and unknown keys.

It is idempotent: a current file reports `配置已是最新`.

## 3. Apply and commit

```bash
mpt-workflow migrate --apply
git diff .workflow/program.yaml
git add .workflow/program.yaml
git commit -m "chore(workflow): migrate program.yaml to schema 1"
```

No `PLAN.md`, `TODO-Mn.md` or `docs/agent-questions.md` rewrite is required.
Running 1.0 on an unmigrated (0.x) workspace is supported too; the file gains
`schema_version` on its next write.

## 4. Verify

```bash
mpt-workflow status
mpt-workflow next
mpt-workflow doctor
```

The milestone states, questions and pending approvals should be unchanged.

## Rollback

Revert the `program.yaml` commit and reinstall the previous 0.x version if
needed. 0.x ignores `schema_version`, so a file migrated by 1.0 remains readable
by 0.x in practice; the removed `root:` field is runtime state.

## If something looks wrong

- `program.yaml 不是合法 YAML`: fix the YAML first; `migrate` refuses to guess.
- `schema_version=2 高于当前支持（1）`: the file is from a newer release;
  upgrade `mpt-workflow`.
- A document no longer parses: keep the file and open an issue with the
  smallest reproducing snippet; the parser is meant to stay forgiving.
