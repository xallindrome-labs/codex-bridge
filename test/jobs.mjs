// Job lifecycle test against a fake `codex` executable (no Codex CLI, login or quota needed).
// Covers the headline feature: a background job runs, can be collected, and survives the
// server that started it being killed.
// POSIX only for now: the runner spawns CODEX_BIN directly, and Windows cannot spawn a script
// shim without a shell. Windows job handling is covered by `node smoke-test.mjs <dir> durable`.
// Usage: node test/jobs.mjs
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  console.log('jobs test: skipped on Windows (see the comment at the top of this file)');
  process.exit(0);
}

const server = process.env.CODEX_BRIDGE_TEST_SERVER ?? fileURLToPath(new URL('../server.mjs', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-jobs-'));
const home = path.join(tmp, 'home');
const project = path.join(tmp, 'project');
fs.mkdirSync(project);

// A stand-in for the Codex CLI: reads the prompt from stdin, emits the JSONL events the runner parses.
const argvLog = path.join(tmp, 'argv.jsonl');
const fake = path.join(tmp, 'codex');
fs.writeFileSync(fake, `#!/usr/bin/env node
let prompt = '';
process.stdin.on('data', d => { prompt += d; });
process.stdin.on('end', () => {
  require('node:fs').appendFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify({ args: process.argv.slice(2), prompt }) + '\\n');
  const slow = /SLOW/.test(prompt);
  const out = ev => process.stdout.write(JSON.stringify(ev) + '\\n');
  out({ type: 'thread.started', thread_id: 'thread-fake-1' });
  setTimeout(() => {
    out({ type: 'item.completed', item: { type: 'agent_message', text: 'FAKE PLAN: ' + (slow ? 'slow' : 'fast') } });
    out({ type: 'turn.completed', usage: {} });
  }, slow ? 3000 : 200);
});
`, { mode: 0o755 });

function start() {
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, CODEX_BIN: fake, CODEX_BRIDGE_HOME: home, CODEX_BRIDGE_WRITE_ROOT: project, FAKE_ARGV_LOG: argvLog },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map();
  let id = 1;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const i = id++;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60_000);
    pending.set(i, m => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  });
  const tool = async (name, args) => (await call('tools/call', { name, arguments: args })).result;
  return { child, call, tool };
}

let s = start();
try {
  await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jobs-test', version: '0' } });

  // 1. A foreground-style background job runs to completion and is collectable.
  const quick = await s.tool('codex_plan', { request: 'plan something', cwd: project, background: true });
  const quickId = quick.content[0].text.match(/job-\d{12}-[0-9a-f]{4}/)?.[0];
  assert.ok(quickId, `expected a job id, got: ${quick.content[0].text}`);
  const done = await s.tool('codex_result', { job_id: quickId, wait_seconds: 30 });
  assert.equal(done.isError, false, done.content[0].text);
  assert.match(done.content[0].text, /FAKE PLAN: fast/);
  assert.match(done.content[0].text, /session_id: thread-fake-1/);

  // 2. A job keeps running when the server that started it dies, and a new server collects it.
  const slow = await s.tool('codex_plan', { request: 'SLOW plan', cwd: project, background: true });
  const slowId = slow.content[0].text.match(/job-\d{12}-[0-9a-f]{4}/)?.[0];
  assert.ok(slowId);
  s.child.kill();
  s = start();
  await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jobs-test-2', version: '0' } });
  const survived = await s.tool('codex_result', { job_id: slowId, wait_seconds: 30 });
  assert.equal(survived.isError, false, survived.content[0].text);
  assert.match(survived.content[0].text, /FAKE PLAN: slow/);

  // 3. The job list shows both jobs; resuming a finished job is refused.
  const list = await s.tool('codex_result', {});
  assert.ok(list.content[0].text.includes(quickId) && list.content[0].text.includes(slowId));
  const resume = await s.tool('codex_resume', { job_id: quickId });
  assert.equal(resume.isError, true);
  assert.match(resume.content[0].text, /already finished/);

  // 4. The opt-in write tool runs Codex in the workspace-write sandbox with no network and no temp dirs;
  //    the read-only planner never gets those flags.
  const code = await s.tool('codex_code', { request: 'add a flag', cwd: project, background: true });
  const codeId = code.content[0].text.match(/job-\d{12}-[0-9a-f]{4}/)?.[0];
  assert.ok(codeId, `expected a job id, got: ${code.content[0].text}`);
  const codeDone = await s.tool('codex_result', { job_id: codeId, wait_seconds: 30 });
  assert.equal(codeDone.isError, false, codeDone.content[0].text);
  assert.match(codeDone.content[0].text, /Review the diff/);
  const runs = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const codeRun = runs.find(r => /BUILDER/.test(r.prompt));
  const planRun = runs.find(r => /PLANNER/.test(r.prompt));
  assert.ok(codeRun && planRun, 'expected one builder run and one planner run');
  assert.deepEqual(codeRun.args.slice(codeRun.args.indexOf('-s'), codeRun.args.indexOf('-s') + 2), ['-s', 'workspace-write']);
  for (const flag of ['sandbox_workspace_write.network_access=false', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.exclude_slash_tmp=true']) {
    assert.ok(codeRun.args.includes(flag), `codex_code run is missing ${flag}`);
  }
  assert.ok(planRun.args.includes('read-only') && !planRun.args.some(a => a.startsWith('sandbox_workspace_write')));
  const outside = await s.tool('codex_code', { request: 'x', cwd: tmp });
  assert.equal(outside.isError, true);

  console.log('jobs test: ok');
} finally {
  s.child.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
