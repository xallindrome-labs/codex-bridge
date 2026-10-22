#!/usr/bin/env node
// Runs one attempt of a codex-bridge job, detached from Claude Code, so the job
// survives Claude closing or crashing. Usage: node runner.mjs <jobId> <attempt>
//
// Reads   jobs/<id>/job.json, attempt-<n>/spec.json, attempt-<n>/prompt.txt
// Writes  attempt-<n>/events.jsonl, stderr.txt, state.json, heartbeat, result.json

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  EventTail, attemptDir, collectImages, jobDir, jobImages, killTree, readJson, writeJson,
} from './lib.mjs';

const [jobId, n] = process.argv.slice(2);
const dir = attemptDir(jobId, n);
const job = readJson(path.join(jobDir(jobId), 'job.json'));
const spec = readJson(path.join(dir, 'spec.json'));
const IDLE_TIMEOUT_MS = spec.idleTimeoutMs;
const started = Date.now();

const eventsFile = path.join(dir, 'events.jsonl');
const stdin = fs.openSync(path.join(dir, 'prompt.txt'), 'r');
const stdout = fs.openSync(eventsFile, 'a');
const stderr = fs.openSync(path.join(dir, 'stderr.txt'), 'a');

const child = spawn(spec.bin, spec.args, {
  cwd: spec.cwd,
  env: { ...process.env, ...spec.env },
  stdio: [stdin, stdout, stderr],
  windowsHide: true,
});
writeJson(path.join(dir, 'state.json'), { runnerPid: process.pid, codexPid: child.pid, started });

const beat = () => fs.writeFileSync(path.join(dir, 'heartbeat'), String(Date.now()));
beat();

let cancelled = false;
let timedOut = false;
let lastSize = 0;
let lastGrowth = Date.now();
const tail = new EventTail(eventsFile);

const watchdog = setInterval(() => {
  beat();
  // Copy images out as they are generated, so a crash loses at most the one in flight.
  if (job.tool === 'codex_image') {
    try { collectImages(job, tail.poll().threadId); } catch {}
  }
  if (!cancelled && fs.existsSync(path.join(jobDir(jobId), 'cancel'))) {
    cancelled = true;
    killTree(child.pid);
  }
  const size = fs.existsSync(eventsFile) ? fs.statSync(eventsFile).size : 0;
  if (size !== lastSize) { lastSize = size; lastGrowth = Date.now(); }
  if (!timedOut && Date.now() - lastGrowth > IDLE_TIMEOUT_MS) {
    timedOut = true;
    killTree(child.pid);
  }
}, 2000);

function finish(exitCode, spawnError) {
  clearInterval(watchdog);
  const s = new EventTail(eventsFile).poll();
  const status = cancelled ? 'cancelled'
    : timedOut ? 'timed_out'
    : spawnError ? 'failed'
    : s.completed && !s.failed ? 'done'
    : 'failed';

  let images;
  if (job.tool === 'codex_image') {
    collectImages(job, s.threadId, { settled: false });
    images = jobImages(job);
  }

  let stderrTail = '';
  try { stderrTail = fs.readFileSync(path.join(dir, 'stderr.txt'), 'utf8').slice(-4000).trim(); } catch {}

  writeJson(path.join(dir, 'result.json'), {
    status,
    exitCode,
    threadId: s.threadId,
    message: s.messages.at(-1) ?? null,
    failed: s.failed,
    errors: s.errors,
    usage: s.usage,
    images,
    stderrTail: status === 'done' ? '' : stderrTail,
    spawnError: spawnError?.message,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    started,
    finished: Date.now(),
  });
  process.exit(0);
}

child.on('error', err => finish(null, err));
child.on('exit', code => finish(code));
