// Protocol-level test that needs no Codex CLI: starts server.mjs over stdio and
// checks the MCP handshake, the tool list and input validation.
// Usage: node test/protocol.mjs
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// CODEX_BRIDGE_TEST_SERVER lets CI point the same test at the server inside the packed tarball.
const server = process.env.CODEX_BRIDGE_TEST_SERVER ?? fileURLToPath(new URL('../server.mjs', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-test-'));

// Starts a server with the given extra env and returns a `call(method, params)` helper.
function start(extraEnv = {}) {
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, CODEX_BRIDGE_HOME: home, CODEX_BRIDGE_WRITE_ROOT: '', ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const pending = new Map();
  let nextId = 1;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000);
    pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const init = () => call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  const toolNames = async () => (await call('tools/list', {})).result.tools.map(t => t.name).sort();
  return { child, call, init, toolNames, stderr: () => stderr };
}

const procs = [];
try {
  const s = start();
  procs.push(s.child);
  const init = await s.init();
  assert.equal(init.result.serverInfo.name, 'codex-bridge');
  assert.equal(init.result.serverInfo.version, pkg.version);

  // Without the opt-in there is no write tool.
  assert.deepEqual(await s.toolNames(), ['codex_cancel', 'codex_image', 'codex_plan', 'codex_result', 'codex_resume']);
  const off = await s.call('tools/call', { name: 'codex_code', arguments: { request: 'x', cwd: home } });
  assert.equal(off.result.isError, true);
  assert.match(off.result.content[0].text, /switched off/);

  const badEffort = await s.call('tools/call', { name: 'codex_plan', arguments: { request: 'x', cwd: home, effort: 'turbo' } });
  assert.equal(badEffort.result.isError, true);
  assert.match(badEffort.result.content[0].text, /effort must be/);

  const unknown = await s.call('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.error.code, -32602);

  const list = await s.call('tools/call', { name: 'codex_result', arguments: {} });
  assert.match(list.result.content[0].text, /No Codex jobs yet/);

  // With CODEX_BRIDGE_WRITE_ROOT the write tool appears, and only for that folder.
  const root = path.join(home, 'project');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  const outside = path.join(home, 'elsewhere');
  fs.mkdirSync(outside);
  const w = start({ CODEX_BRIDGE_WRITE_ROOT: root, CODEX_BIN: process.execPath });
  procs.push(w.child);
  const winit = await w.init();
  assert.match(winit.result.instructions, /codex_code/);
  assert.deepEqual(await w.toolNames(), ['codex_cancel', 'codex_code', 'codex_image', 'codex_plan', 'codex_result', 'codex_resume']);
  for (const bad of [outside, path.join(root, '..'), path.join(root, 'sub', '..', '..', 'elsewhere')]) {
    const r = await w.call('tools/call', { name: 'codex_code', arguments: { request: 'x', cwd: bad } });
    assert.equal(r.result.isError, true, `expected ${bad} to be refused`);
    assert.match(r.result.content[0].text, /may only write inside/);
  }

  // A write root that is a drive root or the home folder is refused and the tool stays off.
  const broad = start({ CODEX_BRIDGE_WRITE_ROOT: os.homedir() });
  procs.push(broad.child);
  await broad.init();
  assert.ok(!(await broad.toolNames()).includes('codex_code'));
  assert.match(broad.stderr(), /too broad/);

  console.log('protocol test: ok');
} finally {
  for (const c of procs) c.kill();
  fs.rmSync(home, { recursive: true, force: true });
}
