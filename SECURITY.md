# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.6.x | ✅ |
| < 0.6 | ❌ |

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub's
[private vulnerability reporting](https://github.com/Ye-Yu-Mo/mpt-workflow/security/advisories/new)
or by contacting the maintainer ([@Ye-Yu-Mo](https://github.com/Ye-Yu-Mo)).

Include the version, a minimal reproduction, and the impact you believe it has.
You can expect an acknowledgement within a few days. There is no bounty.

## Threat model — read this before deploying

This tool is designed for **a single user on a single machine**. It is not a
sandbox and it is not multi-tenant.

### What the tool can do

- **Execute arbitrary shell commands.** `evidence_run` runs a command in a repo
  through `bash -lc` and records the output. This is the point of the tool:
  evidence has to be produced by the server, not typed in. It runs with **your**
  OS user privileges and has the same trust level as your terminal.
- **Write files.** The MCP tools and hooks write Markdown, JSON and git state.
- **Read files.** The parser reads Markdown anywhere under the configured root.
- **Run git commands.** It can stage and commit in configured repos. It never
  pushes.

### What it does not do

- It does not authenticate callers. Anyone who can start an MCP client can
  declare any role; the role is self-declared, not proven.
- The dashboard has no authentication and binds `127.0.0.1` only. Do not expose
  it through a proxy or tunnel.
- The commit approval is a **workflow guardrail**, not an authorization
  boundary. The server runs as the same user as the agent, so a determined agent
  with shell access could bypass it. It exists to make a human look at the diff.
- It does not protect against a malicious repository: a crafted `agent-questions.md`
  or `TODO` file is data to the parser, but `evidence_run` commands come from the
  agent, not the repository.

### Hardening checklist

- Run the MCP server and dashboard as your own user on your own machine.
- Do not run it as root or on a shared host with untrusted users.
- Keep `.workflow/runtime/` out of version control (it is gitignored) — it holds
  message bodies, evidence output and approvals.
- Review the diff before approving a commit; the approval is bound to the exact
  working-tree hash, so approve only what you have seen.
- Treat `--install-hooks` as a convenience, not a security control: hooks can be
  bypassed with `--no-verify` or by editing `.git/hooks`.
- Agent roles are denied `.claude/**`, `.mcp.json`, `.workflow/runtime/**`,
  `.git/**` and the question board, so the enforcement plane is not editable by
  the sessions it guards. Agent Bash `git commit` / `git push` and
  `mpt-workflow approve|commit` are refused; use the MCP commit tool.
- Git aliases are not resolved by the Bash guard. A shell-capable agent can
  still do arbitrary things; the hooks are guardrails, not a sandbox.
