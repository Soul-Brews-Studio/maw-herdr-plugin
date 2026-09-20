#!/usr/bin/env node
// All peer destinations, keys and homes are disposable fixtures; no live fleet.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-federation-smoke-')));
const token = 'fixture-dashboard-token-not-a-peer-credential';
const fleet = 'fixture-fleet-token', key = '0123456789abcdef0123456789abcdef';
const tokenFile = join(home, 'token'), peersFile = join(home, 'peers.json');
writeFileSync(tokenFile, token, { mode: 0o600 });
const seen = [], sockets = new Set();
let active = 0, peak = 0, targetHits = 0;
const peer = createServer((req, res) => {
  seen.push({ path: req.url, headers: req.headers });
  active++; peak = Math.max(peak, active); res.once('close', () => active--);
  if (req.url.startsWith('/redirect/')) { res.writeHead(302, { Location: peerURL + '/stolen/api/sessions' }); res.end(); }
  else if (req.url.startsWith('/stolen/')) { targetHits++; res.end('[]'); }
  else if (req.url.startsWith('/denied/')) { res.writeHead(401); res.end('private fixture detail'); }
  else if (req.url.startsWith('/broken/')) res.end('not JSON');
  else if (req.url.startsWith('/huge/')) res.end(' '.repeat((1 << 20) + 1));
  else if (req.url.startsWith('/slow/')) { /* deadline must close this socket */ }
  else if (req.url.startsWith('/wait/')) setTimeout(() => res.end('[{"name":"delayed"}]'), 50);
  else { res.setHeader('Content-Type', 'application/json'); res.end('[{"name":"fixture-session","windows":[]}]'); }
});
peer.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
await new Promise(done => peer.listen(0, '127.0.0.1', done));
const peerURL = 'http://127.0.0.1:' + peer.address().port;
const store = entries => writeFileSync(peersFile, JSON.stringify({ version: 1, peers: entries }));
const record = (path, extra = {}) => ({ url: peerURL + path, node: 'fixture-node', identity: { oracle: 'fixture-oracle' }, authOk: true, ...extra });
store({ alpha: record('/ok'), beta: record('/denied'), broken: record('/broken'), redirect: record('/redirect'), huge: record('/huge'), slow: record('/slow') });
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home, XDG_CACHE_HOME: home };
for (const name of Object.keys(env)) if (/^(MAW_|HERDR_|PEERS_FILE$)/.test(name)) delete env[name];
Object.assign(env, { PEERS_FILE: peersFile, MAW_SENDER: 'fixture-node:fixture-oracle', MAW_FEDERATION_TOKEN: fleet, MAW_PEER_KEY: key });
const args = ['--token-file', tokenFile, '--listen', '127.0.0.1:0', '--herdr', join(home, 'must-not-run'), '--data-dir', join(home, 'ui')];
const native = process.argv[2];
const child = spawn(native ? resolve(native) : (process.versions.bun ? process.execPath : 'bun'),
  native ? args : [resolve(process.env.MAW_FEDERATION_ENTRY || 'index.mjs'), 'serve', ...args],
  { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
const exited = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })));
const deadline = async (promise, label, ms = 10000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timed out')), ms); })]); }
  finally { clearTimeout(timer); }
};
try {
  const url = await deadline(new Promise((done, fail) => {
    child.stderr.on('data', data => { log += data; const match = log.match(/http:\/\/[^\s]+/); if (match) done(match[0]); });
    child.once('error', fail); child.once('exit', () => fail(Error(log)));
  }), 'startup');
  const get = (path, auth = true, method = 'GET') => fetch(url + path, {
    method, headers: { Origin: url, ...(auth ? { Authorization: 'Bearer ' + token } : {}) }, signal: AbortSignal.timeout(12000),
  });
  for (const path of ['/api/federation/status', '/fed.json']) assert.equal((await get(path, false)).status, 401);
  assert.equal(seen.length, 0, 'unauthenticated callers cannot cause peer probes');
  assert.equal((await get('/api/federation/status', true, 'POST')).status, 405);
  const config = await (await get('/api/config')).json();
  assert.equal(config.namedPeers.length, 6); assert.deepEqual(config.namedPeers.find(p => p.name === 'alpha'), { name: 'alpha', url: peerURL + '/ok' });
  assert.equal(seen.length, 0, 'config reads inventory without probing');
  const started = Date.now();
  const responses = await Promise.all(Array.from({ length: 5 }, () => get('/api/federation/status')));
  for (const response of responses) assert.equal(response.status, 200, await response.clone().text());
  const result = await responses[0].json();
  assert.ok(Date.now() - started < 7000, 'bounded parallel probe deadline');
  assert.equal(result.totalPeers, 6); assert.equal(result.reachablePeers, 5);
  assert.equal(result.local_url, ''); assert.equal(result.peers.length, 6);
  const row = prefix => result.peers.find(p => p.url === peerURL + prefix);
  assert.deepEqual(row('/ok').agents, ['fixture-session']);
  assert.equal(row('/ok').reachable, true); assert.equal(row('/ok').oracle, 'fixture-oracle');
  assert.equal(row('/ok').auth_ok, true); assert.equal(row('/ok').node_unique, false);
  assert.equal(row('/ok').loopback_self, true); assert.equal(row('/ok').resolved_ip, '127.0.0.1');
  for (const path of ['/denied', '/broken', '/redirect', '/huge']) {
    assert.equal(row(path).reachable, true); assert.deepEqual(row(path).agents, []); assert.ok(row(path).fetch_error);
  }
  assert.equal(row('/slow').reachable, false); assert.ok(row('/slow').fetch_error);
  assert.equal(seen.length, 6, 'concurrent requests share one sweep'); assert.ok(peak <= 4, 'at most four simultaneous peers');
  assert.equal(targetHits, 0, 'redirects never receive signatures');
  const hmac = (secret, payload) => createHmac('sha256', secret).update(payload).digest('hex');
  for (const { headers, path } of seen) {
    assert.ok(path.endsWith('/api/sessions')); assert.equal(headers.authorization, undefined);
    assert.equal(headers['x-maw-from'], 'fixture-oracle:fixture-node'); assert.equal(headers['x-maw-auth-version'], 'v3');
    const timestamp = headers['x-maw-timestamp']; assert.match(timestamp, /^[0-9]+$/);
    assert.equal(headers['x-maw-signature'], hmac(fleet, 'GET:/api/sessions:' + timestamp));
    assert.equal(headers['x-maw-signature-v3'], hmac(key, 'GET:/api/sessions:' + timestamp + '::fixture-oracle:fixture-node'));
    assert.ok(!JSON.stringify(headers).includes(token));
  }
  const alias = await get('/fed.json'); assert.equal(alias.status, 200);
  assert.deepEqual(await alias.json(), result); assert.equal(seen.length, 6, 'alias shares cached outcomes');
  store({ fresh: record('/new', { node: 'unique', authOk: null }) });
  const fresh = await (await get('/api/federation/status')).json();
  assert.equal(fresh.totalPeers, 1); assert.equal(fresh.peers[0].node_unique, true); assert.equal(fresh.peers[0].auth_ok, null);
  assert.equal(seen.length, 7, 'changed store invalidates cache immediately');
  store(Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['p' + i, record('/wait/' + i)])));
  peak = 0;
  const parallel = await (await get('/api/federation/status')).json();
  assert.equal(parallel.totalPeers, 9); assert.ok(peak <= 4);
  store(Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['p' + i, record('/ok')])));
  assert.equal((await get('/api/federation/status')).status, 503, 'oversized peer inventory refused');
  writeFileSync(peersFile, '{');
  assert.equal((await get('/api/federation/status')).status, 503, 'malformed inventory is not a successful empty fleet');
  assert.equal((await get('/api/config')).status, 503);
  store({});
  const empty = await (await get('/api/federation/status')).json(); assert.deepEqual(empty.peers, []); assert.equal(empty.totalPeers, 0);
  child.kill('SIGTERM'); assert.equal((await deadline(exited, 'shutdown')).code, 0);
  console.log('PASS federation (' + (native ? 'native' : 'bun') + '): auth, inventory, signed probes, failure semantics, cache/singleflight, limits, no redirect/token leak');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM'); await Promise.race([exited, new Promise(done => setTimeout(done, 1500))]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
  for (const socket of sockets) socket.destroy();
  await new Promise(done => peer.close(done));
  rmSync(home, { recursive: true, force: true });
}
