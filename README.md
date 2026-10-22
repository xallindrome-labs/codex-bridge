# codex-bridge

**Let Claude Code ask Codex for a plan, a second opinion or an image, and keep working while it thinks.** A dependency-free MCP server; every call is a durable background job that survives Claude closing or crashing.

Roles: **Claude Code implements. Codex plans and builds images.**

![Recorded session: Claude Code starts codex-bridge and asks Codex for a plan](docs/demo.svg)

<sub>The server calls in this recording are real (Codex at `effort: low`, idle time trimmed); the `claude mcp add` line is scripted. The raw recording is [docs/demo.cast](docs/demo.cast); play it with `asciinema play docs/demo.cast`.</sub>

## Quickstart

You need [Node.js](https://nodejs.org) 20 or newer and the [Codex CLI](https://github.com/openai/codex) installed and logged in.

```bash
claude mcp add codex-bridge -- npx -y codex-bridge
```

Restart Claude Code, then ask it something like *"Get a plan from Codex for adding rate limiting, in the background, and keep going"*. Claude will call `codex_plan` with `background: true` and collect the answer later.

Other MCP clients: run `npx -y codex-bridge` as a stdio server.

> **Platform note:** developed and tested on Windows 11. The macOS and Linux code paths exist but are untested. Reports and fixes are welcome.

| Tool | What it does | Sandbox | Default model / effort |
|---|---|---|---|
| `codex_plan` | Codex writes implementation plans, design reviews and second opinions. It inspects the project in `cwd`. | `read-only` (always) | Your Codex config defaults |
| `codex_image` | Codex generates or edits images. The bridge copies each one into `output_dir` as soon as it's made. | `read-only` (always) | **gpt-6-luna / high** |
| `codex_result` | Gets a job's result or progress (`wait_seconds` up to 240), or lists recent jobs. | | |
| `codex_resume` | Continues an interrupted, timed-out or failed job from where it stopped. | | |
| `codex_cancel` | Stops a running job. | | |

`codex_plan` and `codex_image` accept:
- `effort`: `low`, `medium`, `high`, `xhigh`, `max` or `ultra` (Luna supports up to `max`).
- `model`: overrides the default model for that call.
- `background: true`: returns a `job_id` immediately so Claude can keep working.
- `session_id`: continues an earlier Codex thread, for example "make the icon darker".

`codex_image` also takes `count`, the number of images wanted. Set it for batches: it enables `k/count` progress and resumes that ask for exactly the missing images.

## Jobs survive restarts

Every call is a job saved under `~/.codex-bridge/jobs/<job_id>/`, including calls that aren't run in the background.

- **Claude closes or crashes:** the job keeps running. `server.mjs` starts `runner.mjs` through WMI (`Win32_Process.Create`), so the job isn't part of Claude Code's process tree. Closing Claude can't kill it, and any later Claude session can collect it with `codex_result`.
- **The job itself dies** (reboot, power loss, Codex crash, or killed process): the job is marked `interrupted`. The next Claude session is told about it when it starts. `codex_resume` continues it:
  1. It copies out any images generated just before the interruption.
  2. It resumes the same Codex thread: "N are already done, generate only the remaining ones."
  3. If no Codex thread had started yet, it reruns the original request.

## How images are collected

Codex never writes image files. Its image tool stores every generated image in `~/.codex/generated_images/<thread>/`. The runner checks that folder every 2 seconds and copies new images into `output_dir` as `<filename>.png`, `<filename>-2.png`, and so on, in the order they were made. `copied.json` in the job folder records what has been copied, so an image is never copied twice across attempts.

This gives three benefits:
- Image jobs run in a read-only sandbox.
- A crash loses at most the one image being generated.
- Resume counts exactly what's done.

It also avoids a real problem: when Luna was allowed to save files itself, it re-typed each image as base64 through dozens of shell commands. That was slow, and the saved file no longer matched the original.
- **Codex stalls:** the runner stops a run after 10 minutes with no output. The job is marked `timed_out`, and it can be resumed.

Each attempt keeps its own `prompt.txt`, `events.jsonl` (the Codex event stream), `stderr.txt`, heartbeat and `result.json`. Finished jobs are deleted after 14 days.

## How it works

Each attempt runs `codex exec --json` (or `codex exec resume <thread>`) with the prompt on stdin. No shell is involved.

Every call runs read-only, set explicitly with `-s` plus `-c sandbox_mode=...`. Your Codex config defaults to `danger-full-access`, but that default never applies to bridge calls.

| File | Role |
|---|---|
| `server.mjs` | The MCP server. It creates jobs, launches runners, works out job status from the files on disk, and handles resume and cancel. |
| `runner.mjs` | Runs one attempt: starts Codex, records the heartbeat, watches for a stall or cancellation, collects images and writes `result.json`. |
| `lib.mjs` | Shared helpers: finding the Codex binary, building arguments, parsing events, handling images. |

## Install options

```bash
# for all your projects
claude mcp add -s user codex-bridge -- npx -y codex-bridge

# or from a local checkout
claude mcp add codex-bridge -- node /path/to/codex-bridge/server.mjs
```

Remove it with `claude mcp remove codex-bridge` (add `-s user` if you installed it that way).

## Configuration (env vars)

| Var | Default |
|---|---|
| `CODEX_BIN` | Auto-detected. It prefers a `codex.exe` next to `codex-code-mode-host.exe`, which is currently `~/.codex/plugins/.plugin-appserver/codex.exe`. |
| `CODEX_BRIDGE_HOME` | `~/.codex-bridge` |
| `CODEX_BRIDGE_IDLE_TIMEOUT_MS` | `600000` (stops a run after 10 minutes with no Codex output) |
| `CODEX_BRIDGE_PLAN_MODEL` / `CODEX_BRIDGE_PLAN_EFFORT` | Your Codex config defaults |
| `CODEX_BRIDGE_IMAGE_MODEL` / `CODEX_BRIDGE_IMAGE_EFFORT` | `gpt-6-luna` / `high` |

## Test

```bash
node smoke-test.mjs <scratch-dir> [plan|image|jobs|durable|all]
```

The smoke test drives the server over stdio like an MCP client and needs a logged-in Codex CLI; it uses a little of your Codex quota. The `durable` part uses `taskkill`, so it is Windows-only for now.

- `plan`: runs a plan, then tries a write from a resumed session, which must fail.
- `image`: generates one image.
- `jobs`: tests background jobs, cancellation and the `effort` check.
- `durable`:
  1. Kills the server while a job is running, then checks that a new server collects the result.
  2. Hard-kills an image batch partway through, then checks that a new server reports it as interrupted and that `codex_resume` finishes it.

## Speed

Each call has a fixed cost of about 4–5 seconds, and changing settings barely moves it. The rest of the time is Codex thinking and generating, which takes seconds to minutes. To spend less time waiting, use `background: true`, a lower `effort` for quick questions, and include relevant code in `context` so Codex reads less of the project.

## Notes

- This uses Codex's own login and quota, with no separate API key. A job left running after Claude closes keeps using that quota until it finishes.
- Bridge calls run headlessly, so they don't show up as conversations in the Codex Desktop sidebar.
- Don't send secrets in prompts. Prompts go to OpenAI.

## License

[MIT](LICENSE)

---

**Built by [Xallindrome](https://xallindrome.co)**: we build automation and AI workflows for small businesses. If you'd like something like this for your business, [book a diagnostic](https://xallindrome.co).
