#!/usr/bin/env bun
// watch + inbox (#63), through the actual CLI and the actual detached watcher
// process, against a FAKE herdr: a fake `herdr` executable first on PATH (for the
// resolver's session list / api snapshot) and fake herdr SOCKET servers in this
// process that speak the events.subscribe wire format and let the test push
// status events one line at a time.
//
// What it proves:
//   - a watch fires exactly once per completion, and never on an intermediate
//     change (working→working, →blocked→working, idle→done, idle→idle, unknown)
//   - --every fires once per completion; a one-shot watch exits after one
//   - a stale watch on a vanished pane is cleaned up (and a replayed close event
//     for a pane that still exists is NOT taken as proof)
//   - inbox shows this pane's notes only, and reading is idempotent (the file is
//     byte-for-byte and mtime unchanged after two reads)
//   - no polling: during a quiet period the watcher sends herdr nothing at all
//
// Isolation: PATH is the fake bin dir plus /usr/bin:/bin (no herdr there); HOME,
// XDG_CONFIG_HOME, HERDR_SOCKET_PATH, HERDR_PANE_ID and HERDR_BIN_PATH are all
// replaced; every watcher this run starts is killed in `finally`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompletionTracker } from '../src/cli/mod.watch.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'maw-watch-')));
const runtime = process.execPath;
const entry = process.env.MAW_WATCH_ENTRY || join(root, 'index.mjs');   // or the bundle
const TICK = 100;
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.equal(a, b, msg ?? `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); checks++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, ms = 8_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// --- 1. the completion rule, pure, with hand-driven timers ----------------------
{
  const timers = () => { const q = []; return { q, set: (fn) => { const t = { fn }; q.push(t); return t; }, clear: t => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); }, flush() { for (const t of q.splice(0)) t.fn(); } }; };
  const drive = (seq, opts = {}) => {
    const fires = [];
    const tm = timers();
    const t = createCompletionTracker({ ...opts, timers: tm, onFinish: f => fires.push(f) });
    for (const step of seq) {
      if (step === 'FLUSH') tm.flush();
      else if (step.startsWith('probe:')) t.probe(step.slice(6));
      else t.event(step);
    }
    tm.flush();
    return { fires, t };
  };
  let r = drive(['probe:idle', 'working', 'working', 'blocked', 'working', 'unknown', 'idle', 'done', 'idle']);
  eq(r.fires.length, 1, 'one completion fires once, whatever intermediate statuses surround it');
  eq(r.fires[0].status, 'idle'); eq(r.fires[0].from, 'working'); eq(r.fires[0].via, 'event');
  r = drive(['probe:idle', 'idle', 'done', 'unknown', 'idle', 'blocked']);
  eq(r.fires.length, 0, 'idle→done, idle→idle, unknown and a still-blocked agent are not completions');
  r = drive(['probe:working', 'done']);
  eq(r.fires.length, 1, 'working at subscribe time, then done: one completion');
  r = drive(['probe:idle', 'working', 'idle', 'working', 'done'], {});
  eq(r.fires.length, 1, 'a one-shot watch fires once and then ignores the next job');
  r = drive(['probe:idle', 'working', 'idle', 'idle', 'working', 'blocked', 'done', 'done'], { every: true });
  eq(r.fires.length, 2, '--every fires once per completion'); eq(r.fires[1].status, 'done');
  r = drive(['probe:idle'], { hint: 'working' });
  eq(r.fires.length, 1, 'busy when watched, finished before the subscription: the probe completes it after the grace');
  eq(r.fires[0].via, 'probe');
  r = drive(['probe:idle', 'idle'], { hint: 'working' });
  eq(r.fires.length, 1, 'the in-flight event and the grace timer fire once between them'); eq(r.fires[0].via, 'event');
  r = drive(['probe:idle', 'working', 'FLUSH', 'idle'], { hint: 'working' });
  eq(r.fires.length, 1, 'a new job inside the grace: one completion when it ends, not two');
  r = drive(['probe:idle'], { hint: 'idle' });
  eq(r.fires.length, 0, 'idle when watched and idle after: nothing has finished');
  r = drive(['probe:working', 'working']);
  r.t.stop(); r.t.event('idle');
  eq(r.fires.length, 0, 'a stopped tracker never fires');
}

// --- 2. fake herdr: executable + sockets ----------------------------------------
const home = join(tmp, 'home');
const bin = join(tmp, 'bin');
mkdirSync(bin, { recursive: true });
mkdirSync(join(home, 'proj'), { recursive: true });
const sockDefault = join(tmp, 'd.sock');
const sockSide = join(tmp, 's.sock');
const exeLog = join(tmp, 'exe.jsonl');
const pane = (id, agent, status = 'idle') => ({ pane_id: id, workspace_id: id.split(':')[0], tab_id: `${id.split(':')[0]}:t1`, cwd: join(home, 'proj'), agent, agent_status: agent ? status : 'unknown', focused: false });
const space = (id, label) => ({ workspace_id: id, label, number: 1, pane_count: 1, tab_count: 1, agent_status: 'idle', focused: false, active_tab_id: `${id}:t1` });
const snapshots = {
  default: {
    workspaces: [space('wA', 'asker'), space('wB', 'bravo'), space('wC', 'charlie'), space('wD', 'delta'), space('wE', 'echo'), space('wF', 'foxtrot'), space('wG', 'golf'), space('wK', 'kilo'), space('wH', 'hotel')],
    panes: [pane('wA:p1', 'claude'), pane('wA:p2', 'claude'), pane('wB:p1', 'claude'), pane('wC:p1', 'codex'), pane('wD:p1', 'claude'), pane('wE:p1', 'claude'), pane('wF:p1', 'claude'), pane('wG:p1', null), pane('wK:p1', 'claude', 'working'), pane('wH:p1', 'claude')],
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
] }));
else if (verb === 'api snapshot') console.log(JSON.stringify({ id: 1, result: { snapshot: snaps[session] } }));
else { console.error('fake herdr: unexpected', JSON.stringify(args)); process.exit(8); }
`);
chmodSync(join(bin, 'herdr'), 0o700);

/** A fake herdr socket server: one request per connection, except events.subscribe. */
function fakeSocket(path, panes) {
  const state = { panes: new Map(Object.entries(panes)), requests: [], streams: new Set(), server: null };
  state.server = createServer(conn => {
    let buf = '';
    conn.on('error', () => {});
    conn.on('data', d => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      state.requests.push(req);
      const reply = obj => conn.write(`${JSON.stringify({ id: req.id, ...obj })}\n`);
      const missing = id => reply({ error: { code: 'pane_not_found', message: `pane ${id} not found` } });
      if (req.method === 'events.subscribe') {
        const status = req.params.subscriptions.find(s => s.type === 'pane.agent_status_changed');
        if (status && !state.panes.has(status.pane_id)) { missing(status.pane_id); conn.end(); return; }
        reply({ result: { type: 'subscription_started' } });
        conn.pane = status?.pane_id ?? null;
        state.streams.add(conn);
        conn.on('close', () => state.streams.delete(conn));
        return;
      }
      if (req.method === 'pane.get') {
        const s = state.panes.get(req.params.pane_id);
        if (s === undefined) missing(req.params.pane_id);
        else reply({ result: { type: 'pane_info', pane: { pane_id: req.params.pane_id, workspace_id: req.params.pane_id.split(':')[0], agent_status: s } } });
      } else if (req.method === 'pane.read') {
        reply({ result: { type: 'pane_read', read: { pane_id: req.params.pane_id, source: req.params.source, format: 'text', text: `building…\nTAIL-OF-${req.params.pane_id}\n`, revision: 1, truncated: false } } });
      } else {
        reply({ error: { code: 'unknown_method', message: req.method } });
      }
      conn.end();
    });
  });
  state.listen = () => new Promise(r => state.server.listen(path, r));
  state.push = (paneId, status) => {
    state.panes.set(paneId, status);
    for (const c of state.streams) if (c.pane === paneId) c.write(`${JSON.stringify({ event: 'pane.agent_status_changed', data: { pane_id: paneId, workspace_id: paneId.split(':')[0], agent_status: status, title: null, state_labels: {} } })}\n`);
  };
  state.event = (event, data) => { for (const c of state.streams) c.write(`${JSON.stringify({ event, data: { type: event, ...data } })}\n`); };
  state.dropStreams = () => { for (const c of state.streams) c.destroy(); state.streams.clear(); };
  state.count = (method, paneId) => state.requests.filter(r => r.method === method && (!paneId || r.params?.pane_id === paneId || r.params?.subscriptions?.some(s => s.pane_id === paneId))).length;
  state.close = () => new Promise(r => { state.dropStreams(); state.server.close(() => r()); });
  return state;
}

const herdrD = fakeSocket(sockDefault, { 'wA:p1': 'idle', 'wA:p2': 'idle', 'wB:p1': 'idle', 'wC:p1': 'idle', 'wD:p1': 'idle', 'wF:p1': 'idle', 'wG:p1': 'unknown', 'wK:p1': 'idle', 'wH:p1': 'idle' });   // wE:p1 is in the snapshot but gone here
const herdrS = fakeSocket(sockSide, { 'wS:p1': 'idle' });
await herdrD.listen();
await herdrS.listen();

const baseEnv = {
  PATH: `${bin}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), NO_COLOR: '1',
  HERDR_BIN_PATH: join(tmp, 'no-such-herdr'), HERDR_FED_URL: 'http://127.0.0.1:9', MAW_HERDR_WATCH_TICK_MS: String(TICK),
};
const stateDir = process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'maw-herdr') : join(home, '.config', 'maw-herdr');
const cli = (args, { pane: paneId, env: extra = {} } = {}) => new Promise(done => {
  const env = { ...baseEnv, ...(paneId ? { HERDR_PANE_ID: paneId, HERDR_SOCKET_PATH: join(tmp, 'herdr', 'herdr.sock') } : {}), ...extra };
  // HERDR_SOCKET_PATH ends in /herdr/herdr.sock, which the resolver reads as session "default"
  const child = spawn(runtime, [entry, ...args], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  child.on('close', rc => { clearTimeout(timer); done({ rc, out, err }); });
});
const records = () => { try { return readdirSync(join(stateDir, 'watches')).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(join(stateDir, 'watches', n), 'utf8'))); } catch { return []; } };
const recordFor = (paneId, session = 'default') => records().find(r => r.target.pane === paneId && r.target.session === session);
const inboxFile = (paneId, session = 'default') => join(stateDir, 'inbox', session, `${paneId.replace(':', '_')}.jsonl`);
const notes = (paneId, session) => { try { return readFileSync(inboxFile(paneId, session), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const started = [];
const startWatch = async (args, paneId = 'wA:p1') => {
  const r = await cli(['watch', ...args], { pane: paneId });
  eq(r.rc, 0, `watch ${args.join(' ')}: ${r.err}${r.out}`);
  const target = args.find(a => !a.startsWith('-'));
  const session = args.includes('--session') ? args[args.indexOf('--session') + 1] : 'default';
  const rec = await waitFor(() => { const x = recordFor(target, session); return x?.pid ? x : null; }, `record for ${target}`);
  started.push(rec.pid);
  return { r, rec };
};

try {
  // --- 3. refusals ---------------------------------------------------------------
  let r = await cli(['watch', 'wB:p1']);
  eq(r.rc, 1, 'watch outside a herdr pane has no inbox to file into');
  ok(r.err.includes('HERDR_PANE_ID is not set') && r.err.includes('maw herdr ls --agents'), r.err);
  r = await cli(['inbox']);
  eq(r.rc, 1); ok(r.err.includes('maw herdr ls --agents'), r.err);
  r = await cli(['watch', 'wG:p1'], { pane: 'wA:p1' });
  eq(r.rc, 1, 'a bare shell never finishes'); ok(r.err.includes('bare shell') && r.err.includes('maw herdr ls --agents'), r.err);
  r = await cli(['watch', 'wE:p1'], { pane: 'wA:p1' });
  eq(r.rc, 1, 'a pane herdr no longer has fails at subscribe time');
  ok(r.err.includes('wE:p1 is gone') && r.err.includes('maw herdr ls --agents'), r.err);
  eq(records().length, 0, 'a failed watch leaves no record');
  r = await cli(['watch', 'wB:p1', '--bogus'], { pane: 'wA:p1' });
  eq(r.rc, 2); ok(r.err.includes('maw herdr watch --list'), r.err);
  r = await cli(['watch', 'wB:p1', '--dry'], { pane: 'wA:p1' });
  eq(r.rc, 0, r.err); ok(r.out.includes('nothing was done') && r.out.includes('bravo'), r.out);
  eq(records().length, 0, '--dry starts nothing');
  eq(herdrD.count('events.subscribe'), 1, 'only the wE:p1 attempt subscribed');

  // --- 4. one-shot: exactly once, never on an intermediate change -----------------
  let { r: w, rec } = await startWatch(['wB:p1']);
  ok(w.out.includes('watching') && w.out.includes('maw herdr inbox') && w.out.includes('maw herdr watch wB:p1 --stop'), w.out);
  eq(rec.watcher.pane, 'wA:p1'); eq(rec.target.pane, 'wB:p1'); eq(rec.every, false);
  const sub = herdrD.requests.filter(q => q.method === 'events.subscribe').at(-1).params.subscriptions;
  ok(sub.some(s => s.type === 'pane.agent_status_changed' && s.pane_id === 'wB:p1') && sub.some(s => s.type === 'pane.closed'), JSON.stringify(sub));
  r = await cli(['watch', 'wB:p1'], { pane: 'wA:p1' });
  eq(r.rc, 0); ok(r.out.includes('already watching'), r.out);
  eq(records().filter(x => x.target.pane === 'wB:p1').length, 1, 'watching twice does not start a second watcher');
  r = await cli(['watch', '--list', '--json'], { pane: 'wA:p1' });
  eq(JSON.parse(r.out).watches.length, 1);
  r = await cli(['watch', '--list', '--json'], { pane: 'wA:p2' });
  eq(JSON.parse(r.out).watches.length, 0, '--list shows what THIS pane watches');
  r = await cli(['watch', '--list', '--all', '--json'], { pane: 'wA:p2' });
  eq(JSON.parse(r.out).watches.length, 1, '--all shows every pane\'s');

  // no polling: a quiet stretch of 5 ticks produces zero requests to herdr
  const before = herdrD.requests.length;
  await sleep(TICK * 5);
  eq(herdrD.requests.length, before, 'a watcher sends herdr nothing while nothing happens — no polling loop');

  for (const s of ['working', 'working', 'blocked', 'working', 'unknown']) herdrD.push('wB:p1', s);
  await sleep(TICK * 3);
  eq(notes('wA:p1').length, 0, 'intermediate changes fire nothing');
  eq(herdrD.count('pane.read', 'wB:p1'), 0);
  for (const s of ['idle', 'done', 'idle']) herdrD.push('wB:p1', s);
  await waitFor(() => notes('wA:p1').length >= 1, 'the completion note');
  await waitFor(() => !alive(rec.pid), 'the one-shot watcher to exit');
  let got = notes('wA:p1');
  eq(got.length, 1, 'working→…→idle→done→idle is ONE completion');
  eq(got[0].kind, 'finished'); eq(got[0].text, 'working → idle'); eq(got[0].from.pane, 'wB:p1'); eq(got[0].to.pane, 'wA:p1');
  ok(got[0].tail.includes('TAIL-OF-wB:p1'), 'the note carries the last lines of the pane');
  eq(herdrD.requests.filter(q => q.method === 'pane.read').at(-1).params.source, 'visible', 'the tail is a visible read, never scrollback');
  eq(herdrD.count('pane.read', 'wB:p1'), 1);
  eq(recordFor('wB:p1'), undefined, 'a finished one-shot watch removes its record');
  herdrD.push('wB:p1', 'working'); herdrD.push('wB:p1', 'idle');
  await sleep(TICK * 3);
  eq(notes('wA:p1').length, 1, 'and never fires again');

  // --- 5. --every, then --stop -----------------------------------------------------
  ({ rec } = await startWatch(['wC:p1', '--every']));
  for (const s of ['working', 'idle', 'idle', 'working', 'blocked', 'done', 'done']) herdrD.push('wC:p1', s);
  await waitFor(() => notes('wA:p1').filter(n => n.from.pane === 'wC:p1').length >= 2, 'two --every notes');
  await sleep(TICK * 3);
  got = notes('wA:p1').filter(n => n.from.pane === 'wC:p1');
  eq(got.length, 2, '--every: one note per completion'); eq(got[1].text, 'working → done', 'blocked mid-task keeps the job it interrupted');
  ok(alive(rec.pid), '--every keeps watching');
  r = await cli(['watch', 'wC:p1', '--stop'], { pane: 'wA:p2' });
  eq(r.rc, 1, 'another pane cannot stop my watch by accident'); ok(r.err.includes('maw herdr watch --list'), r.err);
  r = await cli(['watch', 'wC:p1', '--stop', '--dry'], { pane: 'wA:p1' });
  eq(r.rc, 0); ok(r.out.includes('would stop') && alive(rec.pid), r.out);
  r = await cli(['watch', 'wC:p1', '--stop'], { pane: 'wA:p1' });
  eq(r.rc, 0, r.err); ok(r.out.includes('stopped watching'), r.out);
  await waitFor(() => !alive(rec.pid), '--stop to end the watcher');
  eq(recordFor('wC:p1'), undefined);

  // --- 6. busy when watched, finished before the subscription started --------------
  herdrD.panes.set('wK:p1', 'idle');   // the snapshot (hint) still says working
  ({ rec } = await startWatch(['wK:p1']));
  eq(rec.hint, 'working');
  await waitFor(() => notes('wA:p1').some(n => n.from.pane === 'wK:p1'), 'the probe-completed note');
  await waitFor(() => !alive(rec.pid), 'the watcher to exit');
  got = notes('wA:p1').filter(n => n.from.pane === 'wK:p1');
  eq(got.length, 1); eq(got[0].via, 'probe', 'no event came, so the probe completed it — once');

  // --- 7. a vanished pane cleans itself up; a replayed close does not ----------------
  ({ rec } = await startWatch(['wD:p1']));
  const gets = herdrD.count('pane.get', 'wD:p1');
  herdrD.event('pane_closed', { pane_id: 'wD:p1', workspace_id: 'wD' });     // a replay: wD:p1 still exists
  await waitFor(() => herdrD.count('pane.get', 'wD:p1') > gets, 'the watcher to check the pane');
  await sleep(TICK * 3);
  ok(alive(rec.pid) && recordFor('wD:p1'), 'a close event for a pane that still exists is not proof');
  eq(notes('wA:p1').filter(n => n.from.pane === 'wD:p1').length, 0);
  herdrD.panes.delete('wD:p1');
  herdrD.event('workspace_closed', { workspace_id: 'wD' });
  await waitFor(() => !alive(rec.pid), 'the watcher of a vanished pane to exit');
  eq(recordFor('wD:p1'), undefined, 'the stale watch removed its record');
  got = notes('wA:p1').filter(n => n.from.pane === 'wD:p1');
  eq(got.length, 1); eq(got[0].kind, 'vanished', 'the watcher is told the pane is gone, not that it finished');
  r = await cli(['watch', 'wD:p1'], { pane: 'wA:p1' });
  eq(r.rc, 1, 'and a new watch on it is refused');

  // the WATCHING pane vanishing ends the watch silently (nobody is left to read it)
  ({ rec } = await startWatch(['wH:p1'], 'wA:p2'));
  herdrD.panes.delete('wA:p2');
  herdrD.event('pane_closed', { pane_id: 'wA:p2', workspace_id: 'wA' });
  await waitFor(() => !alive(rec.pid), 'the watcher whose asker vanished to exit');
  eq(recordFor('wH:p1'), undefined); eq(notes('wA:p2').length, 0);
  herdrD.panes.set('wA:p2', 'idle');

  // --- 8. herdr restarting: reconnect and still fire once --------------------------
  ({ rec } = await startWatch(['wF:p1']));
  const subsBefore = herdrD.count('events.subscribe', 'wF:p1');
  herdrD.dropStreams();
  await waitFor(() => herdrD.count('events.subscribe', 'wF:p1') > subsBefore, 'the watcher to resubscribe');
  await waitFor(() => [...herdrD.streams].some(c => c.pane === 'wF:p1'), 'the new stream');
  herdrD.push('wF:p1', 'working'); herdrD.push('wF:p1', 'idle');
  await waitFor(() => !alive(rec.pid), 'the reconnected watcher to finish');
  eq(notes('wA:p1').filter(n => n.from.pane === 'wF:p1' && n.kind === 'finished').length, 1);

  // --- 9. a pane in another session, whose herdr then goes away for good -----------
  ({ rec } = await startWatch(['wS:p1', '--session', 'side']));
  eq(rec.target.session, 'side'); eq(rec.watcher.session, 'default');
  await herdrS.close();
  rmSync(sockSide, { force: true });
  await waitFor(() => !alive(rec.pid), 'the watcher of a dead session to give up', 10_000);
  got = notes('wA:p1').filter(n => n.from.pane === 'wS:p1');
  eq(got.length, 1); eq(got[0].kind, 'vanished'); ok(got[0].text.includes('stopped answering'), got[0].text);
  eq(recordFor('wS:p1', 'side'), undefined);

  // --- 10. a watcher killed outright leaves a record; --list removes it --------------
  const dead = spawn('/bin/sh', ['-c', 'exit 0']);
  await new Promise(res => dead.on('close', res));
  mkdirSync(join(stateDir, 'watches'), { recursive: true });
  writeFileSync(join(stateDir, 'watches', 'deadbeef0000.json'), JSON.stringify({ id: 'deadbeef0000', since: new Date().toISOString(), every: false, pid: dead.pid, target: { session: 'default', pane: 'wB:p1', label: 'bravo' }, watcher: { session: 'default', pane: 'wA:p1' } }));
  r = await cli(['watch', '--list'], { pane: 'wA:p1' });
  eq(r.rc, 0, r.err); ok(r.out.includes('removed 1 stale watch'), r.out);
  eq(records().length, 0, 'the orphaned record is gone');

  // --- 11. inbox: this pane only, reading is idempotent ------------------------------
  const { fileNote } = await import('../src/cli/mod.inbox.mjs');
  fileNote({ session: 'side', pane: 'wA:p1' }, { kind: 'note', text: 'same pane id, other session' }, stateDir);
  fileNote({ session: 'default', pane: 'wA:p2' }, { kind: 'note', text: 'for the other pane' }, stateDir);
  const mine = notes('wA:p1');
  const file = inboxFile('wA:p1');
  const before1 = readFileSync(file); const mtime = statSync(file).mtimeMs;
  const a = await cli(['inbox'], { pane: 'wA:p1' });
  const b = await cli(['inbox'], { pane: 'wA:p1' });
  eq(a.rc, 0, a.err); eq(a.out, b.out, 'reading twice shows the same thing');
  ok(readFileSync(file).equals(before1) && statSync(file).mtimeMs === mtime, 'reading changes nothing on disk');
  ok(!a.out.includes('other session') && !a.out.includes('for the other pane'), `only this pane's notes: ${a.out}`);
  ok(a.out.includes('TAIL-OF-wB:p1') && a.out.includes('maw herdr hey'), a.out);
  const j = JSON.parse((await cli(['inbox', '--json'], { pane: 'wA:p1' })).out);
  eq(j.notes.length, mine.length); ok(j.notes.every(n => n.to.pane === 'wA:p1' && n.to.session === 'default'));
  const newest = mine.at(-1).id;
  ok(a.out.includes(`maw herdr inbox --since ${newest}`), 'the reader is told how to skip what it has seen');
  const since = JSON.parse((await cli(['inbox', '--json', '--since', mine[0].id], { pane: 'wA:p1' })).out);
  eq(since.notes.length, mine.length - 1);
  r = await cli(['inbox', '--since', 'nope'], { pane: 'wA:p1' });
  eq(r.rc, 1); ok(r.err.includes('maw herdr inbox --all'), r.err);
  const other = JSON.parse((await cli(['inbox', '--json'], { pane: 'wA:p2' })).out);
  eq(other.notes.length, 1); eq(other.notes[0].text, 'for the other pane');

  // --- 12. the fake herdr executable only ever saw reads ------------------------------
  const verbs = readFileSync(exeLog, 'utf8').trim().split('\n').map(l => JSON.parse(l)).map(a => (a[0] === '--session' ? a.slice(2) : a).slice(0, 2).join(' '));
  ok(verbs.every(v => v === 'session list' || v === 'api snapshot'), `only reads reached herdr: ${[...new Set(verbs)]}`);
  const methods = new Set(herdrD.requests.map(q => q.method));
  ok([...methods].every(m => ['events.subscribe', 'pane.get', 'pane.read'].includes(m)), `only reads on the socket: ${[...methods]}`);

  console.log(`PASS watch/inbox: ${checks} assertions — completion rule (once per finish, never on working/blocked/unknown/idle→done), --every, --stop, busy-at-watch probe, vanished target (replay is not proof), vanished watcher, herdr reconnect, dead session, orphaned record, inbox per pane and idempotent, zero requests while quiet`);
} finally {
  for (const r of records()) if (r.pid) started.push(r.pid);
  for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  await herdrD.close().catch(() => {});
  if (herdrS.server.listening) await herdrS.close().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
