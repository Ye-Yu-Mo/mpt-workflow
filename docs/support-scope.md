# Language and client support

Decided for the 0.x line (2026-11-25) and kept for 1.x. This is a scope
decision, not a bug.

## Language: Chinese-first

The product is **Chinese-first**:

- CLI output, errors, status text and the dashboard are Chinese.
- MCP tool descriptions, tool results and the server `instructions` are Chinese.
- `README.zh-CN.md` is Chinese. Most documents under `docs/` are English; the
  historical design notes are Chinese.
- `README.md` is English for discovery.

We deliberately do **not** half-translate. A mixed UI is worse than a consistent
one, and the model-facing tool descriptions are part of the runtime contract.

A full locale layer (`WF_LANG` / `LANG`, English tool descriptions and CLI
messages) is a post-1.0 option, driven by demand. Until then:

- English readers can follow the README and use the commands; runtime output is
  Chinese.
- Contributions that translate only part of the UI will be asked to either
  finish the locale layer or keep the Chinese wording.

Why: the primary users work in Chinese, the workflow vocabulary (PLAN/TODO/验收)
is already Chinese, and maintaining two complete translations is a real cost.

## Clients: Claude Code

**Claude Code is the supported client.** It provides both halves of the design:

1. MCP over stdio (`mpt-workflow mcp`).
2. `PreToolUse` / `SessionStart` hooks, which are the actual enforcement
   boundary for file writes, `git push` and commits.

`mpt-workflow init --install-hooks` writes `.claude/settings.json`. Declare the
role per session with `WF_ROLE` / `WF_REPO` or the `bootstrap` tool.

### Other MCP clients

The MCP server itself is standard stdio, so another client may connect to it.
That is **not a supported configuration yet**:

- Without Claude Code hooks, `Edit` / `Write` / `Bash` are not checked at
  tool-call time. Only the MCP tools and the git pre-commit hook enforce
  anything.
- `git push` is not blocked by a hook; agents must be trusted not to push.
- `init` still writes Claude Code hook files, which the other client ignores.

Cursor, Codex CLI, VS Code, Zed and others are **not documented**. If you need
one, open an issue with the client and version. We will add documentation and a
tested path when there is real demand; we will not claim support without a way
to enforce and test it.

Why: documenting a client without its hook story would sell a weaker guarantee
than the README promises.

## Platform

macOS, Linux and WSL2 are supported; native Windows is deferred. See
[platform-support.md](platform-support.md).

## What would change these decisions

- Repeated requests or issues from non-Chinese users, or a maintainer willing to
  own a complete locale layer.
- A client with a hook API equivalent to Claude Code's, plus CI coverage for it.
- A funded/sustained translation effort; then tool descriptions and CLI strings
  can move to English by default while keeping Chinese docs.
