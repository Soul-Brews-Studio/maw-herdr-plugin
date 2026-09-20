#!/usr/bin/env node
// Actual Bun/native servers; only private disposable state and a fake Herdr executable.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-state-smoke-')));
const dataDir = join(home, 'ui'), fake = join(home, 'herdr'), calls = join(home, 'herdr-calls');
const token = 'fixture-state-operator-secret', tokenFile = join(home, 'token');
writeFileSync(tokenFile, token, { mode: 0o600 });
writeFileSync(fake, `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, 'unexpected invocation');
process.exit(3);
`, { mode: 0o700 });
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('MAW_') || key.startsWith('HERDR_') || key === 'PEERS_FILE') delete env[key];
Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), MAW_CONFIG_DIR: join(home, 'config'), MAW_TEST_MODE: '1' });
const native = process.argv[2];
const args = ['--token-file', tokenFile, '--listen', '127.0.0.1:0', '--herdr', fake, '--data-dir', dataDir];
let running, url;
async function deadline(promise, label, ms = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function start() {
  const child = spawn(native ? resolve(native) : 'bun', native ? args : [resolve(process.env.MAW_STATE_ENTRY || 'index.mjs'), 'serve', ...args], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const exited = new Promise(done => { child.once('exit', (code, signal) => done({ code, signal })); child.once('error', error => done({ error })); });
  running = { child, exited };
  child.stdout.resume();
  url = await deadline(new Promise((done, fail) => {
    child.stderr.on('data', data => { output += data; const match = output.match(/http:\/\/[^\s]+/); if (match) done(match[0]); });
    child.once('error', fail);
    child.once('exit', () => fail(Error('startup exited: ' + output)));
  }), 'startup');
}
async function stop(check = true) {
  if (!running) return;
  const { child, exited } = running;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  let result;
  try { result = await deadline(exited, 'shutdown', 2000); }
  catch (error) { child.kill('SIGKILL'); await deadline(exited, 'forced shutdown', 2000); if (check) throw error; }
  finally { running = undefined; }
  if (check) assert.equal(result.code, 0, 'clean server shutdown');
}
const request = (path, method = 'GET', body, auth = true) => fetch(url + path, {
  method, headers: { Origin: url, 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + token } : {}) },
  ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(3000),
});
async function get(path, value) {
  const response = await request(path);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), value);
}
const cases = [
  { path: '/api/ui-state', file: 'ui-state.json', empty: {}, value: { selected: 'fixture:agent', layout: { columns: 3, collapsed: false, widths: [320, 640] }, tabs: [{ id: 'terminal', filters: { tags: ['งาน', 'review'], query: 'line\nquoted "value"' } }], optional: null } },
  { path: '/api/asks', file: 'asks.json', empty: [], value: [{ id: 'ask-1', text: 'Please review งาน', answered: false, target: { session: 'fixture', pane: 'p1' }, choices: [{ label: 'ship', value: 1 }, { label: 'wait', value: null }], timestamp: 1789940000000 }] },
];
try {
  await start();
  for (const item of cases) {
    await get(item.path, item.empty);
    assert.equal((await request(item.path, 'GET', undefined, false)).status, 401);
    assert.equal((await request(item.path, 'POST', JSON.stringify(item.value), false)).status, 401);
    await get(item.path, item.empty);
    const response = await request(item.path, 'POST', JSON.stringify(item.value));
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { ok: true });
    await get(item.path, item.value);
  }
  await stop();
  await start();
  for (const item of cases) {
    await get(item.path, item.value);
    const file = join(dataDir, item.file), saved = readFileSync(file);
    // Exceed the 256 KiB state limit, not Bun's separate 257 KiB transport limit.
    for (const invalid of ['{"truncated":', 'null', '42', JSON.stringify(item.empty instanceof Array ? {} : []), JSON.stringify({ padding: 'x'.repeat(256 << 10) })]) {
      const response = await request(item.path, 'POST', invalid);
      assert.ok(response.status >= 400 && response.status < 500, 'invalid POST rejected: ' + response.status);
      await response.text();
      assert.deepEqual(readFileSync(file), saved, 'invalid POST must preserve exact previous bytes');
      await get(item.path, item.value);
    }
    const secret = 'outside-state-must-not-leak';
    const outside = join(home, item.file + '.outside');
    writeFileSync(outside, JSON.stringify(item.empty instanceof Array ? [secret] : { secret }));
    const fixtures = [
      ['corrupt', () => writeFileSync(file, 'not json ' + secret)],
      ['truncated', () => writeFileSync(file, '{"secret":"' + secret)],
      ['invalid UTF-8', () => writeFileSync(file, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]))],
      ['wrong shape', () => writeFileSync(file, 'null')],
      ['oversized', () => writeFileSync(file, JSON.stringify(item.empty instanceof Array ? ['x'.repeat(256 << 10)] : { padding: 'x'.repeat(256 << 10) }))],
      ['symlink', () => symlinkSync(outside, file)],
      ['directory', () => mkdirSync(file)],
      ['FIFO', () => { const result = spawnSync('mkfifo', [file], { timeout: 2000 }); assert.equal(result.status, 0, result.error?.message || String(result.stderr)); }],
    ];
    for (const [label, prepare] of fixtures) {
      rmSync(file, { recursive: true, force: true });
      prepare();
      const response = await request(item.path);
      assert.equal(response.status, 500, label + ' GET rejected');
      assert.deepEqual(await response.json(), { error: 'state_read_failed' }, label + ' must not leak state contents');
      rmSync(file, { recursive: true, force: true });
      writeFileSync(file, saved);
      await get(item.path, item.value);
    }
    assert.equal(readFileSync(outside, 'utf8').includes(secret), true, 'outside state remains intact');
  }
  await stop();
  assert.throws(() => readFileSync(calls), { code: 'ENOENT' }, 'state routes must never invoke Herdr');
  console.log('PASS state (' + (native ? 'native' : 'bun') + '): authenticated nested JSON persistence across restart, invalid writes preserve bytes, corrupt/oversized/symlink/directory/FIFO reads reject safely');
} finally {
  await stop(false);
  rmSync(home, { recursive: true, force: true });
}
