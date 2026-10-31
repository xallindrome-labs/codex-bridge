# codex-jobs

A Claude Code add-on (a "mod") that opens a pane beside the chat listing your [codex-bridge](https://github.com/xallindrome-labs/codex-bridge) jobs, live. It is read-only: it looks at the job files codex-bridge keeps on disk, so it shows jobs started by any Claude session, including ones that kept running after you closed Claude.

For each job it shows the tool (`plan`, `code` or `image`), the status (running, done, failed, interrupted, cancelled, timed out), how long it has run or took, the request, and `images k/n` for image batches. Above the list it shows your **Codex usage**: the 5-hour and weekly windows with percent used, a bar, when each resets, and how many images the bridge generated in each window. Codex has one shared meter, so images use the same limits as text; there is no separate image meter. A status-line entry shows `codex: N running`, and a short toast appears when a job you watched start finishes.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install codex-jobs --marketplace xallindrome-labs/codex-bridge
```

From a shell: `claude plugin install codex-jobs --marketplace xallindrome-labs/codex-bridge`.

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `xallindrome-labs/codex-bridge`, then **Add plugin**.

Or, without a marketplace, from the npm package (this session only):

```
claude --plugin-dir "$(npx -y @xallindrome-labs/codex-bridge --pane-path)"
```

## Use

- Type `/codex-jobs` to open the pane. It also opens by itself the first time a job is running in a session.
- The list refreshes every 3 seconds and shows the 12 newest jobs.
- If a job shows **interrupted**, its Codex process is gone (reboot, crash or kill). Ask Claude to run `codex_resume` with that job id.

It finds the jobs in `$CODEX_BRIDGE_HOME/jobs`, or `~/.codex-bridge/jobs` if that is not set. Usage comes from the newest Codex session logs in `$CODEX_HOME/sessions` (default `~/.codex/sessions`), where Codex records its usage windows; it is re-read every 30 seconds and shows when it was last written, so it can lag until Codex runs again. A window whose reset time has passed shows as reset.

## What it needs

- codex-bridge, which creates the jobs. This add-on only reads local files (codex-bridge job files and Codex session logs); it does not call Codex or the network.
- A Claude Code build that supports mods (hooks modules and `Pane`). Whether a pane is drawn depends on the surface; the add-on is tested against the terminal, desktop, VS Code and mobile element tables, not every paint.

## Develop

```
claude plugin validate plugins/codex-jobs
claude plugin test plugins/codex-jobs
```

MIT licensed, like codex-bridge. Built by [Xallindrome](https://xallindrome.co).
