# Deprecation ledger

Policy: a deprecated behavior keeps working for at least one minor release (and
at least one calendar month), is announced in `CHANGELOG.md` and `doctor` where
possible, and is removed only at the next major version. Old spellings are kept
as aliases for the whole 1.x line when feasible. See
[design-1.0-contract.md](design-1.0-contract.md) §3.

## Entries

| Behavior | Deprecated in | Replacement | Remove no earlier than | Status |
|---|---|---|---|---|
| — | — | — | — | none |

## Adding an entry

1. Add a row here and a `CHANGELOG` `Deprecated` bullet in the same release.
2. Keep the old path working; add a `doctor` warning when it is easy to detect.
3. Do not remove the behavior before the stated major version.
