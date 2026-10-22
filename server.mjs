#!/usr/bin/env node
// codex-bridge: a dependency-free MCP stdio server that lets Claude Code
// consult the Codex CLI as a planner (read-only) or an image generator.
//
// Every call is a durable job: Codex runs under runner.mjs, launched outside
// Claude Code's process tree, and all state lives in ~/.codex-bridge/jobs.
// Jobs keep running if Claude closes, any session can collect their results,
// and jobs killed by a reboot/crash can be resumed where they stopped.
//
// Tools:
//   codex_plan   - read-only planning / design review / second opinion
//   codex_image  - image generation; images are saved into output_dir
//   codex_result - status/result of jobs (optionally waits); lists jobs
//   codex_resume - continue an interrupted/failed job where it left off
//   codex_cancel - stop a running job
//
// Env:
//   CODEX_BIN                      path to codex.exe (auto-detected otherwise)
//   CODEX_BRIDGE_HOME              job storage (default ~/.codex-bridge)
//   CODEX_BRIDGE_IDLE_TIMEOUT_MS   kill a run after this long with no Codex output (default 600000)
//   CODEX_BRIDGE_PLAN_MODEL        plan model (default: Codex config default)
//   CODEX_BRIDGE_PLAN_EFFORT       plan reasoning effort (default: Codex config default)
//   CODEX_BRIDGE_IMAGE_MODEL       image model (default gpt-6-luna)
//   CODEX_BRIDGE_IMAGE_EFFORT      image reasoning effort (default high)

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  EventTail, JOBS_DIR, attemptDir, buildCodexArgs, collectImages, isWin, jobDir, jobImages,
  pidAlive, readJson, resolveCodexBin, writeJson,
} from './lib.mjs';

const PKG = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const SERVER_INFO = { name: 'codex-bridge', version: PKG.version };
const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runner.mjs');
const IDLE_TIMEOUT_MS = Number(process.env.CODEX_BRIDGE_IDLE_TIMEOUT_MS) || 10 * 60 * 1000;
const DEFAULTS = {
  codex_plan: { model: process.env.CODEX_BRIDGE_PLAN_MODEL || '', effort: process.env.CODEX_BRIDGE_PLAN_EFFORT || '' },
  codex_image: { model: process.env.CODEX_BRIDGE_IMAGE_MODEL || 'gpt-6-luna', effort: process.env.CODEX_BRIDGE_IMAGE_EFFORT || 'high' },
};
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const MAX_WAIT_S = 240;
const STALE_HEARTBEAT_MS = 10 * 60 * 1000;
const PRUNE_AFTER_MS = 14 * 24 * 3600 * 1000;
const CODEX_BIN = resolveCodexBin();

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(PKG.version);
  process.exit(0);
}
if (process.argv.includes('--help') || process.argv.includes('-h') || process.stdin.isTTY) {
  console.log(`codex-bridge ${PKG.version}: an MCP server (stdio) that lets Claude Code consult the Codex CLI.
It is started by an MCP client, not run by hand. Register it with Claude Code:
  claude mcp add codex-bridge -- npx -y @xallindrome-labs/codex-bridge
Docs: ${PKG.homepage}`);
  process.exit(0);
}

fs.mkdirSync(JOBS_DIR, { recursive: true });

// ---------------------------------------------------------------- prompts

const PLAN_PREAMBLE = `You are the PLANNER in a two-agent workflow. Claude Code is the implementer and will act on your output.
Rules:
- Do not modify, create or delete any files. You are in a read-only sandbox; read and inspect the project as much as you need.
- Ground every step in what is actually in the codebase (cite file paths, functions, existing patterns).
- Output a concrete, ordered plan: goal and acceptance criteria, numbered implementation steps with the files each touches, risks and open questions, and how to verify (tests/commands).
- Be concise; no preamble.

Request from Claude Code:
`;

// Codex only generates; the runner collects each image from Codex's image store
// the moment it appears. (Left to save files itself, Codex may re-type the image
// as base64 through shell commands: slow, and can corrupt the file.)
const IMAGE_RULES = `- Use your built-in image generation tool for every image (one tool call per image). Don't draw images with code.
- Do NOT save, copy, convert or write any files: every image you generate is collected automatically. You are in a read-only sandbox.
- In this headless mode the image tool may return without showing you the image. That is expected: the image was still generated and collected. Never retry because of a missing preview.
- Don't generate extra drafts (every generated image is kept).`;

const IMAGE_PREAMBLE = count => `You are the IMAGE BUILDER in a two-agent workflow. Claude Code requested the image(s) below.
Rules:
${IMAGE_RULES}${count ? `\n- Generate exactly ${count} images.` : ''}
- When finished, reply with a one-line description of each image, in generation order.

Request:
`;

function initialPrompt(tool, args) {
  if (tool === 'codex_plan') {
    return (args.session_id ? '' : PLAN_PREAMBLE) + args.request + (args.context ? `\n\nContext:\n${args.context}` : '');
  }
  return args.session_id ? `${args.prompt}\n\nRules:\n${IMAGE_RULES}` : IMAGE_PREAMBLE(args.count) + args.prompt;
}

function resumePrompt(job) {
  if (job.tool === 'codex_plan') {
    return 'Your previous run on this request was interrupted before you finished. Continue from where you stopped and give your complete final answer.';
  }
  const done = jobImages(job).length;
  const remaining = job.args.count ? Math.max(job.args.count - done, 0) : null;
  return `Your previous run on this request was interrupted before it finished. ${done} image(s) were already generated and collected; do NOT regenerate them.
${remaining !== null ? `Generate only the remaining ${remaining} of the ${job.args.count} requested images.` : 'Continue the original request and generate only the images that are still missing.'}
Rules:
${IMAGE_RULES}
- When finished, reply with a one-line description of each new image.`;
}

// ---------------------------------------------------------------- jobs

const newJobId = () => `job-${new Date().toISOString().replace(/[-:T]/g, '').slice(2, 14)}-${crypto.randomBytes(2).toString('hex')}`;
const loadJob = id => readJson(path.join(jobDir(id), 'job.json'));
const saveJob = job => writeJson(path.join(jobDir(job.id), 'job.json'), job);

// Launches runner.mjs outside Claude Code's process tree / job object, so
// closing Claude doesn't kill it. On Windows that means WMI Win32_Process.Create.
function launchRunner(jobId, n, cwd) {
  if (!isWin) {
    const c = spawn(process.execPath, [RUNNER, jobId, String(n)], { cwd, detached: true, stdio: 'ignore' });
    c.unref();
    return Promise.resolve(c.pid);
  }
  const q = s => `'${String(s).replace(/'/g, "''")}'`;
  const cmdLine = `"${process.execPath}" "${RUNNER}" ${jobId} ${n}`;
  const ps = `$ErrorActionPreference = 'Stop'
$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${q(cmdLine)}; CurrentDirectory = ${q(cwd)}; ProcessStartupInformation = $si }
"$($r.ReturnValue) $($r.ProcessId)"`;
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', () => {
      const [rv, pid] = out.trim().split(/\s+/).map(Number);
      if (rv === 0 && pid) resolve(pid);
      else reject(new Error(`Could not launch job runner (WMI ReturnValue ${rv}). ${err.trim()}`));
    });
  });
}

async function launchAttempt(job, prompt, sessionId) {
  const n = job.attempts + 1;
  const dir = attemptDir(job.id, n);
  fs.mkdirSync(dir); // throws EEXIST if another session launched this attempt first
  const cwd = job.tool === 'codex_plan' ? job.cwd : job.outDir;
  fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt);
  writeJson(path.join(dir, 'spec.json'), {
    bin: CODEX_BIN,
    cwd,
    args: buildCodexArgs({
      sandbox: 'read-only',
      cwd, sessionId, model: job.model, effort: job.effort,
      images: n === 1 ? job.refs : [],
    }),
    env: process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {},
    idleTimeoutMs: IDLE_TIMEOUT_MS,
  });
  job.attempts = n;
  job.attemptStarted = Date.now();
  saveJob(job);
  await launchRunner(job.id, n, cwd);
}

async function startJob(tool, args) {
  if (!CODEX_BIN) throw new Error('Codex CLI not found. Set CODEX_BIN to the path of codex.exe.');
  const d = DEFAULTS[tool];
  const job = {
    id: newJobId(),
    tool,
    args,
    model: args.model || d.model,
    effort: args.effort || d.effort,
    created: Date.now(),
    attempts: 0,
  };
  if (tool === 'codex_plan') {
    job.cwd = path.resolve(args.cwd);
    if (!fs.existsSync(job.cwd)) throw new Error(`cwd does not exist: ${job.cwd}`);
  } else {
    job.outDir = path.resolve(args.output_dir);
    fs.mkdirSync(job.outDir, { recursive: true });
    job.refs = (args.reference_images ?? []).map(p => path.resolve(p));
    const missing = job.refs.filter(p => !fs.existsSync(p));
    if (missing.length) throw new Error(`Reference image(s) not found: ${missing.join(', ')}`);
  }
  fs.mkdirSync(jobDir(job.id), { recursive: true });
  await launchAttempt(job, initialPrompt(tool, args), args.session_id);
  return job;
}

// Status of a job's latest attempt, derived only from files on disk.
function jobStatus(job) {
  const dir = attemptDir(job.id, job.attempts);
  const result = readJson(path.join(dir, 'result.json'));
  if (result) return { status: result.status, result };
  const state = readJson(path.join(dir, 'state.json'));
  let beatAge = Infinity;
  try { beatAge = Date.now() - fs.statSync(path.join(dir, 'heartbeat')).mtimeMs; } catch {}
  if (!state) return { status: Date.now() - job.attemptStarted < 60_000 ? 'running' : 'interrupted' };
  if (pidAlive(state.runnerPid) && beatAge < STALE_HEARTBEAT_MS) return { status: 'running' };
  return { status: 'interrupted' };
}

// Latest Codex thread id across attempts (resume keeps the same thread).
function jobThreadId(job) {
  for (let n = job.attempts; n >= 1; n--) {
    const t = new EventTail(path.join(attemptDir(job.id, n), 'events.jsonl')).poll().threadId;
    if (t) return t;
  }
  return job.args.session_id || null;
}

const secs = ms => (ms < 120_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);

function imageCount(job) {
  const k = jobImages(job).length;
  return `images ${k}${job.args.count ? `/${job.args.count}` : ''}`;
}

function jobLine(job) {
  const { status, result } = jobStatus(job);
  const age = secs((result?.finished ?? Date.now()) - job.created);
  const where = job.tool === 'codex_plan' ? job.cwd : job.outDir;
  const label = (job.args.request || job.args.prompt || '').replace(/\s+/g, ' ').slice(0, 70);
  const extra = [job.tool === 'codex_image' ? imageCount(job) : null, job.attempts > 1 ? `attempt ${job.attempts}` : null].filter(Boolean).join(', ');
  return `${job.id} [${job.tool}] ${status}, ${age}${extra ? `, ${extra}` : ''} - ${label} (${where})`;
}

function renderResult(job, result) {
  const lines = [];
  if (job.tool === 'codex_image') {
    const imgs = result.images ?? jobImages(job);
    lines.push(imgs.length ? `Saved image(s)${job.args.count ? ` (${imgs.length}/${job.args.count})` : ''}:\n${imgs.map(p => `- ${p}`).join('\n')}` : 'No image files were found in output_dir.');
    lines.push('', 'Codex said:');
  }
  if (result.status === 'cancelled') lines.push('Codex job was cancelled.');
  else if (result.status === 'timed_out') lines.push(`Codex produced no output for ${secs(result.idleTimeoutMs)} and was stopped. Use codex_resume to continue.`);
  else if (result.status === 'failed') {
    lines.push(`Codex failed${result.failed ? `: ${result.failed}` : result.spawnError ? `: ${result.spawnError}` : ` (exit code ${result.exitCode})`}. Use codex_resume to retry from where it stopped.`);
    if (result.stderrTail) lines.push(result.stderrTail);
  }
  if (result.message) lines.push(result.message);
  lines.push('', '---',
    `job_id: ${job.id}${job.attempts > 1 ? ` (attempt ${job.attempts})` : ''}`,
    `session_id: ${result.threadId ?? 'unknown'} (pass as session_id to continue this Codex thread)`,
    `model: ${job.model || 'codex default'}, effort: ${job.effort || 'codex default'}`);
  if (result.errors?.length) lines.push(`codex warnings: ${result.errors.join(' | ')}`);
  const isError = result.status !== 'done' || (job.tool === 'codex_image' && !(result.images ?? []).length);
  return { isError, text: lines.join('\n') };
}

function interruptedText(job) {
  const progress = job.tool === 'codex_image' ? ` (${imageCount(job)} saved so far)` : '';
  return `${job.id} was interrupted before finishing${progress}: its Codex process is gone (reboot, crash or kill). ` +
    'Call codex_resume to continue it from where it stopped.';
}

// Waits for a job to finish, relaying Codex activity as progress. Returns null on timeout.
async function waitForJob(job, waitMs, onActivity) {
  const deadline = Date.now() + waitMs;
  let tail = null;
  for (;;) {
    job = loadJob(job.id) ?? job; // another session may have resumed it
    const events = path.join(attemptDir(job.id, job.attempts), 'events.jsonl');
    if (tail?.file !== events) tail = new EventTail(events);
    tail.poll(ev => onActivity?.(tail.state.activity, ev));
    const s = jobStatus(job);
    if (s.status !== 'running') return { ...s, job };
    if (Date.now() >= deadline) return null;
    await new Promise(r => setTimeout(r, 1000));
  }
}

function describe(s) {
  if (s.status === 'interrupted') return { isError: true, text: interruptedText(s.job) };
  return renderResult(s.job, s.result);
}

function listJobs() {
  if (!fs.existsSync(JOBS_DIR)) return [];
  return fs.readdirSync(JOBS_DIR).map(loadJob).filter(Boolean).sort((a, b) => b.created - a.created);
}

function pruneOldJobs() {
  for (const job of listJobs()) {
    const { status, result } = jobStatus(job);
    if (status !== 'running' && Date.now() - (result?.finished ?? job.created) > PRUNE_AFTER_MS) {
      fs.rmSync(jobDir(job.id), { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------- tools

const BACKGROUND_PROP = {
  type: 'boolean',
  description: 'Optional. true = return a job_id immediately and keep working; collect the result later with codex_result. Default false (wait for the answer).',
};

const TOOLS = [
  {
    name: 'codex_plan',
    description:
      'Ask Codex (OpenAI) to act as the planner: produce an implementation plan, review a design, or give a second opinion. ' +
      'Codex runs in a READ-ONLY sandbox in `cwd` and can inspect the project but not change it. Claude remains the implementer. ' +
      'Calls can take several minutes; use background=true to keep working meanwhile. Including relevant code/diffs in `context` makes it faster. ' +
      'Returns Codex\'s answer, a job_id and a session_id; pass session_id back to ask follow-ups in the same Codex thread.',
    inputSchema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'What to plan or review. Include goals, constraints and acceptance criteria.' },
        cwd: { type: 'string', description: 'Absolute path of the project directory Codex should inspect.' },
        context: { type: 'string', description: 'Optional extra context: relevant diffs, error output, decisions already made.' },
        session_id: { type: 'string', description: 'Optional. Continue an earlier Codex thread instead of starting fresh.' },
        effort: { type: 'string', enum: EFFORTS, description: 'Optional reasoning effort. Default: the user\'s Codex config (high). Use medium/low for quick questions; xhigh/max for hard architecture problems.' },
        model: { type: 'string', description: 'Optional Codex model override. Default: the user\'s Codex config.' },
        background: BACKGROUND_PROP,
      },
      required: ['request', 'cwd'],
    },
  },
  {
    name: 'codex_image',
    description:
      'Ask Codex to generate (or edit) raster images with its image generation tool. Images are saved into `output_dir` as they are made, and their paths returned. ' +
      'Pass reference_images to edit or riff on existing images, and session_id to iterate on a previous result. Set `count` for batches so progress and resumes are tracked. ' +
      'Runs on gpt-6-luna at high effort by default; leave model/effort unset unless the user asks. Calls take ~1 min per image; use background=true for batches.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Description of the image(s): subject, style, size/aspect ratio, background (e.g. transparent), variations.' },
        output_dir: { type: 'string', description: 'Absolute directory where the images should be saved (created if missing).' },
        count: { type: 'integer', minimum: 1, description: 'Optional number of images wanted. Enables progress (k/count) and precise resumes.' },
        filename: { type: 'string', description: 'Optional base filename, e.g. "hero-banner.png".' },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'Optional absolute paths of images to attach as references or to edit.' },
        session_id: { type: 'string', description: 'Optional. Continue an earlier Codex thread (e.g. "make it darker").' },
        effort: { type: 'string', enum: EFFORTS, description: 'Optional. Default high; rarely needs changing.' },
        model: { type: 'string', description: 'Optional. Default gpt-6-luna; rarely needs changing.' },
        background: BACKGROUND_PROP,
      },
      required: ['prompt', 'output_dir'],
    },
  },
  {
    name: 'codex_result',
    description:
      'Get the status or result of a Codex job (jobs persist across Claude sessions and restarts). With job_id: the result if finished, otherwise progress. ' +
      `wait_seconds (max ${MAX_WAIT_S}) blocks until the job finishes or the wait expires. Without job_id: lists recent jobs.`,
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job id returned by codex_plan/codex_image.' },
        wait_seconds: { type: 'number', description: `Optional. Seconds to wait for completion (0-${MAX_WAIT_S}). Default 0.` },
      },
    },
  },
  {
    name: 'codex_resume',
    description:
      'Continue a job that was interrupted (reboot/crash), timed out or failed, from where it stopped: it continues the same Codex thread, ' +
      'and for image jobs first rescues images Codex already generated, then asks only for the missing ones. Returns immediately; collect with codex_result.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'Job id to resume.' } },
      required: ['job_id'],
    },
  },
  {
    name: 'codex_cancel',
    description: 'Stop a running Codex job.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'Job id to cancel.' } },
      required: ['job_id'],
    },
  },
];

async function callJobTool(name, args, onActivity) {
  if (name === 'codex_plan' && (!args.request || !args.cwd)) throw new Error('request and cwd are required');
  if (name === 'codex_image' && (!args.prompt || !args.output_dir)) throw new Error('prompt and output_dir are required');
  if (args.effort && !EFFORTS.includes(args.effort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`);
  const job = await startJob(name, args);
  if (args.background) {
    return { text: `Started ${job.id}. It keeps running even if Claude closes. Collect it with codex_result (job_id "${job.id}", optionally wait_seconds).` };
  }
  const s = await waitForJob(job, Infinity, onActivity);
  return describe(s);
}

async function jobResult(args) {
  if (!args.job_id) {
    const jobs = listJobs().slice(0, 25);
    return { text: jobs.length ? jobs.map(jobLine).join('\n') : 'No Codex jobs yet.' };
  }
  const job = loadJob(args.job_id);
  if (!job) return { isError: true, text: `Unknown job_id: ${args.job_id}` };
  const wait = Math.min(Math.max(Number(args.wait_seconds) || 0, 0), MAX_WAIT_S);
  const s = await waitForJob(job, wait * 1000);
  if (!s) {
    const activity = new EventTail(path.join(attemptDir(job.id, job.attempts), 'events.jsonl')).poll().activity;
    return { text: `${jobLine(job)}\nlast activity: ${activity}\nStill running. Call codex_result again later (optionally with wait_seconds).` };
  }
  return describe(s);
}

async function resumeJob(args) {
  const job = loadJob(args.job_id);
  if (!job) return { isError: true, text: `Unknown job_id: ${args.job_id}` };
  const { status } = jobStatus(job);
  if (status === 'running') return { isError: true, text: `${job.id} is still running; nothing to resume.` };
  if (status === 'done') return { isError: true, text: `${job.id} already finished. Use codex_result to read it, or session_id for a follow-up.` };
  fs.rmSync(path.join(jobDir(job.id), 'cancel'), { force: true });

  const threadId = jobThreadId(job);
  let rescued = [];
  if (job.tool === 'codex_image') rescued = collectImages(job, threadId, { settled: false });
  const prompt = threadId ? resumePrompt(job) : `${initialPrompt(job.tool, job.args)}\n\n${resumePrompt(job)}`;
  await launchAttempt(job, prompt, threadId);
  return {
    text: `Resumed ${job.id} as attempt ${job.attempts}${threadId ? ` in Codex thread ${threadId}` : ' (no Codex thread had started, so it starts fresh)'}.` +
      (rescued.length ? `\nCollected ${rescued.length} image(s) Codex had generated just before the interruption.` : '') +
      (job.tool === 'codex_image' ? `\nProgress: ${imageCount(job)}.` : '') +
      `\nCollect it with codex_result (job_id "${job.id}").`,
  };
}

function cancelJob(args) {
  const job = loadJob(args.job_id);
  if (!job) return { isError: true, text: `Unknown job_id: ${args.job_id}` };
  const { status } = jobStatus(job);
  if (status !== 'running') return { text: `${job.id} is not running (${status}).` };
  fs.writeFileSync(path.join(jobDir(job.id), 'cancel'), String(Date.now()));
  return { text: `Cancelling ${job.id} (takes a couple of seconds).` };
}

// ---------------------------------------------------------------- MCP stdio

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function instructions() {
  let text = 'Use codex_plan to get an implementation plan or second opinion from Codex (read-only), and codex_image to have Codex generate images. ' +
    'Claude implements; Codex plans and builds images. Codex calls take minutes: when there is other work to do meanwhile, pass background=true and collect the result with codex_result. ' +
    'Jobs are durable: they survive Claude closing, and codex_resume continues interrupted ones.';
  try {
    const interrupted = listJobs().filter(j => jobStatus(j).status === 'interrupted').slice(0, 10);
    if (interrupted.length) {
      text += `\n\nInterrupted Codex jobs from earlier sessions (tell the user; resume with codex_resume if they want them):\n${interrupted.map(jobLine).join('\n')}`;
    }
  } catch {}
  return text;
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: instructions(),
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const token = params?._meta?.progressToken;
      let progress = 0;
      const onActivity = token === undefined ? undefined : (message, ev) => {
        if (ev.type === 'item.started' || ev.type === 'item.completed') {
          send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++progress, message: `codex: ${message}` } });
        }
      };
      try {
        let out;
        if (name === 'codex_plan' || name === 'codex_image') out = await callJobTool(name, args, onActivity);
        else if (name === 'codex_result') out = await jobResult(args);
        else if (name === 'codex_resume') out = await resumeJob(args);
        else if (name === 'codex_cancel') out = cancelJob(args);
        else return replyError(id, -32602, `Unknown tool: ${name}`);
        return reply(id, { content: [{ type: 'text', text: out.text }], isError: !!out.isError });
      } catch (err) {
        return reply(id, { content: [{ type: 'text', text: `codex-bridge error: ${err.message}` }], isError: true });
      }
    }
    default:
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return replyError(null, -32700, 'Parse error'); }
  handle(msg).catch(err => process.stderr.write(`codex-bridge: ${err.stack}\n`));
});
// Jobs run in their own processes, so the server can simply exit with stdin.
process.stdin.on('end', () => process.exit(0));

try { pruneOldJobs(); } catch {}
process.stderr.write(`codex-bridge ready (codex: ${CODEX_BIN ?? 'NOT FOUND'}, jobs: ${JOBS_DIR})\n`);
