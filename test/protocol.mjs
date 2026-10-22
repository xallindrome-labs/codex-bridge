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

const server = fileURLToPath(new URL('../server.mjs', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-test-'));

const child = spawn(process.execPath, [server], {
  env: { ...process.env, CODEX_BRIDGE_HOME: home },
  stdio: ['pipe', 'pipe', 'inherit'],
});
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

try {
  const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'codex-bridge');
  assert.equal(init.result.serverInfo.version, pkg.version);

  const tools = (await call('tools/list', {})).result.tools.map(t => t.name).sort();
  assert.deepEqual(tools, ['codex_cancel', 'codex_image', 'codex_plan', 'codex_result', 'codex_resume']);

  const badEffort = await call('tools/call', { name: 'codex_plan', arguments: { request: 'x', cwd: home, effort: 'turbo' } });
  assert.equal(badEffort.result.isError, true);
  assert.match(badEffort.result.content[0].text, /effort must be/);

  const unknown = await call('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.error.code, -32602);

  const list = await call('tools/call', { name: 'codex_result', arguments: {} });
  assert.match(list.result.content[0].text, /No Codex jobs yet/);

  console.log('protocol test: ok');
} finally {
  child.kill();
  fs.rmSync(home, { recursive: true, force: true });
}
