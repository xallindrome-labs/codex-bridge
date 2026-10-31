# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub:
**Security → Report a vulnerability** on https://github.com/xallindrome-labs/codex-bridge/security/advisories/new

Please don't open a public issue for a vulnerability. This is a one-person project, so expect an acknowledgement within a week, not hours.

## What codex-bridge does that matters for security

- It runs the Codex CLI on your machine, by default always with a **read-only sandbox**: `-c sandbox_mode="read-only"` on every call, plus `-s read-only` when starting a new session. Your Codex config's default sandbox mode never applies to bridge calls.
- **Opt-in exception: `codex_code`.** Only if you set `CODEX_BRIDGE_WRITE_ROOT` to one folder, an extra tool `codex_code` appears. It runs Codex in the `workspace-write` sandbox with network access off, and refuses any `cwd` that is not that folder or inside it (checked on the real path, so `..` and symlinks don't escape; a drive root or your home folder is refused as too broad). The check repeats on every resume. Everything else stays read-only. In our test on Windows 11, writes outside the folder and network access were blocked, but the system temp folder stayed writable even with the flags that ask Codex to block it (`CODEX_BRIDGE_WRITE_ALLOW_TMP` unset); treat temp as writable. Codex is told not to commit or push, but that is a prompt, not a sandbox rule: review the diff.
- It starts Codex without a shell: arguments are passed as an array and the prompt goes in over stdin.
- Prompts and any `context` you pass are sent to OpenAI through the Codex CLI, under your own Codex login. **Don't put secrets in prompts.**
- Job files (prompts, Codex event streams, results) are stored unencrypted under `~/.codex-bridge/jobs/` (override with `CODEX_BRIDGE_HOME`) and deleted after 14 days.
- It has no network listener and no dependencies. It talks to its MCP client over stdio only.

Reports about any of the above not holding true are in scope.

## Supported versions

Only the latest release.
