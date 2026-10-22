# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub:
**Security → Report a vulnerability** on https://github.com/xallindrome-labs/codex-bridge/security/advisories/new

Please don't open a public issue for a vulnerability. This is a one-person project, so expect an acknowledgement within a week, not hours.

## What codex-bridge does that matters for security

- It runs the Codex CLI on your machine, always with a **read-only sandbox** (`-s read-only` plus `-c sandbox_mode="read-only"`). Your Codex config's default sandbox mode never applies to bridge calls.
- It starts Codex without a shell: arguments are passed as an array and the prompt goes in over stdin.
- Prompts and any `context` you pass are sent to OpenAI through the Codex CLI, under your own Codex login. **Don't put secrets in prompts.**
- Job files (prompts, Codex event streams, results) are stored unencrypted under `~/.codex-bridge/jobs/` (override with `CODEX_BRIDGE_HOME`) and deleted after 14 days.
- It has no network listener and no dependencies. It talks to its MCP client over stdio only.

Reports about any of the above not holding true are in scope.

## Supported versions

Only the latest release.
