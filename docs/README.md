# Documentation

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | Layers, state machines, ACL, enforcement, evidence, messaging, storage, rejected alternatives |
| [design-1.0-contract.md](design-1.0-contract.md) | What 1.0 freezes: MCP tools, `program.yaml`, Markdown contracts, CLI, hooks; change policy and migration |
| [upgrade-1.0.md](upgrade-1.0.md) | Upgrading a 0.x workspace: `migrate`, `schema_version`, verification and rollback |
| [requirements-messaging.md](requirements-messaging.md) | Requirement-to-implementation mapping for the messaging layer (v0.1) |
| [design-notes-v0.1.md](design-notes-v0.1.md) | Original design draft (Chinese). Some paths refer to the source project's umbrella repo. |
| [requirements-agent-messaging-v0.1.md](requirements-agent-messaging-v0.1.md) | Original messaging requirements (Chinese), as received |
| [platform-support.md](platform-support.md) | Supported platforms and the native-Windows gap |
| [support-scope.md](support-scope.md) | Chinese-first language policy; Claude Code as the only supported client |
| [releasing.md](releasing.md) | Version bump, tag, npm publish and release workflow |
| [troubleshooting.md](troubleshooting.md) | Role/ACL, hooks, blocking messages, commits, evidence, dashboard and `gc` |
| [../examples/README.md](../examples/README.md) | Runnable minimal, multi-repo and Rust workspaces |

The user-facing documentation lives in the repository root:
[README.md](../README.md), [CONTRIBUTING.md](../CONTRIBUTING.md),
[SECURITY.md](../SECURITY.md), [CHANGELOG.md](../CHANGELOG.md),
[ROADMAP.md](../ROADMAP.md).

Historical drafts (`design-notes-v0.1.md`, `requirements-agent-messaging-v0.1.md`)
predate the rename and still use the original package name `workflow-mcp`.
The current package and command are `mpt-workflow`.
