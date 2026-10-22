// Shared helpers for server.mjs (MCP side) and runner.mjs (detached job runner).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const isWin = process.platform === 'win32';
export const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const BRIDGE_HOME = process.env.CODEX_BRIDGE_HOME || path.join(os.homedir(), '.codex-bridge');
export const JOBS_DIR = path.join(BRIDGE_HOME, 'jobs');
export const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

// ---------------------------------------------------------------- codex binary

function findOnPath(name) {
  const r = spawnSync(isWin ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return [];
  return r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

// Prefer a codex binary that sits next to codex-code-mode-host, otherwise
// Codex logs a "Code Mode is unavailable" error on every run.
export function resolveCodexBin() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const exe = isWin ? 'codex.exe' : 'codex';
  const candidates = [
    ...findOnPath(exe),
    path.join(CODEX_HOME, 'plugins', '.plugin-appserver', exe),
    path.join(CODEX_HOME, '.sandbox-bin', exe),
  ].filter(p => fs.existsSync(p));
  const host = isWin ? 'codex-code-mode-host.exe' : 'codex-code-mode-host';
  return candidates.find(p => fs.existsSync(path.join(path.dirname(p), host))) ?? candidates[0] ?? null;
}

// `codex exec` (or `codex exec resume`) arguments; the prompt is always read from stdin.
export function buildCodexArgs({ sandbox, cwd, sessionId, model, effort, images = [] }) {
  const args = ['exec'];
  if (sessionId) args.push('resume');
  args.push('--json', '--skip-git-repo-check', '-c', `sandbox_mode="${sandbox}"`);
  if (!sessionId) args.push('-s', sandbox, '-C', cwd);
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  for (const img of images) args.push('-i', img);
  if (sessionId) args.push(sessionId);
  args.push('-');
  return args;
}

// ---------------------------------------------------------------- files

export function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

// Atomic write so a reader never sees a half-written file.
export function writeJson(p, obj) {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

export const jobDir = id => path.join(JOBS_DIR, id);
export const attemptDir = (id, n) => path.join(JOBS_DIR, id, `attempt-${n}`);

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function killTree(pid) {
  if (!pid) return;
  if (isWin) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
}

// ---------------------------------------------------------------- codex events

export function newEventState() {
  return { threadId: null, messages: [], errors: [], usage: null, failed: null, completed: false, activity: 'starting' };
}

export function summarizeEvent(ev) {
  if (ev.type === 'item.started' && ev.item?.type === 'command_execution') return `running ${String(ev.item.command).slice(0, 120)}`;
  if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') return ev.item.text.slice(0, 160);
  if (ev.type === 'item.completed' && ev.item?.type) return ev.item.type;
  return null;
}

export function applyEvent(s, ev) {
  if (ev.type === 'thread.started') s.threadId = ev.thread_id;
  else if (ev.type === 'turn.completed') { s.completed = true; s.usage = ev.usage; }
  else if (ev.type === 'turn.failed') s.failed = ev.error?.message || JSON.stringify(ev.error);
  else if (ev.type === 'error') s.errors.push(ev.message);
  else if (ev.type === 'item.completed' && ev.item) {
    if (ev.item.type === 'agent_message') s.messages.push(ev.item.text);
    else if (ev.item.type === 'error' && !/Code Mode is unavailable/.test(ev.item.message)) s.errors.push(ev.item.message);
  }
  s.activity = summarizeEvent(ev) ?? s.activity;
}

// Incrementally reads a growing JSONL events file.
export class EventTail {
  constructor(file) { this.file = file; this.offset = 0; this.partial = ''; this.state = newEventState(); }
  poll(onEvent) {
    let fd;
    try { fd = fs.openSync(this.file, 'r'); } catch { return this.state; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size > this.offset) {
        const buf = Buffer.alloc(size - this.offset);
        fs.readSync(fd, buf, 0, buf.length, this.offset);
        this.offset = size;
        const lines = (this.partial + buf.toString('utf8')).split(/\r?\n/);
        this.partial = lines.pop();
        for (const line of lines) {
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          applyEvent(this.state, ev);
          onEvent?.(ev);
        }
      }
    } finally { fs.closeSync(fd); }
    return this.state;
  }
}

// ---------------------------------------------------------------- images

export function listImages(dir, sinceMs = 0) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => IMAGE_EXT.test(f))
    .map(f => path.join(dir, f))
    .filter(p => fs.statSync(p).mtimeMs >= sinceMs)
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

function uniquePath(dir, name) {
  const { name: base, ext } = path.parse(name);
  let p = path.join(dir, name);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base}-${i}${ext}`);
  return p;
}

// Codex never writes images itself: its image tool drops every generated image
// into generated_images/<thread>/, and we copy them out from there. copied.json
// maps store filename -> output path, so nothing is copied twice across attempts.
const copiedFile = job => path.join(jobDir(job.id), 'copied.json');

export const jobImages = job => Object.values(readJson(copiedFile(job), {})).filter(p => fs.existsSync(p));

// Copies newly generated images of `threadId` into the job's output dir as
// <base>.png, <base>-2.png, ... in generation order. With `settled`, skips files
// modified in the last 1.5s (may still be being written). Returns the new paths.
export function collectImages(job, threadId, { settled = true } = {}) {
  if (!threadId) return [];
  const store = path.join(CODEX_HOME, 'generated_images', threadId);
  const copied = readJson(copiedFile(job), {});
  const base = path.parse(job.args.filename || 'image').name;
  const added = [];
  for (const src of listImages(store, job.created - 1000)) {
    const key = path.basename(src);
    if (copied[key]) continue;
    if (settled && Date.now() - fs.statSync(src).mtimeMs < 1500) continue;
    const n = Object.keys(copied).length + 1;
    const dest = uniquePath(job.outDir, `${base}${n > 1 ? `-${n}` : ''}${path.extname(src)}`);
    fs.copyFileSync(src, dest);
    copied[key] = dest;
    added.push(dest);
  }
  if (added.length) writeJson(copiedFile(job), copied);
  return added;
}
