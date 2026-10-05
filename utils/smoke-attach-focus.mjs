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
//   - a STOPPED session named exactly beats names that only contain it (#115): it is
//     started after asking, and from inside herdr only the command is printed
//   - ambiguous and unknown targets do nothing and end with runnable commands
//   - herdr refusing the focus is reported with a fix line, not a stack trace
//
// Isolation: PATH is the fake bin dir plus /usr/bin:/bin; HOME, XDG_CONFIG_HOME,
// HERDR_SOCKET_PATH, HERDR_PANE_ID and HERDR_BIN_PATH are all replaced.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { pickCandidate } from '../src/cli/mod.pickCandidate.mjs';
import { promptLine } from '../src/cli/mod.promptLine.mjs';

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
const openedLog = join(tmp, 'opened.json');   // spaces the fake `worktree open` created, merged into later snapshots
const pane = (id, agent) => ({ pane_id: id, workspace_id: id.split(':')[0], tab_id: `${id.split(':')[0]}:t1`, cwd: join(home, 'proj'), agent, agent_status: agent ? 'idle' : 'unknown', focused: false });
const space = (id, label) => ({ workspace_id: id, label, number: 1, pane_count: 1, tab_count: 1, agent_status: 'idle', focused: false, active_tab_id: `${id}:t1` });
// Real (tiny) git repos for the name-grammar and picker cases: alpha-oracle with a
// main checkout and three linked worktrees whose names contain "alpha", one of them
// closed (no herdr space); gamma-oracle beside a plain space labelled "gamma".
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { stdio: 'ignore' });
const mkRepo = name => { const d = join(tmp, name); mkdirSync(d); git(d, 'init', '-q', '-b', 'main'); git(d, 'commit', '-q', '--allow-empty', '-m', 'init'); return d; };
const alpha = mkRepo('alpha-oracle');
const alphaWt = n => { const d = join(tmp, `alpha-${n}`); git(alpha, 'worktree', 'add', '-q', '-b', n, d); return d; };
const [fix1, fix2] = [alphaWt('fix1'), alphaWt('fix2')];
alphaWt('fix3');   // closed: a git worktree with no herdr space
const gamma = mkRepo('gamma-oracle');
const wtSpace = (id, label, dir, repo, root, linked) => ({ ...space(id, label), worktree: { checkout_path: dir, repo_name: repo, repo_root: root, is_linked_worktree: linked } });
const at = (p, dir) => ({ ...p, cwd: dir });
const snapshots = {
  default: {
    workspaces: [space('wA', 'asker'), space('wB', 'bravo'), space('wC', 'charlie'), space('wG', 'golf'), space('wX', 'xray'),
      wtSpace('wM', 'oracle-home', alpha, 'alpha-oracle', alpha, false),
      wtSpace('wF2', 'fix-two', fix2, 'alpha-oracle', alpha, true), wtSpace('wF1', 'fix-one', fix1, 'alpha-oracle', alpha, true),
      wtSpace('wGM', 'gm-home', gamma, 'gamma-oracle', gamma, false), space('wZ', 'gamma')],
    panes: [pane('wA:p1', 'claude'), pane('wA:p2', 'claude'), pane('wB:p1', 'claude'), pane('wC:p1', 'codex'), pane('wG:p1', null), pane('wX:p1', 'claude'),
      at(pane('wM:p1', 'claude'), alpha), at(pane('wF2:p1', null), fix2), at(pane('wF1:p1', 'claude'), fix1),
      at(pane('wGM:p1', 'claude'), gamma), pane('wZ:p1', null)],
    agents: [],
  },
  side: { workspaces: [space('wS', 'sierra')], panes: [pane('wS:p1', 'claude')], agents: [] },
};
writeFileSync(join(bin, 'herdr'), `#!${runtime}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  { name: 'home', running: false },   // #115: no target is named exactly 'home'; two only contain it
] }));
else if (verb === 'api snapshot') {
  const snap = JSON.parse(JSON.stringify(snaps[session]));
  const opened = existsSync(${JSON.stringify(openedLog)}) ? JSON.parse(readFileSync(${JSON.stringify(openedLog)}, 'utf8')) : [];
  if (session === 'default') for (const o of opened) { snap.workspaces.push(o.workspace); snap.panes.push(o.pane); }
  console.log(JSON.stringify({ id: 1, result: { snapshot: snap } }));
}
else if (verb === 'worktree open') {
  // the wake path (resume): open the worktree's space and hand back its root pane
  const path = rest[rest.indexOf('--path') + 1];
  const opened = existsSync(${JSON.stringify(openedLog)}) ? JSON.parse(readFileSync(${JSON.stringify(openedLog)}, 'utf8')) : [];
  const id = 'wW' + (opened.length + 3);
  const workspace = { workspace_id: id, label: path.split('/').pop(), number: 1, pane_count: 1, tab_count: 1, agent_status: 'unknown', focused: false, active_tab_id: id + ':t1',
    worktree: { checkout_path: path, repo_name: 'alpha-oracle', repo_root: rest[rest.indexOf('--cwd') + 1], is_linked_worktree: true } };
  const pane = { pane_id: id + ':p1', workspace_id: id, tab_id: id + ':t1', cwd: path, agent: null, agent_status: 'unknown', focused: false };
  opened.push({ workspace, pane });
  writeFileSync(${JSON.stringify(openedLog)}, JSON.stringify(opened));
  console.log(JSON.stringify({ result: { root_pane: { pane_id: pane.pane_id }, workspace } }));
}
else if (verb === 'agent start') console.log(JSON.stringify({ result: { ok: true } }));
else if (verb === 'agent list') console.log(JSON.stringify({ result: { agents: [] } }));
else if (verb === 'pane process-info') console.log(JSON.stringify({ result: { process_info: { pane_id: rest[3], shell_pid: 1, foreground_process_group_id: 1, foreground_processes: [] } } }));   // read-only: only the exact-verb name test (kill --dry) asks
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
const resetAll = () => { herdrD.reset(); herdrS.reset(); writeFileSync(exeLog, ''); rmSync(openedLog, { force: true }); };
const exeVerbs = () => readFileSync(exeLog, 'utf8').trim().split('\n').filter(Boolean).map(l => { const a = JSON.parse(l); const r = a[0] === '--session' ? a.slice(2) : a; return r.slice(0, 2).join(' '); });

const baseEnv = {
  PATH: `${bin}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), NO_COLOR: '1',
  HERDR_BIN_PATH: join(tmp, 'no-such-herdr'), HERDR_FED_URL: 'http://127.0.0.1:9',
};
const cli = (args, { pane: paneId, pick, wake } = {}) => new Promise(done => {
  // HERDR_SOCKET_PATH ending in /herdr/herdr.sock reads as session "default"; it
  // only NAMES the caller's session — the focus goes to session list's socket_path
  // MAW_HERDR_PICK_ANSWER is the picker's test seam: with no terminal here it is
  // the line "typed" at `pick 1-N`. Unset, the picker needs real TTYs (never in a test).
  const env = { ...baseEnv, ...(pick !== undefined ? { MAW_HERDR_PICK_ANSWER: pick } : {}), ...(wake !== undefined ? { MAW_HERDR_WAKE_ANSWER: wake } : {}), ...(paneId ? { HERDR_ENV: '1', HERDR_PANE_ID: paneId, HERDR_SOCKET_PATH: join(tmp, 'herdr', 'herdr.sock') } : {}) };
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
  // inside herdr too: --print prints the command and focuses nothing, same session or another
  r = await cli(['a', 'bravo', '--print'], { pane: 'wA:p1' });
  eq(r.rc, 0, r.err); eq(r.out.trim(), 'maw herdr a --session default wB:p1'); eq(focuses(herdrD).length, 0, '--print inside herdr focuses nothing');
  r = await cli(['a', 'sierra', '--print'], { pane: 'wA:p1' });
  eq(r.rc, 0, r.err); eq(r.out.trim(), 'maw herdr a --session side wS:p1'); eq(focuses(herdrS).length + focuses(herdrD).length, 0, '--print for another session focuses nothing');

  // 5. a running session's exact name keeps the old meaning; a stopped one does not shadow
  resetAll();
  r = await cli(['a', 'side', '--print']);
  eq(r.rc, 0, r.err); eq(r.out.trim(), 'herdr --session side'); eq(focuses(herdrS).length, 0);
  r = await cli(['a', 'charlie', '--dry'], { pane: 'wA:p1' });
  eq(r.rc, 0, r.err); ok(r.out.includes('would  focus wC:p1'), `stopped session 'charlie' must not shadow the charlie workspace: ${r.out}`);

  // 5b. a STOPPED session named exactly beats names that only contain it (#115):
  //     'home' is inside 'oracle-home' and 'gm-home', and nothing is named exactly 'home'
  resetAll();
  r = await cli(['a', 'home', '--dry'], { pane: 'wA:p1' });
  eq(r.rc, 0, r.err); eq(r.out.trim(), 'session home (stopped) — would start it and attach: herdr --session home');
  r = await cli(['a', 'home', '--print']);
  eq(r.rc, 0, r.err); eq(r.out.trim(), 'herdr --session home');
  r = await cli(['a', 'home'], { pane: 'wA:p1' });
  eq(r.rc, 1, 'inside herdr nothing is started: herdr does not nest');
  ok(r.err.includes('does not start inside its own panes') && r.err.trimEnd().endsWith('\n  herdr --session home'), r.err);
  r = await cli(['a', 'home']);
  eq(r.rc, 1); ok(r.err.includes('may resume its agents') && r.err.includes('maw herdr a home -y   (start it, then attach)'), `non-TTY does not ask: ${r.err}`);
  for (const answer of ['', 'n']) {
    r = await cli(['a', 'home'], { wake: answer });
    eq(r.rc, 1); ok(r.err.includes('Start herdr session "home"? herdr may resume its agents. [y/N] ') && r.err.includes('aborted — nothing was done.'), r.err);
  }
  r = await cli(['a', 'home', '-y']);
  ok(r.rc !== 0 && r.out.includes("starting herdr session 'home': herdr --session home") && r.err.includes('not a terminal'), `-y starts it (stops at "not a terminal" here): ${r.out}${r.err}`);
  r = await cli(['a', 'home'], { wake: 'y' });
  ok(r.rc !== 0 && r.out.includes("starting herdr session 'home'"), r.out + r.err);
  eq(focuses(herdrD).length + focuses(herdrS).length, 0, 'a stopped session focuses no pane');
  ok(exeVerbs().every(v => v === 'session list' || v === 'api snapshot'), `only reads reached the herdr executable: ${exeVerbs()}`);
  r = await cli(['a', 'hom', '--dry'], { pane: 'wA:p1' });
  eq(r.rc, 1); ok(!r.out.includes('would start') && r.err.includes("'hom' matches 2"), `a partial session name never starts it: ${r.out}${r.err}`);

  // 6. ambiguous target: nothing focused, candidates as runnable lines
  resetAll();
  r = await cli(['a', 'asker'], { pane: 'wB:p1' });
  ok(r.rc !== 0, 'ambiguous fails');
  eq(focuses(herdrD).length, 0);
  ok(r.err.includes('maw herdr a') && r.err.includes('wA:p1') && r.err.includes('wA:p2'), r.err);

  // 6b. the picker (interactive ambiguity): same list, numbered; the answer decides
  const plain = (await cli(['a', 'asker'], { pane: 'wB:p1' })).err;
  eq(plain.includes('pick 1-'), false, 'non-TTY ambiguity never prompts');
  ok(plain.startsWith("maw herdr: 'asker' has 2 agent panes and none is focused — nothing was done. Name one:\n  maw herdr a "), plain);
  const nonTty = await cli(['a', 'asker'], { pane: 'wB:p1' });
  eq(nonTty.rc, 1); eq(nonTty.out, ''); eq(nonTty.err, plain, 'non-TTY output is stable');
  for (const flag of ['--dry', '--print']) {
    resetAll();
    r = await cli(['a', 'asker', flag], { pane: 'wB:p1', pick: '2' });
    eq(focuses(herdrD).length, 0, `${flag} never prompts or focuses`);
    ok(!r.err.includes('pick 1-'), r.err);
  }
  resetAll();
  r = await cli(['a', 'asker'], { pane: 'wB:p1', pick: '2' });
  eq(r.rc, 0, r.err);
  ok(/pick 1-2 \(Enter cancels\)/.test(r.err) && /\n  1\) .*wA:p1/.test(r.err) && /\n  2\) .*wA:p2/.test(r.err), r.err);
  eq(JSON.stringify(focuses(herdrD)), '["wA:p2"]', 'pick 2 focuses the second candidate');
  eq(herdrD.requests.length, 1);
  resetAll();
  r = await cli(['a', 'asker'], { pane: 'wB:p1', pick: '1' });
  eq(r.rc, 0, r.err); eq(JSON.stringify(focuses(herdrD)), '["wA:p1"]');
  for (const answer of ['', 'q']) {
    resetAll();
    r = await cli(['a', 'asker'], { pane: 'wB:p1', pick: answer });
    eq(r.rc, 1); eq(focuses(herdrD).length, 0, `${JSON.stringify(answer)} cancels`);
    ok(r.err.includes('nothing was done') && !r.err.includes('is not 1-'), r.err);
  }
  for (const answer of ['9', '0', 'x', '1x']) {
    resetAll();
    r = await cli(['a', 'asker'], { pane: 'wB:p1', pick: answer });
    eq(r.rc, 1); eq(focuses(herdrD).length, 0, `${JSON.stringify(answer)} is invalid`);
    ok(r.err.includes(`'${answer}' is not 1-2 — nothing was done. Name one:`) && r.err.includes('  maw herdr a ') && r.err.includes('wA:p2'), r.err);
  }
  // the pure parser and the one-line reader, without any child process
  const two = [{}, {}];
  eq(JSON.stringify(pickCandidate(two, '2')), '{"index":1}'); eq(JSON.stringify(pickCandidate(two, ' 1 ')), '{"index":0}');
  for (const a of ['', 'q', 'Q', null]) eq(JSON.stringify(pickCandidate(two, a)), '{"cancel":true}');
  for (const a of ['3', '0', '-1', 'x', '1.5']) eq(JSON.stringify(pickCandidate(two, a)), JSON.stringify({ invalid: a }));
  const feed = new PassThrough(); const sink = new PassThrough();
  const asked = promptLine('pick: ', { input: feed, output: sink });
  feed.write('2\nignored\n');
  eq(JSON.stringify(await asked), '{"line":"2"}');
  const closed = new PassThrough(); closed.end();
  eq(JSON.stringify(await promptLine('pick: ', { input: closed, output: sink })), '{"eof":true}');

  // 6c. an oracle is called by its short name: `alpha` is the alpha-oracle main checkout
  //     (tier 'oracle name', before substring, which would match four worktrees)
  resetAll();
  r = await cli(['a', 'alpha', '--dry'], { pane: 'wB:p1' });
  eq(r.rc, 0, r.err); ok(r.out.includes('wM:p1') && !r.out.includes('wF1:p1'), r.out);
  eq(focuses(herdrD).length, 0);
  r = await cli(['resolve', 'alpha'], { pane: 'wB:p1' });
  eq(r.rc, 0, r.err); ok(r.out.includes('oracle name') && r.out.includes('wM:p1'), r.out);
  r = await cli(['kill', 'alpha', '--dry'], { pane: 'wB:p1' });   // an exact verb: same meaning, still nothing done
  eq(r.rc, 0, r.err); ok(r.out.includes('wM:p1'), r.out); eq(focuses(herdrD).length, 0);
  resetAll();
  r = await cli(['a', 'alpha'], { pane: 'wB:p1' });
  eq(r.rc, 0, r.err); eq(JSON.stringify(focuses(herdrD)), '["wM:p1"]');
  // an exact label still beats it: a plain space labelled "gamma" vs gamma-oracle's main checkout
  r = await cli(['resolve', 'gamma'], { pane: 'wB:p1' });
  eq(r.rc, 0, r.err); ok(r.out.includes('exact label') && r.out.includes('wZ:p1') && !r.out.includes('oracle name'), r.out);

  // 6d. the picker offers only candidates that have a pane, running first; closed ones are counted
  resetAll();
  r = await cli(['a', 'fix'], { pane: 'wB:p1', pick: '1' });
  eq(r.rc, 0, r.err);
  ok(/\n  1\) .*alpha-fix1.*\n  2\) .*alpha-fix2/s.test(r.err) && !r.err.includes('  3) ') && !/\n  \d\) [^\n]*alpha-fix3/.test(r.err), r.err);
  ok(r.err.includes('  + 1 closed (no pane) — see all: maw herdr resolve --list'), r.err);
  eq(JSON.stringify(focuses(herdrD)), '["wF1:p1"]', 'running candidate is listed first, so 1 is the running one');
  resetAll();
  r = await cli(['a', 'fix'], { pane: 'wB:p1' });
  ok(r.rc !== 0 && !r.err.includes('pick 1-') && r.err.includes('alpha-fix3'), 'non-TTY list keeps the closed worktree');
  r = await cli(['a', 'fix'], { pane: 'wB:p1', pick: '3' });
  ok(r.rc === 1 && r.err.includes("'3' is not 1-2") && r.err.includes('alpha-fix3'), r.err);

  // 6e. a target with no pane (a closed worktree): ask to wake it (resume), then focus.
  //     Default No; -y skips the question; non-TTY keeps the error and adds the -y line.
  const fix3 = join(tmp, 'alpha-fix3');
  mkdirSync(join(home, '.claude', 'projects', fix3.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true });
  writeFileSync(join(home, '.claude', 'projects', fix3.replace(/[^a-zA-Z0-9]/g, '-'), 'sess-0001.jsonl'), '{"type":"user","pad":"' + 'x'.repeat(4096) + '"}\n');
  const wrote = () => exeVerbs().filter(v => v === 'worktree open' || v === 'agent start');
  resetAll();
  r = await cli(['a', 'alpha-fix3'], { pane: 'wB:p1' });
  ok(r.rc !== 0 && !r.err.includes('Wake'), 'non-TTY does not ask');
  ok(r.err.includes("'alpha-fix3' has no open herdr space, so there is no pane to act on\n  open one: herdr workspace create"), r.err);
  ok(r.err.trimEnd().endsWith('  maw herdr a alpha-fix3 -y   (wake it, then bring it to the front)'), r.err);
  eq(wrote().length, 0); eq(focuses(herdrD).length, 0);
  r = await cli(['a', 'alpha-fix3', '--dry'], { pane: 'wB:p1', wake: 'y' });
  eq(r.rc, 0, r.err); eq(r.out.trim(), "would wake 'alpha-fix3', then focus"); eq(wrote().length, 0); eq(focuses(herdrD).length, 0);
  r = await cli(['a', 'alpha-fix3', '--print'], { pane: 'wB:p1', wake: 'y' });
  ok(r.rc !== 0 && r.err.includes('-y   (wake it'), 'with --print there is no prompt'); eq(wrote().length, 0);
  for (const answer of ['', 'n', 'N', 'nope']) {
    resetAll();
    r = await cli(['a', 'alpha-fix3'], { pane: 'wB:p1', wake: answer });
    eq(r.rc, 1); ok(r.err.includes("○ 'alpha-fix3' has no pane (not running)") && r.err.includes('Wake "alpha-fix3"? [y/N] ') && r.err.includes('aborted — nothing was done.'), r.err);
    eq(wrote().length, 0, `${JSON.stringify(answer)} wakes nothing`); eq(focuses(herdrD).length, 0);
  }
  resetAll();
  r = await cli(['a', 'alpha-fix3'], { pane: 'wB:p1', wake: 'y' });
  eq(r.rc, 0, r.err + r.out);
  eq(JSON.stringify(wrote()), '["worktree open","agent start"]', 'y wakes through resume: open the space, start the agent');
  ok(readFileSync(exeLog, 'utf8').includes('"--resume","sess-0001"'), 'the newest transcript is resumed');
  eq(JSON.stringify(focuses(herdrD)), '["wW3:p1"]', 'then the new pane is focused');
  resetAll();
  r = await cli(['a', 'alpha-fix3', '-y'], { pane: 'wB:p1' });
  eq(r.rc, 0, r.err + r.out); ok(!r.err.includes('Wake'), '-y does not ask');
  eq(JSON.stringify(wrote()), '["worktree open","agent start"]'); eq(JSON.stringify(focuses(herdrD)), '["wW3:p1"]');

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

  console.log(`PASS attach/focus: ${checks} assertions — same-session focus (agent and shell space), other-session focus + switch line, outside focus-then-attach, --print/--dry act on nothing, stopped exact session over partial names (#115), running vs stopped session names, oracle short name (neo = neo-oracle, exact label wins), ambiguity (plain and picker: pick/cancel/invalid, closed not offered), unknown, closed target (wake prompt, -y, --dry), refused focus`);
} finally {
  await herdrD.close();
  await herdrS.close();
  rmSync(tmp, { recursive: true, force: true });
}
