#!/usr/bin/env bun
// `maw herdr a <target>` (#82), through the actual CLI, against a FAKE herdr: a
// fake `herdr` executable first on PATH (session list / api snapshot) and fake
// herdr SOCKET servers in this process that record every request.
//
// What it proves:
//   - inside herdr, same session: exactly one socket request, `pane.focus` with the
//     resolved pane id; nothing is typed, read or sent to the pane
//   - inside herdr, another session: the pane is focused in ITS session and the
//     switch command is printed (no second client is nested)
//   - outside herdr: focus first, then attach (the attach needs a terminal, so in
//     this test it stops at the "not a terminal" error AFTER focusing)
//   - --print and --dry never focus anything
//   - a running session's exact name keeps the old meaning (attach), a STOPPED
//     session never shadows a live workspace of the same name
//   - ambiguous and unknown targets do nothing and end with runnable commands
//   - herdr refusing the focus is reported with a fix line, not a stack trace
//
// Isolation: PATH is the fake bin dir plus /usr/bin:/bin; HOME, XDG_CONFIG_HOME,
// HERDR_SOCKET_PATH, HERDR_PANE_ID and HERDR_BIN_PATH are all replaced.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'maw-attach-')));
const runtime = process.execPath;
const entry = process.env.MAW_ATTACH_ENTRY || join(root, 'index.mjs');
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.equal(a, b, msg ?? `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); checks++; };

const home = join(tmp, 'home');
const bin = join(tmp, 'bin');
mkdirSync(bin, { recursive: true });
mkdirSync(join(home, 'proj'), { recursive: true });
const sockDefault = join(tmp, 'd.sock');
const sockSide = join(tmp, 's.sock');
const exeLog = join(tmp, 'exe.jsonl');
const pane = (id, agent) => ({ pane_id: id, workspace_id: id.split(':')[0], tab_id: `${id.split(':')[0]}:t1`, cwd: join(home, 'proj'), agent, agent_status: agent ? 'idle' : 'unknown', focused: false });
const space = (id, label) => ({ workspace_id: id, label, number: 1, pane_count: 1, tab_count: 1, agent_status: 'idle', focused: false, active_tab_id: `${id}:t1` });
const snapshots = {
  default: {
    workspaces: [space('wA', 'asker'), space('wB', 'bravo'), space('wC', 'charlie'), space('wG', 'golf'), space('wX', 'xray')],
    panes: [pane('wA:p1', 'claude'), pane('wA:p2', 'claude'), pane('wB:p1', 'claude'), pane('wC:p1', 'codex'), pane('wG:p1', null), pane('wX:p1', 'claude')],
    agents: [],
  },
  side: { workspaces: [space('wS', 'sierra')], panes: [pane('wS:p1', 'claude')], agents: [] },
};
writeFileSync(join(bin, 'herdr'), `#!${runtime}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(exeLog)}, JSON.stringify(args) + '\\n');
const session = args[0] === '--session' ? args[1] : 'default';
const rest = args[0] === '--session' ? args.slice(2) : args;
const verb = rest.slice(0, 2).join(' ');
const snaps = ${JSON.stringify(snapshots)};
if (verb === 'session list') console.log(JSON.stringify({ sessions: [
  { name: 'default', running: true, default: true, socket_path: ${JSON.stringify(sockDefault)} },
  { name: 'side', running: true, socket_path: ${JSON.stringify(sockSide)} },
  { name: 'charlie', running: false },
] }));
else if (verb === 'api snapshot') console.log(JSON.stringify({ id: 1, result: { snapshot: snaps[session] } }));
else { console.error('fake herdr: unexpected', JSON.stringify(args)); process.exit(8); }
`);
chmodSync(join(bin, 'herdr'), 0o700);

/** A fake herdr socket: one request per connection; records everything. */
function fakeSocket(path, { refuse = new Set() } = {}) {
  const state = { requests: [], server: null };
  state.server = createServer(conn => {
    let buf = '';
    conn.on('error', () => {});
    conn.on('data', d => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      state.requests.push(req);
      const reply = obj => conn.write(`${JSON.stringify({ id: req.id, ...obj })}\n`);
      if (req.method === 'pane.focus' && !refuse.has(req.params?.pane_id)) reply({ result: { type: 'ok' } });
      else if (req.method === 'pane.focus') reply({ error: { code: 'pane_not_found', message: `pane ${req.params.pane_id} not found` } });
      else reply({ error: { code: 'unknown_method', message: req.method } });
      conn.end();
    });
  });
  state.listen = () => new Promise(r => state.server.listen(path, r));
  state.reset = () => { state.requests.length = 0; };
  state.close = () => new Promise(r => state.server.close(() => r()));
  return state;
}
const herdrD = fakeSocket(sockDefault, { refuse: new Set(['wX:p1']) });
const herdrS = fakeSocket(sockSide);
await herdrD.listen();
await herdrS.listen();
const resetAll = () => { herdrD.reset(); herdrS.reset(); writeFileSync(exeLog, ''); };
const exeVerbs = () => readFileSync(exeLog, 'utf8').trim().split('\n').filter(Boolean).map(l => { const a = JSON.parse(l); const r = a[0] === '--session' ? a.slice(2) : a; return r.slice(0, 2).join(' '); });

const baseEnv = {
  PATH: `${bin}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), NO_COLOR: '1',
  HERDR_BIN_PATH: join(tmp, 'no-such-herdr'), HERDR_FED_URL: 'http://127.0.0.1:9',
};
const cli = (args, { pane: paneId } = {}) => new Promise(done => {
  // HERDR_SOCKET_PATH ending in /herdr/herdr.sock reads as session "default"; it
  // only NAMES the caller's session — the focus goes to session list's socket_path
  const env = { ...baseEnv, ...(paneId ? { HERDR_ENV: '1', HERDR_PANE_ID: paneId, HERDR_SOCKET_PATH: join(tmp, 'herdr', 'herdr.sock') } : {}) };
  const child = spawn(runtime, [entry, ...args], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  child.on('close', rc => { clearTimeout(timer); done({ rc, out, err }); });
});
const focuses = s => s.requests.filter(r => r.method === 'pane.focus').map(r => r.params.pane_id);

try {
  // 1. inside herdr, same session: one pane.focus, nothing else
  resetAll();
  let r = await cli(['a', 'bravo'], { pane: 'wA:p1' });
  eq(r.rc, 0, r.err);
  eq(JSON.stringify(focuses(herdrD)), '["wB:p1"]');
  eq(herdrD.requests.length, 1, `only pane.focus reached the socket: ${JSON.stringify(herdrD.requests.map(q => q.method))}`);
  eq(herdrS.requests.length, 0);
  ok(r.out.includes('focused bravo (wB:p1 · claude)'), r.out);
  ok(exeVerbs().every(v => v === 'session list' || v === 'api snapshot'), `only reads reached the herdr executable: ${exeVerbs()}`);

  // a plain shell space is brought forward too (its first pane)
  resetAll();
  r = await cli(['a', 'golf'], { pane: 'wA:p1' });
  eq(r.rc, 0, r.err);
  eq(JSON.stringify(focuses(herdrD)), '["wG:p1"]');

  // 2. inside herdr, target in another session: focus there, print the switch
  resetAll();
  r = await cli(['a', 'sierra'], { pane: 'wA:p1' });
  eq(r.rc, 0, r.err);
  eq(JSON.stringify(focuses(herdrS)), '["wS:p1"]');
  eq(herdrD.requests.length, 0);
  ok(r.out.includes("in session 'side'") && r.out.includes('herdr --session side'), r.out);

  // 3. outside herdr: focus first, then the attach (stops at "not a terminal")
  resetAll();
  r = await cli(['a', 'bravo']);
  ok(r.rc !== 0, 'attach without a terminal fails');
  eq(JSON.stringify(focuses(herdrD)), '["wB:p1"]', 'focused before attaching');
  ok(r.err.includes('not a terminal') && r.err.includes('herdr'), r.err);

  // 4. --print and --dry never focus
  resetAll();
  r = await cli(['a', 'bravo', '--print']);
  eq(r.rc, 0, r.err); eq(r.out.trim().split('\n').pop(), 'herdr'); eq(focuses(herdrD).length, 0);
  r = await cli(['a', 'bravo', '--dry'], { pane: 'wA:p1' });
  eq(r.rc, 0, r.err); ok(r.out.includes('would  focus wB:p1 in this herdr session'), r.out); eq(focuses(herdrD).length, 0);
  r = await cli(['a', 'sierra', '--dry'], { pane: 'wA:p1' });
  eq(r.rc, 0, r.err); ok(r.out.includes("then print how to switch"), r.out); eq(focuses(herdrS).length, 0);

  // 5. a running session's exact name keeps the old meaning; a stopped one does not shadow
  resetAll();
  r = await cli(['a', 'side', '--print']);
  eq(r.rc, 0, r.err); eq(r.out.trim(), 'herdr --session side'); eq(focuses(herdrS).length, 0);
  r = await cli(['a', 'charlie', '--dry'], { pane: 'wA:p1' });
  eq(r.rc, 0, r.err); ok(r.out.includes('would  focus wC:p1'), `stopped session 'charlie' must not shadow the charlie workspace: ${r.out}`);

  // 6. ambiguous target: nothing focused, candidates as runnable lines
  resetAll();
  r = await cli(['a', 'asker'], { pane: 'wB:p1' });
  ok(r.rc !== 0, 'ambiguous fails');
  eq(focuses(herdrD).length, 0);
  ok(r.err.includes('maw herdr a') && r.err.includes('wA:p1') && r.err.includes('wA:p2'), r.err);

  // 7. unknown target: falls back to the session match, then a fix line
  resetAll();
  r = await cli(['a', 'zzz-nothing'], { pane: 'wB:p1' });
  ok(r.rc !== 0, 'unknown fails');
  eq(focuses(herdrD).length + focuses(herdrS).length, 0);
  ok(r.err.includes('maw herdr resolve --list'), r.err);

  // 8. herdr refusing the focus: a fix line, no stack trace
  resetAll();
  r = await cli(['a', 'xray'], { pane: 'wA:p1' });
  ok(r.rc !== 0, 'refused focus fails');
  ok(r.err.includes('did not focus wX:p1') && r.err.includes('maw herdr resolve') && !r.err.includes('    at '), r.err);

  console.log(`PASS attach/focus: ${checks} assertions — same-session focus (agent and shell space), other-session focus + switch line, outside focus-then-attach, --print/--dry act on nothing, running vs stopped session names, ambiguity, unknown, refused focus`);
} finally {
  await herdrD.close();
  await herdrS.close();
  rmSync(tmp, { recursive: true, force: true });
}
