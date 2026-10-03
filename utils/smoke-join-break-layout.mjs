#!/usr/bin/env bun
// join / break / layout / whoami and the `self` check (#88), through the actual CLI
// process, against a FAKE herdr. Never a real pane, never a user's session.
//
// The fake keeps workspaces, tabs and panes in a JSON file and behaves the way the
// real `pane move` was measured to: a pane keeps its id inside one workspace and gets
// a new one in another; a tab or workspace left empty closes itself and says so in
// move_result. It logs every call, so the checks below are about the exact argv the
// verbs send — the share in each move, the split target, the order — and about what
// they do NOT send: no move under --dry, none on an ambiguous target, none when a
// label is taken, no prompt without --tell, and never a `pane read` (a history read
// makes an agent redraw its whole screen).
//
// `self`: the fake answers `pane process-info` from the state file. The pane that
// "runs" the CLI reports THIS process's group as its foreground group — the CLI is our
// child, so that group is one of its ancestors' — which is what a real pane reports
// for a command an agent runs. HERDR_PANE_ID can then be set to a stale id.
//
// Isolation: PATH is the fake's dir plus /usr/bin:/bin (ps comes from there and only
// reads); HOME, HERDR_* and MAW_* are replaced.
// Run: bun utils/smoke-join-break-layout.mjs    (MAW_LAYOUT_ENTRY=<bundle> for the bundle)
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmtRatio, planShares } from '../src/cli/mod.planShares.mjs';
import { paneOrder } from '../src/cli/mod.paneOrder.mjs';
import { ancestry } from '../src/cli/mod.ancestry.mjs';
import { verifyCaller } from '../src/cli/mod.verifyCaller.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.env.MAW_LAYOUT_ENTRY || join(root, 'index.mjs');
const runtime = process.execPath;
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'maw-layout-')));
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg ?? `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); checks++; };

try {
  // --- pure: shares and order ------------------------------------------------------------
  const r = steps => steps.map(s => [s.index, s.after, s.split, fmtRatio(s.ratio)]);
  eq(r(planShares(2, 'cols')), [[0, -1, 'right', '0.333'], [1, 0, 'right', '0.5']], 'three even columns: 1/3 then 1/2');
  eq(r(planShares(3, 'cols')), [[0, -1, 'right', '0.25'], [1, 0, 'right', '0.333'], [2, 1, 'right', '0.5']], 'four even columns');
  eq(r(planShares(2, 'rows')), [[0, -1, 'down', '0.333'], [1, 0, 'down', '0.5']], 'rows split down');
  eq(r(planShares(3, 'main', 0.4)), [[0, -1, 'right', '0.4'], [1, 0, 'down', '0.333'], [2, 1, 'down', '0.5']], 'main: the anchor keeps R, the rest stack evenly');
  eq(r(planShares(1, 'main')), [[0, -1, 'right', '0.333']], 'main defaults to a third');
  eq(planShares(0, 'cols'), [], 'nothing to place');
  const rect = (id, x, y) => ({ pane_id: id, rect: { x, y, width: 10, height: 10 } });
  eq(paneOrder([rect('c', 20, 0), rect('a', 0, 0), rect('b', 10, 5), rect('b2', 10, 0)]), ['a', 'b2', 'b', 'c'], 'cols order: x then y');
  eq(paneOrder([rect('lower', 0, 10), rect('right', 10, 0), rect('left', 0, 0)], 'rows'), ['left', 'right', 'lower'], 'rows order: y then x');

  // --- pure: the self check --------------------------------------------------------------
  const me = { pids: new Set([100, 50]), groups: new Set([100, 40]) };
  const procs = { 'w1:p1': { fg: 40, shell: 7 }, 'w2:p3': { fg: 99, shell: 8 }, 'w3:p1': { fg: 5, shell: 50 } };
  const info = id => { if (!procs[id]) throw new Error('pane_not_found'); return procs[id]; };
  const panes = () => Object.keys(procs);
  eq(verifyCaller({ pane: 'w1:p1', session: 'default' }, { me, info, panes }), { pane: 'w1:p1', session: 'default', confirmed: true }, 'the env pane is ours: confirmed');
  eq(verifyCaller({ pane: 'w9:p9', session: 'default' }, { me, info, panes }).pane, 'w1:p1', 'the env pane is gone: the pane whose foreground group is ours');
  eq(verifyCaller({ pane: 'w9:p9', session: 'default' }, { me, info, panes }).stale, 'w9:p9', 'and the stale id is kept for the message');
  eq(verifyCaller({ pane: 'w2:p3' }, { me, info, panes: () => ['w2:p3', 'w3:p1'] }).pane, 'w3:p1', 'a pane whose SHELL is an ancestor is ours too');
  const lost = { pane: 'w2:p3', session: 'default' };
  ok(verifyCaller(lost, { me, info, panes: () => ['w2:p3'] }) === lost, 'no positive match anywhere: the env value, untouched (a detached worker)');
  ok(verifyCaller(lost, { me, info: () => { throw new Error('unsupported'); }, panes }) === lost, 'herdr cannot say: the env value');
  ok(verifyCaller(lost, { me, info, panes: () => { throw new Error('no snapshot'); } }) === lost, 'no snapshot: the env value');
  eq(verifyCaller(null, { me, info, panes }), null, 'no caller stays no caller');
  const mine = ancestry(process.pid);
  ok(mine.pids.has(process.pid) && mine.groups.size >= 1, 'ancestry reads this process from ps');

  // --- the fake herdr ----------------------------------------------------------------------
  const bin = join(tmp, 'bin');
  const home = join(tmp, 'home');
  mkdirSync(bin);
  mkdirSync(join(home, '.config', 'herdr'), { recursive: true });
  const stateFile = join(tmp, 'state.json');
  const log = join(tmp, 'calls.jsonl');
  const fake = join(bin, 'herdr');
  writeFileSync(fake, `#!${runtime}
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
const STATE = ${JSON.stringify(stateFile)};
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const load = () => JSON.parse(readFileSync(STATE, 'utf8'));
const save = st => { writeFileSync(STATE + '.tmp', JSON.stringify(st)); renameSync(STATE + '.tmp', STATE); };
const session = args[0] === '--session' ? args[1] : 'default';
const rest = args[0] === '--session' ? args.slice(2) : args;
const verb = rest.slice(0, 2).join(' ');
const out = v => console.log(JSON.stringify(v));
const die = (code, message) => { console.error(JSON.stringify({ error: { code, message } })); process.exit(1); };
const flag = f => { const i = rest.indexOf(f); return i === -1 ? null : rest[i + 1]; };
const s = load();
if (session !== 'default') die('session_not_found', 'no session ' + session);
const pane = id => s.panes.find(p => p.pane_id === id);
const view = p => ({ pane_id: p.pane_id, tab_id: p.tab_id, workspace_id: p.workspace_id, agent: p.agent ?? null, agent_status: p.agent ? 'idle' : 'unknown', cwd: p.cwd, focused: false });
if (verb === 'session list') out({ sessions: [{ name: 'default', running: true, default: true }] });
else if (verb === 'api snapshot') out({ result: { snapshot: { workspaces: s.workspaces, tabs: s.tabs, panes: s.panes.map(view), agents: s.panes.filter(p => p.agent && p.name).map(p => ({ pane_id: p.pane_id, name: p.name })) } } });
else if (verb === 'pane get') { const p = pane(rest[2]); if (!p) die('pane_not_found', 'pane ' + rest[2] + ' not found'); out({ result: { pane: view(p) } }); }
else if (verb === 'workspace list') out({ result: { workspaces: s.workspaces.map(w => ({ ...w, pane_count: s.panes.filter(p => p.workspace_id === w.workspace_id).length })) } });
else if (verb === 'pane process-info') { const p = pane(flag('--pane')); if (!p) die('pane_not_found', 'pane not found'); out({ result: { process_info: { pane_id: p.pane_id, shell_pid: p.shell ?? 999999, foreground_process_group_id: p.fg ?? 999999, foreground_processes: [] } } }); }
else if (verb === 'pane layout') {
  const p = pane(flag('--pane')); if (!p) die('pane_not_found', 'pane not found');
  const inTab = s.panes.filter(x => x.tab_id === p.tab_id);
  const w = Math.floor(120 / inTab.length);
  out({ result: { layout: { area: { x: 0, y: 0, width: 120, height: 40 }, tab_id: p.tab_id, workspace_id: p.workspace_id,
    panes: inTab.map((x, i) => ({ pane_id: x.pane_id, focused: false, rect: x.rect ?? { x: i * w, y: 0, width: w, height: 40 } })) } } });
}
else if (verb === 'pane move') {
  const p = pane(rest[2]); if (!p) die('pane_not_found', 'pane ' + rest[2] + ' not found');
  const from = { ws: p.workspace_id, tab: p.tab_id };
  let ws, tab;
  if (rest.includes('--new-workspace')) {
    ws = 'w' + (++s.seq); tab = ws + ':t1';
    s.workspaces.push({ workspace_id: ws, label: flag('--label') ?? ws }); s.tabs.push({ tab_id: tab, workspace_id: ws });
  } else if (rest.includes('--new-tab')) {
    ws = flag('--workspace') ?? p.workspace_id;
    if (!s.workspaces.some(w => w.workspace_id === ws)) die('workspace_not_found', ws);
    tab = ws + ':t' + (++s.seq); s.tabs.push({ tab_id: tab, workspace_id: ws });
  } else {
    tab = flag('--tab'); const t = s.tabs.find(x => x.tab_id === tab); if (!t) die('tab_not_found', tab); ws = t.workspace_id;
    const target = pane(flag('--target-pane')); if (!target || target.tab_id !== tab) die('pane_not_found', 'target ' + flag('--target-pane'));
    if (!['right', 'down'].includes(flag('--split'))) die('invalid_split', flag('--split'));
  }
  const id = ws === p.workspace_id ? p.pane_id : ws + ':p' + (++s.seq);
  p.pane_id = id; p.workspace_id = ws; p.tab_id = tab; delete p.rect;
  // put it right after its split target, so the fake layout reads in move order
  const target = flag('--target-pane');
  if (target) { s.panes = s.panes.filter(x => x !== p); s.panes.splice(s.panes.findIndex(x => x.pane_id === target) + 1, 0, p); }
  const mr = { pane: { pane_id: id, tab_id: tab, workspace_id: ws } };
  if (!s.panes.some(x => x.tab_id === from.tab)) s.tabs = s.tabs.filter(t => t.tab_id !== from.tab);
  if (!s.panes.some(x => x.workspace_id === from.ws)) { s.workspaces = s.workspaces.filter(w => w.workspace_id !== from.ws); s.tabs = s.tabs.filter(t => t.workspace_id !== from.ws); mr.closed_workspace_id = from.ws; }
  save(s); out({ result: { move_result: mr } });
}
else if (verb === 'agent prompt') out({ result: { type: 'agent_prompted' } });
else die('unsupported', 'fake herdr: ' + verb);
`);
  chmodSync(fake, 0o755);

  const myGroup = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
  const world = () => ({
    seq: 100,
    workspaces: [{ workspace_id: 'wA', label: 'lead' }, { workspace_id: 'wB', label: 'alpha-oracle' }, { workspace_id: 'wC', label: 'beta-oracle' },
      { workspace_id: 'wD', label: 'gamma-space' }, { workspace_id: 'wE', label: 'beta-twin' }],
    tabs: [{ tab_id: 'wA:t1', workspace_id: 'wA' }, { tab_id: 'wB:t1', workspace_id: 'wB' }, { tab_id: 'wC:t1', workspace_id: 'wC' },
      { tab_id: 'wD:t1', workspace_id: 'wD' }, { tab_id: 'wE:t1', workspace_id: 'wE' }],
    panes: [
      { pane_id: 'wA:p1', workspace_id: 'wA', tab_id: 'wA:t1', agent: 'claude', name: 'lead', cwd: '/code/lead', fg: myGroup },
      { pane_id: 'wB:p1', workspace_id: 'wB', tab_id: 'wB:t1', agent: 'claude', name: 'alpha', cwd: '/code/alpha-oracle' },
      { pane_id: 'wC:p1', workspace_id: 'wC', tab_id: 'wC:t1', agent: 'codex', name: null, cwd: '/code/beta-oracle' },
      { pane_id: 'wD:p1', workspace_id: 'wD', tab_id: 'wD:t1', agent: 'claude', name: 'gamma', cwd: '/code/gamma' },
      { pane_id: 'wD:p2', workspace_id: 'wD', tab_id: 'wD:t1', agent: null, name: null, cwd: '/code/gamma' },
      { pane_id: 'wE:p1', workspace_id: 'wE', tab_id: 'wE:t1', agent: 'claude', name: null, cwd: '/code/beta-twin' },
    ],
  });
  const reset = (mutate = w => w) => { writeFileSync(stateFile, JSON.stringify(mutate(world()))); writeFileSync(log, ''); };
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).map(a => (a[0] === '--session' ? a.slice(2) : a));
  const moves = () => calls().filter(a => a[0] === 'pane' && a[1] === 'move');
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, HERDR_SOCKET_PATH: join(home, '.config', 'herdr', 'herdr.sock'), HERDR_PANE_ID: 'wA:p1' };
  const cli = (args, extra = {}) => {
    const res = spawnSync(runtime, [entry, ...args], { cwd: tmp, encoding: 'utf8', timeout: 60_000, env: { ...env, ...extra } });
    return { rc: res.status, out: res.stdout, err: res.stderr };
  };
  const noHistoryReads = () => ok(!calls().some(a => a[0] === 'pane' && a[1] === 'read'), 'never reads a pane (a history read redraws an agent)');

  // --- join ---------------------------------------------------------------------------------
  reset();
  let res = cli(['join', 'alpha', 'beta-oracle', '--dry']);
  eq(res.rc, 0, res.err);
  eq(moves(), [], '--dry moves nothing');
  ok(res.out.includes("pane move wB:p1 --tab wA:t1 --target-pane wA:p1 --split right --ratio 0.333 --no-focus"), res.out);
  ok(res.out.includes("--target-pane '<wB:p1'\\''s id once it lands>' --split right --ratio 0.5"), `the second split names the first pane's id-to-be: ${res.out}`);

  reset();
  res = cli(['join', 'alpha', 'beta-oracle']);
  eq(res.rc, 0, res.err);
  const m = moves();
  eq(m.length, 2, 'one move per target');
  eq(m[0], ['pane', 'move', 'wB:p1', '--tab', 'wA:t1', '--target-pane', 'wA:p1', '--split', 'right', '--ratio', '0.333', '--no-focus'], 'first: beside me, I keep a third');
  const first = state().panes.find(p => p.name === 'alpha').pane_id;
  ok(first.startsWith('wA:') && first !== 'wB:p1', `a pane from another space gets a new id: ${first}`);
  eq(m[1], ['pane', 'move', 'wC:p1', '--tab', 'wA:t1', '--target-pane', first, '--split', 'right', '--ratio', '0.5', '--no-focus'], 'second: splits the first by its NEW id, half each');
  ok(res.out.includes('its space wB had nothing left and closed'), res.out);
  ok(!calls().some(a => a[0] === 'agent' && a[1] === 'prompt'), 'no prompt without --tell');
  ok(res.out.includes(`maw herdr hey ${first} `), `says how to tell the moved agent: ${res.out}`);
  ok(/layout\s+wA:p1 \d+×40/.test(res.out), `reads the tab back: ${res.out}`);
  ok(!calls().some(a => a[0] === 'pane' && a[1] === 'resize'), 'no resize after the moves');
  noHistoryReads();

  reset();
  res = cli(['here', 'gamma', '--main', '--ratio', '0.4', '--tell']);
  eq(res.rc, 0, res.err);
  eq(moves()[0].slice(-5), ['--split', 'right', '--ratio', '0.4', '--no-focus'], '--main --ratio: I keep 0.4');
  const gamma = state().panes.find(p => p.name === 'gamma').pane_id;
  const prompts = calls().filter(a => a[0] === 'agent' && a[1] === 'prompt');
  eq(prompts.length, 1, '--tell: one line to the moved agent');
  eq(prompts[0][2], gamma, 'sent to its NEW id');
  ok(prompts[0][3].includes('wD:p1'), 'naming the old id too');
  ok(state().workspaces.some(w => w.workspace_id === 'wD'), 'a space that still holds a pane stays open');

  reset();
  res = cli(['join', 'beta']);
  eq(res.rc, 1, `beta-oracle and beta-twin both match: ${res.out}${res.err}`);
  eq(moves(), [], 'an ambiguous target moves nothing');
  ok(res.err.includes('wC:p1') && res.err.includes('wE:p1'), `lists the candidates: ${res.err}`);

  reset(w => { const p = w.panes.find(x => x.pane_id === 'wB:p1'); p.workspace_id = 'wA'; p.tab_id = 'wA:t1'; return w; });
  res = cli(['join', 'alpha', 'self']);
  eq(res.rc, 0, res.err);
  ok(res.out.includes('already in your tab') && res.out.includes('is you'), res.out);
  eq(moves(), [], 'nothing to move when every target is already here');

  reset();
  res = cli(['join', 'alpha', '--rows', '--cols']);
  eq(res.rc, 2, 'two modes is a usage error');
  res = cli(['join', 'alpha', '--ratio', '0.5']);
  eq(res.rc, 2, '--ratio without --main is a usage error');
  ok(res.err.includes('maw herdr join alpha --main --ratio 0.5'), `with the command that works, its own target in it: ${res.err}`);
  res = cli(['join', 'alpha', '--main', '--ratio', '1.5']);
  eq(res.rc, 2, 'a ratio outside 0..1 is a usage error');
  ok(res.err.includes('maw herdr join alpha --main --ratio 0.333'), res.err);
  eq(moves(), [], 'usage errors move nothing');
  res = cli(['join', 'alpha'], { HERDR_PANE_ID: '' });
  eq(res.rc, 1, 'outside a herdr pane');
  ok(res.err.includes('HERDR_PANE_ID is not set') && res.err.trim().endsWith('herdr'), res.err);

  // --- break --------------------------------------------------------------------------------
  reset(w => { const p = w.panes.find(x => x.pane_id === 'wB:p1'); p.workspace_id = 'wA'; p.tab_id = 'wA:t1'; return w; });
  res = cli(['break', 'alpha', '--dry']);
  eq(res.rc, 0, res.err);
  eq(moves(), [], 'break --dry moves nothing');
  res = cli(['back', 'alpha']);
  eq(res.rc, 0, res.err);
  eq(moves(), [['pane', 'move', 'wB:p1', '--new-workspace', '--label', 'alpha', '--no-focus']], 'a new space named after the agent');

  reset(w => { const p = w.panes.find(x => x.pane_id === 'wC:p1'); p.workspace_id = 'wA'; p.tab_id = 'wA:t1'; w.workspaces = w.workspaces.filter(x => x.workspace_id !== 'wC'); return w; });
  res = cli(['break', 'wC:p1']);
  eq(res.rc, 0, res.err);
  eq(moves()[0].slice(-3), ['--label', 'beta-oracle', '--no-focus'], 'an unnamed agent: its repo folder names the space');

  reset(w => { const p = w.panes.find(x => x.pane_id === 'wB:p1'); p.workspace_id = 'wA'; p.tab_id = 'wA:t1'; w.workspaces.push({ workspace_id: 'wZ', label: 'alpha' }); w.tabs.push({ tab_id: 'wZ:t1', workspace_id: 'wZ' }); return w; });
  res = cli(['break', 'alpha']);
  eq(res.rc, 1, 'the label is taken');
  eq(moves(), [], 'a taken label moves nothing');
  ok(res.err.includes('maw herdr break alpha --into wZ') && res.err.includes('maw herdr break alpha --label alpha-2'), res.err);
  res = cli(['break', 'alpha', '--into', 'alpha']);
  eq(res.rc, 0, res.err);
  eq(moves(), [['pane', 'move', 'wB:p1', '--new-tab', '--workspace', 'wZ', '--no-focus']], '--into by label: a new tab there');

  reset();
  res = cli(['break', 'alpha']);
  eq(res.rc, 0, res.err);
  ok(res.out.includes('already alone in its own space'), res.out);
  eq(moves(), [], 'a pane alone in its own space stays');
  res = cli(['break', 'alpha', 'gamma', '--label', 'x']);
  eq(res.rc, 2, '--label with two targets is a usage error');

  // --- layout -------------------------------------------------------------------------------
  // three panes in one tab, stored out of reading order: the rects decide the order
  reset(w => {
    for (const [id, x] of [['wB:p1', 80], ['wC:p1', 40]]) { const p = w.panes.find(q => q.pane_id === id); p.workspace_id = 'wA'; p.tab_id = 'wA:t1'; p.rect = { x, y: 0, width: 40, height: 40 }; }
    w.panes.find(q => q.pane_id === 'wA:p1').rect = { x: 0, y: 0, width: 40, height: 40 };
    w.workspaces = w.workspaces.filter(x => !['wB', 'wC'].includes(x.workspace_id));
    return w;
  });
  res = cli(['layout', 'cols', '--dry']);
  eq(res.rc, 0, res.err);
  eq(moves(), [], 'layout --dry moves nothing');
  res = cli(['layout', 'cols']);
  eq(res.rc, 0, res.err);
  const lm = moves();
  eq(lm.length, 4, 'two out to a scratch tab, two back');
  eq(lm[0], ['pane', 'move', 'wC:p1', '--new-tab', '--workspace', 'wA', '--no-focus'], 'out, in reading order (x=40 before x=80)');
  const scratch = lm[1][lm[1].indexOf('--tab') + 1];
  ok(scratch && scratch !== 'wA:t1' && scratch.startsWith('wA:'), `the scratch tab is the one herdr opened: ${scratch}`);
  eq(lm[2], ['pane', 'move', 'wC:p1', '--tab', 'wA:t1', '--target-pane', 'wA:p1', '--split', 'right', '--ratio', '0.333', '--no-focus'], 'back: the same ids (same workspace), even thirds');
  eq(lm[3], ['pane', 'move', 'wB:p1', '--tab', 'wA:t1', '--target-pane', 'wC:p1', '--split', 'right', '--ratio', '0.5', '--no-focus'], 'back: then halves');
  ok(!state().tabs.some(t => t.tab_id === scratch), 'the scratch tab closed itself');
  eq(state().panes.filter(p => p.tab_id === 'wA:t1').map(p => p.pane_id).sort(), ['wA:p1', 'wB:p1', 'wC:p1'], 'no pane changed id');
  noHistoryReads();
  res = cli(['layout', 'diagonal']);
  eq(res.rc, 2, 'an unknown layout is a usage error');

  // --- whoami and self -------------------------------------------------------------------------
  reset();
  res = cli(['whoami', '--json']);
  eq(res.rc, 0, res.err);
  let who = JSON.parse(res.out);
  eq([who.pane, who.stale, who.confirmed, who.label], ['wA:p1', false, true, 'lead'], 'whoami: the env pane, confirmed by its foreground group');
  res = cli(['whoami', '--json'], { HERDR_PANE_ID: 'wQ:p7' });
  who = JSON.parse(res.out);
  eq([who.pane, who.env, who.stale, who.confirmed], ['wA:p1', 'wQ:p7', true, true], 'a stale HERDR_PANE_ID: the pane really running us');
  res = cli(['whoami'], { HERDR_PANE_ID: 'wQ:p7' });
  ok(res.out.includes('HERDR_PANE_ID=wQ:p7 is STALE'), res.out);
  res = cli(['hey', 'self', 'hello', '--dry'], { HERDR_PANE_ID: 'wQ:p7' });
  eq(res.rc, 0, `hey self with a stale env resolves to the real pane: ${res.out}${res.err}`);
  ok(res.out.includes('agent prompt wA:p1'), res.out);
  reset(w => { w.panes.find(p => p.pane_id === 'wA:p1').fg = 4242; return w; });
  res = cli(['whoami', '--json']);
  who = JSON.parse(res.out);
  eq([who.pane, who.confirmed], ['wA:p1', false], 'no pane runs us in its foreground: the env value, unconfirmed');

  console.log(`ok — join/break/layout/whoami: ${checks} checks`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
