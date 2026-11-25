# Platform support

## Supported

| Platform | Status | Verified by |
|---|---|---|
| macOS (arm64) | Supported | CI `macos-latest` |
| macOS (x64) | Expected to work | Not CI-tested |
| Linux (x64) | Supported | CI `ubuntu-latest` |
| WSL2 | Supported (same requirements as Linux) | Not CI-tested |

Requirements: Node.js 22+, git, and `bash`. Development (tests) needs Node
22.13+ because jsdom 29 requires it. The tool runs as your own user, on your own
machine.

## Not supported yet: native Windows

`evidence_run` spawns `/bin/bash -lc`, and the Claude Code / git hooks written
by `init` are bash scripts. Path handling also assumes POSIX separators in a
few places. Windows users should run the tool inside WSL2.

Native Windows support requires, at minimum:

- a shell abstraction for `evidence_run` (cmd/PowerShell),
- Node-based or PowerShell hook scripts,
- an audit of path/executable resolution,
- Windows CI covering typecheck, tests and the hook integration tests.

This is a 1.1 goal. Do not claim Windows support before CI proves it.
