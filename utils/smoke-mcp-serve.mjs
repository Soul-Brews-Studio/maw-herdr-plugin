#!/usr/bin/env node
// `serve --mcp` (#61): a real MCP handshake over HTTP against actual server
// processes, with only a fake Herdr executable and disposable state. Never
// touches a live herdr: the fake is passed with --herdr and PATH holds only Bun and /usr/bin:/bin.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const entry = resolve(process.env.MAW_MCP_ENTRY || 'index.mjs');
const home = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-mcp-smoke-')));
const token = 'fixture-mcp-operator-secret-0123456789';
// A space and a quote in the path: every fix command must shell-quote it.
mkdirSync(join(home, "tok dir's"));
const tokenFile = join(home, "tok dir's", 'token');
const fake = join(home, 'herdr'), calls = join(home, 'calls.jsonl');
const target = 'bWFpbg/d0Q:4';
writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
mkdirSync(join(home, 'home'));
// PATH holds only Bun (via a private symlink) and the system dirs, so no code
// path can reach the real herdr even by name.
const bun = process.env.BUN || spawnSync('sh', ['-c', 'command -v bun'], { encoding: 'utf8' }).stdout.trim();
assert.ok(bun, 'bun on PATH');
mkdirSync(join(home, 'bin')); symlinkSync(realpathSync(bun), join(home, 'bin', 'bun'));
// Same protocol-22 roster as utils/smoke-bun-serve.mjs.
writeFileSync(fake, `#!${realpathSync(bun)}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (JSON.stringify(args) === JSON.stringify(['session','list','--json'])) console.log(JSON.stringify({sessions:[{name:'main',running:true}]}));
else if (args[2] === 'api') console.log(JSON.stringify({result:{snapshot:{protocol:22,workspaces:[{workspace_id:'wD',label:'demo'}],panes:[{pane_id:'wD:p4',workspace_id:'wD',agent:'codex',focused:true,agent_status:'idle',cwd:'/tmp'},{pane_id:'wD:p9',workspace_id:'wD',agent:null,focused:false,agent_status:'unknown',cwd:'/tmp'}]}}}));
else if (args[2] === 'pane') process.stdout.write('visible output\\n');
else if (args[2] === 'agent') console.log('{"ok":true}');
else { console.error('unexpected args', args); process.exit(8); }
`);
chmodSync(fake, 0o700);
const env = { ...process.env, HOME: join(home, 'home'), XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache') };
for (const key of Object.keys(env)) if (key.startsWith('MAW_') || key.startsWith('HERDR_') || key === 'PEERS_FILE') delete env[key];
Object.assign(env, { PATH: `${join(home, 'bin')}:/usr/bin:/bin`, MAW_CONFIG_DIR: join(home, 'config'), MAW_TEST_MODE: '1', PEERS_FILE: join(home, 'absent-peers.json') });

const children = new Set();
let logs = '', checks = 0;
async function deadline(promise, label, ms = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function start(args) {
  const child = spawn(bun, [entry, 'serve', '--listen', '127.0.0.1:0', '--herdr', fake, '--data-dir', join(home, 'data'), ...args], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = '';
  const exited = new Promise(done => child.once('exit', code => done(code)));
  child.stdout.on('data', data => { logs += data; });
  const url = await deadline(new Promise((done, fail) => {
    child.stderr.on('data', data => { output += data; logs += data; const match = /MCP at (http:\/\/[^\s]+)\/mcp/.exec(output); if (match) done(match[1]); });
    child.once('error', fail);
    child.once('exit', () => fail(Error('startup exited: ' + output)));
  }), 'startup');
  return { url, child, exited, output: () => output };
}
async function stop(server) {
  server.child.kill('SIGTERM');
  assert.equal(await deadline(server.exited, 'shutdown', 3000), 0, 'clean shutdown');
  children.delete(server.child);
}
function http(url, path, { method = 'GET', headers = {}, body } = {}) {
  return deadline(new Promise((done, fail) => {
    let answered;
    const req = request(new URL(path, url), { method, headers }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => raw += chunk);
      const finish = () => { try { answered = { status: res.statusCode, headers: res.headers, raw, json: raw ? JSON.parse(raw) : undefined }; done(answered); } catch (error) { fail(error); } };
      res.on('end', finish);
      // A server refusing an over-limit body answers without reading the rest, so
      // the socket resets after a complete answer. Keep the answer if it parsed.
      res.on('error', error => { try { finish(); } catch { fail(error); } });
    });
    req.on('error', error => answered ? undefined : fail(Object.assign(error, { message: method + ' ' + path + ': ' + error.message }))); req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  }), method + ' ' + path);
}
let nextId = 1;
/** One MCP frame over Streamable HTTP, as a real client sends it. */
async function rpc(url, method, params, { auth, status = 200, headers = {}, version = '2025-06-18', notify = false } = {}) {
  const frame = { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }), ...(notify ? {} : { id: nextId++ }) };
  const response = await http(url, '/mcp', { method: 'POST', body: frame, headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    ...(version ? { 'MCP-Protocol-Version': version } : {}), ...(auth ? { Authorization: 'Bearer ' + auth } : {}), ...headers } });
  assert.equal(response.status, status, `${method}: ${response.raw}`); checks++;
  if (!notify && response.json) assert.equal(response.json.id, response.json.error && status !== 200 ? null : frame.id);
  return response;
}
const toolText = response => { assert.equal(response.json.result.isError, false, response.raw); return JSON.parse(response.json.result.content[0].text); };
const promptCalls = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(args => args[2] === 'agent' && args[3] === 'prompt') : [];

async function handshake(url, auth) {
  const init = await rpc(url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } }, { auth, version: null });
  assert.equal(init.json.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.json.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.json.result.serverInfo.name, 'maw-herdr');
  assert.match(init.json.result.instructions, /always require the operator token/);
  assert.equal(init.headers['mcp-session-id'], undefined, 'stateless server issues no session id');
  const initialized = await rpc(url, 'notifications/initialized', undefined, { auth, notify: true, status: 202 });
  assert.equal(initialized.raw, '');
  const list = await rpc(url, 'tools/list', {}, { auth });
  const tools = Object.fromEntries(list.json.result.tools.map(tool => [tool.name, tool]));
  assert.deepEqual(Object.keys(tools).sort(), ['herdr_agents', 'herdr_capture', 'herdr_send', 'herdr_sessions', 'herdr_wake', 'herdr_worktrees']);
  for (const name of ['herdr_sessions', 'herdr_agents', 'herdr_capture', 'herdr_worktrees']) assert.equal(tools[name].annotations.readOnlyHint, true, name);
  for (const name of ['herdr_send', 'herdr_wake']) assert.equal(tools[name].annotations.readOnlyHint, false, name);
  // A prompt typed into a live agent is not a harmless additive call.
  for (const tool of Object.values(tools)) assert.equal(tool.annotations.destructiveHint, !tool.annotations.readOnlyHint, tool.name);
  for (const tool of Object.values(tools)) assert.equal(tool.inputSchema.type, 'object');
}
/** Every read tool returns exactly what its HTTP twin returns, with the same credentials. */
async function readParity(url, auth) {
  const headers = auth ? { Authorization: 'Bearer ' + auth } : {};
  for (const [tool, args, path] of [
    ['herdr_sessions', {}, '/api/sessions'],
    ['herdr_agents', {}, '/api/agents'],
    ['herdr_capture', { target }, '/api/capture?target=' + encodeURIComponent(target)],
    ['herdr_worktrees', {}, '/api/worktrees'],
  ]) {
    const twin = await http(url, path, { headers });
    assert.equal(twin.status, 200, path + ': ' + twin.raw);
    assert.deepEqual(toolText(await rpc(url, 'tools/call', { name: tool, arguments: args }, { auth })), twin.json, tool + ' matches ' + path);
  }
  assert.equal(toolText(await rpc(url, 'tools/call', { name: 'herdr_capture', arguments: { target } }, { auth })).content, 'visible output\n');
}
function assertUnauthorized(response, error, fix) {
  assert.equal(response.json.error.code, -32001, response.raw);
  assert.equal(response.json.error.data.status, 401);
  assert.equal(response.json.error.data.error, error);
  assert.equal(response.json.result, undefined, 'refused call returns no result');
  assert.ok(response.json.error.message.includes(fix), `fix command ${fix} in: ${response.json.error.message}`);
  assert.ok(!response.raw.includes(token), 'token value never echoed');
}
/** The copy-pasteable lines of a message: every line indented by two spaces. */
const fixLines = text => text.split('\n').filter(line => line.startsWith('  ')).map(line => line.trim());
/** Actually run a printed fix command (only ever curl against our own server). */
function runFix(line) {
  assert.match(line, /^curl /, 'only curl fixes are executed: ' + line);
  const result = spawnSync('bash', ['-c', line], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, line + '\n' + result.stderr); checks++;
  return JSON.parse(result.stdout);
}
/** Every error message ends with a command; for curl ones, run it and expect an answer. */
function assertCurlFix(message, expect = body => assert.ok(body.result || body.agents, JSON.stringify(body))) {
  const lines = fixLines(message);
  assert.ok(lines.length, 'a fix command in: ' + message);
  const curl = lines.find(line => line.startsWith('curl '));
  assert.ok(curl, 'a curl fix in: ' + message);
  expect(runFix(curl));
}
async function mintTicket(url, auth) {
  const minted = await http(url, '/api/auth/ws-ticket', { method: 'POST', body: { path: '/ws' }, headers: { 'Content-Type': 'application/json', Origin: url, ...(auth ? { Authorization: 'Bearer ' + auth } : {}) } });
  assert.equal(minted.status, 200, minted.raw); assert.match(minted.json.ticket, /^mwt1_[0-9a-f]{64}$/);
  return minted.json.ticket;
}
async function originAndHost(url) {
  const port = new URL(url).port;
  const bad = await http(url, '/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'ping' }, headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' } });
  assert.equal(bad.status, 403, bad.raw); assert.equal(bad.json.error, 'origin_not_allowed');
  const host = await http(url, '/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'ping' }, headers: { 'Content-Type': 'application/json', Host: `evil.example:${port}` } });
  assert.equal(host.status, 403, host.raw); assert.equal(host.json.error, 'host_not_allowed');
  const preflight = await http(url, '/mcp', { method: 'OPTIONS', headers: { Origin: url, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, mcp-protocol-version, authorization' } });
  assert.equal(preflight.status, 204, preflight.raw);
  assert.match(preflight.headers['access-control-allow-headers'], /MCP-Protocol-Version/);
  const badPreflight = await http(url, '/mcp', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(badPreflight.status, 403);
  checks += 4;
}

try {
  // --- demo mode: reads answer, writes never run ----------------------------
  const demo = await start(['--insecure-no-token', '--demo-minutes', '5', '--mcp']);
  const port = new URL(demo.url).port;
  const tickets = [await mintTicket(demo.url)];
  await handshake(demo.url);
  await readParity(demo.url);
  const ownOrigin = await rpc(demo.url, 'tools/call', { name: 'herdr_sessions', arguments: {} }, { headers: { Origin: demo.url } });
  assert.equal(ownOrigin.headers['access-control-allow-origin'], demo.url);
  for (const version of ['2025-11-25', '2025-03-26', '2024-11-05']) {
    assert.equal((await rpc(demo.url, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'smoke', version: '1' } }, { version: null })).json.result.protocolVersion, version);
  }
  assert.equal((await rpc(demo.url, 'initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } }, { version: null })).json.result.protocolVersion, '2025-11-25', 'unknown version answered with the newest');
  assert.equal((await rpc(demo.url, 'initialize', { capabilities: {} }, { version: null })).json.error.code, -32602);
  assert.deepEqual((await rpc(demo.url, 'ping', {})).json.result, {});
  for (const name of ['herdr_send', 'herdr_wake']) {
    const args = name === 'herdr_send' ? { target, text: 'must not run' } : { target };
    const refused = await rpc(demo.url, 'tools/call', { name, arguments: args });
    assertUnauthorized(refused, 'operator_token_required_for_writes', `maw herdr serve --mcp --token-file ~/.maw-herdr-token --listen 127.0.0.1:${port}`);
    // The demo still holds the port, so the fix stops it first, and registers
    // the client with the token before the next write fails again.
    assert.deepEqual(fixLines(refused.json.error.message), [
      'test -e ~/.maw-herdr-token || (umask 077; openssl rand -hex 32 > ~/.maw-herdr-token)',
      `kill ${demo.child.pid}`,
      `claude mcp remove herdr 2>/dev/null; claude mcp add --transport http herdr ${demo.url}/mcp --header "Authorization: Bearer $(cat ~/.maw-herdr-token)"`,
      `maw herdr serve --mcp --token-file ~/.maw-herdr-token --listen 127.0.0.1:${port}`,
    ]);
    // Presenting a token changes nothing: demo mode holds none to compare with.
    assertUnauthorized(await rpc(demo.url, 'tools/call', { name, arguments: args }, { auth: token }), 'operator_token_required_for_writes', '--token-file');
    // Auth precedes validation, so a refused caller cannot probe arguments.
    assertUnauthorized(await rpc(demo.url, 'tools/call', { name, arguments: { bogus: 1 } }), 'operator_token_required_for_writes', '--token-file');
  }
  assert.deepEqual(promptCalls(), [], 'no write reached herdr in demo mode');
  // JSON-RPC shape errors.
  for (const [method, params, code] of [
    ['resources/list', {}, -32601],
    ['tools/call', { name: 'herdr_nope', arguments: {} }, -32602],
    ['tools/call', { name: 'herdr_capture', arguments: {} }, -32602],
    ['tools/call', { name: 'herdr_capture', arguments: { target, extra: true } }, -32602],
    ['tools/call', {}, -32602],
    ['initialize', { capabilities: {} }, -32602],
  ]) {
    const response = await rpc(demo.url, method, params);
    assert.equal(response.json.error.code, code, response.raw);
    assertCurlFix(response.json.error.message);
  }
  // A capture miss points at the listing of serve-shaped targets, the shape
  // herdr_capture takes; `maw herdr peek` resolves pane ids, not these.
  const missing = await rpc(demo.url, 'tools/call', { name: 'herdr_capture', arguments: { target: 'nope:1' } });
  assert.equal(missing.json.result.isError, true); assert.match(missing.json.result.content[0].text, /error 400 capture_unavailable/);
  assert.doesNotMatch(missing.json.result.content[0].text, /maw herdr peek/);
  assertCurlFix(missing.json.result.content[0].text, body => assert.ok(body.agents.some(agent => `${agent.session}:${agent.window}` === target), JSON.stringify(body)));
  // Caller-controlled text never becomes part of a suggested command.
  const hostile = await rpc(demo.url, 'tools/call', { name: 'herdr_capture', arguments: { target: 'x$(touch pwned)`id`:1' } });
  assert.equal(hostile.json.result.isError, true);
  for (const line of fixLines(hostile.json.result.content[0].text)) assert.ok(!line.includes('$(touch') && !line.includes('`id`'), 'target echoed into a fix: ' + line);
  assert.equal(existsSync(join(home, 'pwned')), false);
  const post = (body, headers = {}) => http(demo.url, '/mcp', { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers } });
  let response = await post('{"jsonrpc":"2.0","id":1,');
  assert.equal(response.status, 400); assert.equal(response.json.error.code, -32700); assertCurlFix(response.json.error.message);
  response = await post({ jsonrpc: '1.0', id: 1, method: 'ping' });
  assert.equal(response.status, 400); assert.equal(response.json.error.code, -32600); assertCurlFix(response.json.error.message);
  response = await post({ jsonrpc: '2.0', id: null, method: 'ping' });
  assert.equal(response.status, 400); assert.equal(response.json.error.code, -32600); assertCurlFix(response.json.error.message);
  response = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '1999-01-01' });
  assert.equal(response.status, 400); assert.match(response.json.error.message, /unsupported MCP-Protocol-Version/);
  assert.match(response.json.error.message, /-H 'MCP-Protocol-Version: 2025-11-25'/); assertCurlFix(response.json.error.message);
  // Body errors stay inside the JSON-RPC envelope and carry a fix too.
  response = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'Content-Type': 'text/plain' });
  assert.equal(response.status, 415); assert.equal(response.json.error.code, -32600, response.raw); assertCurlFix(response.json.error.message);
  // Over the 256 KiB frame limit but under Bun's 257 KiB transport cap, so the
  // handler (not Bun) answers: it must say "too large", not "not JSON".
  response = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(256 << 10) } }));
  assert.equal(response.status, 413, response.raw); assert.equal(response.json.error.code, -32600);
  assert.match(response.json.error.message, /body over 256 KiB/); assert.doesNotMatch(response.json.error.message, /not JSON/); assertCurlFix(response.json.error.message);
  response = await post([]);
  assert.equal(response.status, 400); assertCurlFix(response.json.error.message);
  response = await post({ jsonrpc: '2.0', id: 7, result: {} });
  assert.equal(response.status, 202, 'client responses are accepted and not answered');
  response = await post([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: 'herdr_send', arguments: { target, text: 'no' } } }]);
  assert.equal(response.status, 200); assert.equal(response.json.length, 2);
  assert.deepEqual(response.json[0], { jsonrpc: '2.0', id: 'a', result: {} });
  assert.equal(response.json[1].error.code, -32001, 'a batched write is refused too');
  response = await http(demo.url, '/mcp');
  assert.equal(response.status, 405); assert.equal(response.headers.allow, 'POST'); assertCurlFix(response.json.error.message);
  // One more MCP call after the ticket was minted, so a logged ticket would show.
  await rpc(demo.url, 'tools/call', { name: 'herdr_sessions', arguments: {} });
  assert.deepEqual(promptCalls(), [], 'no write reached herdr in demo mode');
  await originAndHost(demo.url);
  await stop(demo);
  console.log('PASS mcp demo mode: handshake, version negotiation, reads match HTTP twins, writes refused (-32001/401) with or without a token, JSON-RPC errors, bad Origin/Host refused');

  // --- token mode: everything needs the token; writes run with it -----------
  const secure = await start(['--token-file', tokenFile, '--mcp']);
  tickets.push(await mintTicket(secure.url, token));
  const quotedFile = `'${tokenFile.replace(/'/g, `'\\''`)}'`;
  for (const [method, params] of [['initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } }], ['tools/list', {}], ['tools/call', { name: 'herdr_sessions', arguments: {} }], ['tools/call', { name: 'herdr_send', arguments: { target, text: 'must not run' } }]]) {
    for (const auth of [undefined, 'wrong-token-wrong-token-0000']) {
      assertUnauthorized(await rpc(secure.url, method, params, { auth, status: 401 }), 'operator_token_required',
        `claude mcp remove herdr 2>/dev/null; claude mcp add --transport http herdr ${secure.url}/mcp --header "Authorization: Bearer $(cat ${quotedFile})"`);
    }
  }
  // The printed token-file path survives the shell: $(cat <quoted path>) reads the token.
  const cat = spawnSync('bash', ['-c', `printf %s "$(cat ${quotedFile})"`], { env, encoding: 'utf8' });
  assert.equal(cat.stdout, token, 'quoted token-file path reads back'); checks++;
  const unauthTwin = await http(secure.url, '/api/sessions');
  assert.equal(unauthTwin.status, 401, 'the read tool refusal matches its HTTP twin');
  assert.deepEqual(promptCalls(), [], 'no write reached herdr without a token');
  await handshake(secure.url, token);
  await readParity(secure.url, token);
  const sent = toolText(await rpc(secure.url, 'tools/call', { name: 'herdr_send', arguments: { target, text: 'hello from mcp' } }, { auth: token }));
  assert.equal(sent.ok, true); assert.equal(sent.state, 'accepted'); assert.equal(sent.target, target);
  assert.deepEqual(promptCalls().map(args => args.slice(-2)), [['wD:p4', 'hello from mcp']], 'exactly one prompt, to the resolved pane');
  const stale = await rpc(secure.url, 'tools/call', { name: 'herdr_send', arguments: { target: 'bWFpbg/d0Q:77', text: 'x' } }, { auth: token });
  assert.equal(stale.json.result.isError, true);
  assert.match(stale.json.result.content[0].text, /error 404 target_not_found/);
  // The fix authenticates from the token file without the token in argv, and lists the valid targets.
  assert.ok(!stale.raw.includes(token));
  assertCurlFix(stale.json.result.content[0].text, body => assert.ok(body.agents.some(agent => `${agent.session}:${agent.window}` === target), JSON.stringify(body)));
  const badFrame = await rpc(secure.url, 'resources/list', {}, { auth: token });
  assertCurlFix(badFrame.json.error.message, body => assert.ok(Array.isArray(body.result.tools), JSON.stringify(body)));
  const shell = await rpc(secure.url, 'tools/call', { name: 'herdr_send', arguments: { target: 'bWFpbg/d0Q:9', text: 'x' } }, { auth: token });
  assert.match(shell.json.result.content[0].text, /error 409 target_not_agent/);
  assert.equal(promptCalls().length, 1, 'failed sends typed nothing');
  await originAndHost(secure.url);
  const feed = await http(secure.url, '/api/feed', { headers: { Authorization: 'Bearer ' + token } });
  assert.ok(feed.json.events.some(event => event.state === 'accepted' && event.target === target), 'MCP send is recorded in the delivery feed like POST /api/send');
  // Refused MCP sends are recorded like a refused POST /api/send: two unauthenticated
  // herdr_send frames above, and no event for the refused reads.
  assert.equal(feed.json.events.filter(event => event.event === 'auth-reject').length, 2, JSON.stringify(feed.json.events));
  await rpc(secure.url, 'tools/call', { name: 'herdr_sessions', arguments: {} }, { auth: token });
  await stop(secure);
  console.log('PASS mcp token mode: every frame refused (HTTP 401, -32001) without or with a wrong token, reads match HTTP twins, send runs once with the token, errors carry a fix command');

  // --- /mcp exists only behind --mcp, and never under --engine -------------
  const plain = await (async () => {
    const child = spawn(bun, [entry, 'serve', '--listen', '127.0.0.1:0', '--herdr', fake, '--data-dir', join(home, 'data'), '--token-file', tokenFile], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    const exited = new Promise(done => child.once('exit', code => done(code)));
    let output = '';
    const url = await deadline(new Promise((done, fail) => { child.stderr.on('data', data => { output += data; logs += data; const match = /http:\/\/[^\s]+/.exec(output); if (match) done(match[0]); }); child.once('exit', () => fail(Error(output))); }), 'plain startup');
    return { url, child, exited, output: () => output };
  })();
  assert.doesNotMatch(plain.output(), /MCP at/);
  const absent = await http(plain.url, '/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'ping' }, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } });
  assert.equal(absent.status, 405, 'without --mcp, POST /mcp is an unknown route: ' + absent.raw);
  const absentGet = await http(plain.url, '/mcp', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(absentGet.status, 404, absentGet.raw);
  await stop(plain);
  const engineEnv = { ...env, MAW_ENGINE_SERVE_PORT: '39999', MAW_ENGINE_SERVE_PREFIX: '/api/herdr' };
  const engine = spawn(bun, [entry, 'serve', '--engine', '--mcp'], { cwd: home, env: engineEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let engineOutput = '';
  engine.stderr.on('data', data => { engineOutput += data; logs += data; });
  const engineCode = await deadline(new Promise(done => engine.once('exit', code => done(code))), 'engine refusal');
  assert.notEqual(engineCode, 0);
  assert.match(engineOutput, /--mcp is not available under --engine/);
  assert.match(engineOutput, /maw herdr serve --mcp --token-file ~\/\.maw-herdr-token --listen 127\.0\.0\.1:3457/);
  console.log('PASS mcp gating: /mcp is an unknown route (404/405) without --mcp; --engine --mcp refuses with the command to run instead');

  assert.ok(!logs.includes(token), 'no token value in any server log line');
  assert.equal(tickets.length, 2);
  for (const ticket of tickets) assert.ok(!logs.includes(ticket) && !logs.includes(ticket.slice(5)), 'no minted ticket value in any server log line');
  assert.doesNotMatch(logs, /mwt1_[0-9a-f]{64}/, 'no ticket value in any server log line');
  console.log(`PASS mcp logs: no token or minted ticket value (${tickets.length} minted) in ${logs.split('\n').length} log lines (${checks} checked responses, entry ${process.env.MAW_MCP_ENTRY ? 'bundle' : 'source'})`);
} finally {
  for (const child of children) child.kill('SIGKILL');
  rmSync(home, { recursive: true, force: true });
}
