#!/usr/bin/env bun
// Lifecycle verbs (#62) — restart, resume, kill, close — through the actual CLI
// process, against a FAKE herdr and FAKE agent processes. Never a real pane.
//
// The fake herdr keeps its state in a JSON file and hosts real child processes as
// "agents": each is this runtime running a tiny script under `exec -a <kind>`, so
// its argv (as ps and /proc see it) is exactly what the fake reports, the way a real
// agent's is. An agent ignores the first SIGINT (mid-turn) and exits on the second;
// on exit it SIGKILLs its whole process group, as an agent tearing down its tools
// does — so a `restart self` whose worker were not detached would die with it.
//
// Isolation: PATH is the fake bin dir plus /usr/bin:/bin (no herdr there; ps comes
// from there and only reads), HOME / HERDR_* / MAW_* are replaced, every fake call is
// logged, and every fake agent is killed at the end whatever happens.
// Run: bun utils/smoke-lifecycle.mjs    (MAW_LIFECYCLE_ENTRY=<bundle> for the bundle)
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agentName, dedupeArgs, hasDevChannel, redactArgs, sessionInArgs, withChannel, withSession,
} from '../src/cli/mod.agentArgv.mjs';
import { configuredProviders, encodeClaudeDir } from '../src/cli/mod.resumeLookup.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'maw-lifecycle-')));
const runtime = process.execPath;
const entry = process.env.MAW_LIFECYCLE_ENTRY || join(root, 'index.mjs');
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg ?? `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); checks++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const stateFile = join(tmp, 'herdr-state.json');

try {
  // --- pure argv rules ---------------------------------------------------------------
  eq(dedupeArgs(['--a', '--b', 'x', '--a', '--b', 'x', 'prompt', 'prompt']), ['--a', '--b', 'x', 'prompt', 'prompt'], 'repeats of a flag unit go, positionals stay');
  eq(dedupeArgs(['--channels=p', '--channels=p', '--model', 'a', '--model', 'b']), ['--channels=p', '--model', 'a', '--model', 'b']);
  eq(withSession('claude', ['--x', '--resume', 'OLD', '-c', '--fork-session', '--session-id', 'S', '--resume=Z'], 'NEW').args, ['--x', '--resume', 'NEW']);
  eq(withSession('codex', ['--yolo', 'resume', 'OLD'], 'NEW').args, ['--yolo', 'resume', 'NEW']);
  eq(withSession('codex', ['resume', '--last', '--model', 'm'], 'NEW').args, ['--model', 'm', 'resume', 'NEW']);
  eq(withSession('codex', ['--yolo'], 'NEW').args, ['--yolo', 'resume', 'NEW']);
  eq(withSession('gemini', ['--x'], 'NEW'), null, 'an unknown kind is never rewritten');
  eq(sessionInArgs('claude', ['--resume', 'abc']), 'abc');
  eq(sessionInArgs('claude', ['--resume=abc']), 'abc');
  eq(sessionInArgs('codex', ['resume', 'abc']), 'abc');
  eq(sessionInArgs('claude', ['--x']), null);
  const DEV = '--dangerously-load-development-channels';
  eq(withChannel(['--x'], undefined), ['--x'], 'no flag keeps the channel as it was');
  eq(withChannel(['--x'], 'server:fleet'), [DEV, 'server:fleet', '--x']);
  eq(withChannel([DEV, 'server:fleet', '--x'], 'server:fleet'), [DEV, 'server:fleet', '--x'], 'an already-loaded channel is not doubled');
  eq(withChannel([DEV, 'server:fleet', '--x', `${DEV}=server:b`], false), ['--x']);
  ok(hasDevChannel([`${DEV}=server:x`]));
  eq(redactArgs(['--api-key', 'sk-1', '--token=abc', '--model', 'm', '--auth-file', '/p']), ['--api-key', '<redacted>', '--token=<redacted>', '--model', 'm', '--auth-file', '<redacted>']);
  eq(agentName('01-petkeeper'), 'w-01-petkeeper');
  eq(agentName('Feat One'), 'feat-one');
  eq(configuredProviders({ MAW_HERDR_RESUME_PROVIDERS: 'none' }), []);
  assert.throws(() => configuredProviders({ MAW_HERDR_RESUME_PROVIDERS: 'claude,nope' }), /MAW_HERDR_RESUME_PROVIDERS=claude\b/); checks++;

  // --- real Git fixtures ---------------------------------------------------------------
  const ghqRoot = join(tmp, 'ghq');
  const code = join(ghqRoot, 'github.com', 'org');
  mkdirSync(code, { recursive: true });
  const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (dir, ...a) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...a], { env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const repo = join(code, 'lc-oracle');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'fixture');
  const WT = ['feat-a', 'pair', 'shelly', 'chan', 'selfie', 'killme', 'closer', 'cold-wt', 'codexy', 'bare-wt'];
  const wt = Object.fromEntries(WT.map(n => { const p = join(repo, 'wt', n); git(repo, 'worktree', 'add', '-q', p, '-b', n); return [n, p]; }));

  // transcripts for the resume providers (HOME is the fixture's)
  const home = join(tmp, 'home');
  const claudeDir = join(home, '.claude', 'projects', encodeClaudeDir(wt['cold-wt']));
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'aaaaaaaa-old.jsonl'), 'x'.repeat(2048));
  writeFileSync(join(claudeDir, 'tiny.jsonl'), 'x');                                // below MIN_BYTES: ignored
  await sleep(20);
  writeFileSync(join(claudeDir, 'cold-session-1.jsonl'), 'y'.repeat(4096));          // newest real one: wins
  await sleep(20);
  writeFileSync(join(claudeDir, 'z$(touch pwned).jsonl'), 'p'.repeat(8192));         // newer, but no agent wrote it: skipped
  const codexDir = join(home, '.codex', 'sessions', '2026', '09', '25');
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, 'rollout-2026-09-25T01-00-00-codex-session-9.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session-9', cwd: wt.codexy, source: 'cli' } })}\n${'z'.repeat(2048)}\n`);

  // --- fake agent, fake herdr, fake ghq ---------------------------------------------------
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  const log = join(tmp, 'calls.jsonl');
  const agentScript = join(tmp, 'fake-agent.mjs');
  writeFileSync(agentScript, `
import { openSync } from 'node:fs';
import { spawn } from 'node:child_process';
let ints = 0;
const bye = () => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} process.exit(0); };
process.on('SIGINT', () => { if (++ints >= 2) bye(); });   // the first ctrl+c only cancels the turn
process.on('SIGTERM', bye);
if (process.env.FAKE_AGENT_RUN) {
  const cmd = JSON.parse(process.env.FAKE_AGENT_RUN);
  const env = { ...process.env }; delete env.FAKE_AGENT_RUN;
  const fd = openSync(process.env.FAKE_AGENT_OUT, 'a');
  spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', fd, fd], env });   // same process group: an agent's own tool call
}
setInterval(() => {}, 1 << 30);
`);
  const fake = join(bin, 'herdr');
  writeFileSync(fake, `#!${runtime}
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const STATE = ${JSON.stringify(stateFile)};
const AGENT = ${JSON.stringify(agentScript)};
const RUNTIME = ${JSON.stringify(runtime)};
const DEV = '--dangerously-load-development-channels';
const SHELL = 999999;
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const load = () => JSON.parse(readFileSync(STATE, 'utf8'));
const save = s => { writeFileSync(STATE + '.tmp', JSON.stringify(s)); renameSync(STATE + '.tmp', STATE); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const session = args[0] === '--session' ? args[1] : 'default';
const rest = args[0] === '--session' ? args.slice(2) : args;
const verb = rest.slice(0, 2).join(' ');
const out = v => console.log(JSON.stringify(v));
const die = (m, c = 1) => { console.error(m); process.exit(c); };
let s = load();
const live = p => s.procs[p] && alive(s.procs[p].pid) ? s.procs[p] : null;
if (session !== 'default') die('fake herdr: no session ' + session);
if (verb === 'session list') out({ sessions: [{ name: 'default', running: true, default: true }] });
else if (verb === 'api snapshot') {
  const panes = s.panes.map(p => ({ ...p, agent: live(p.pane_id)?.kind ?? null, agent_status: live(p.pane_id) ? 'idle' : 'unknown' }));
  const agents = panes.filter(p => p.agent && s.names[p.pane_id]).map(p => ({ pane_id: p.pane_id, name: s.names[p.pane_id] }));
  out({ id: 1, result: { snapshot: { workspaces: s.workspaces, panes, agents } } });
}
else if (verb === 'pane process-info') {
  const pane = rest[rest.indexOf('--pane') + 1];
  const a = live(pane);
  const procs = a ? [{ pid: a.pid + 100000, argv: ['bun', 'mcp.ts'], argv0: 'bun', name: 'bun' }, { pid: a.pid, argv: a.argv, argv0: a.argv[0], name: a.kind, cmdline: a.argv.join(' ') }]
    : [{ pid: SHELL, argv: ['-zsh'], argv0: '-zsh', name: 'zsh' }];
  out({ result: { process_info: { pane_id: pane, shell_pid: SHELL, foreground_process_group_id: a ? a.pid : SHELL, foreground_processes: procs } } });
}
else if (verb === 'pane get') out({ result: { pane: { pane_id: rest[2], agent_session: s.agentSession[rest[2]] ? { agent: 'x', kind: 'id', value: s.agentSession[rest[2]] } : null } } });
else if (verb === 'pane send-keys') {
  const [pane, key] = [rest[2], rest[3]];
  const a = live(pane);
  if (key === 'ctrl+c' && a) process.kill(a.pid, 'SIGINT');
  if (key === 'enter') { s.accepted[pane] = true; save(s); }
  out({ ok: true });
}
else if (verb === 'pane read') {
  const a = live(rest[2]);
  process.stdout.write(a && a.argv.includes(DEV) && !s.accepted[rest[2]] ? 'WARNING: Loading development channels\\n> 1. I am using this for local development\\n' : 'fake viewport\\n');
}
else if (verb === 'agent start') {
  const name = rest[2];
  const kind = rest[rest.indexOf('--kind') + 1];
  const pane = rest[rest.indexOf('--pane') + 1];
  const dd = rest.indexOf('--');
  let extra = dd === -1 ? [] : rest.slice(dd + 1);
  // the fake's canonical executable is "<runtime> <fake-agent.mjs>", so argv[1] is
  // always the script; a relaunch that carries it over is the same executable
  if (extra[0] === AGENT) extra = extra.slice(1);
  if (!s.panes.some(p => p.pane_id === pane)) die('fake herdr: no pane ' + pane);
  if (live(pane)) die('fake herdr: pane ' + pane + ' is not at an interactive shell prompt');
  const child = spawn('bash', ['-c', 'exec -a "$FA_KIND" "$0" "$@"', RUNTIME, AGENT, ...extra], {
    detached: true, stdio: 'ignore', env: { ...process.env, FA_KIND: kind, HERDR_PANE_ID: pane, HERDR_SOCKET_PATH: process.env.HOME + '/.config/herdr/herdr.sock' },
  });
  child.unref();
  const sid = (() => { const i = extra.indexOf(kind === 'codex' ? 'resume' : '--resume'); return i === -1 ? null : extra[i + 1]; })();
  s.procs[pane] = { pid: child.pid, argv: [kind, AGENT, ...extra], kind };
  s.names[pane] = name;
  s.agentSession[pane] = sid;
  s.accepted[pane] = false;
  s.starts.push({ pane, name, kind, args: extra });
  save(s);
  // herdr 0.9: an agent blocked at startup (the channel warning) answers at once
  if (extra.includes(DEV) && !process.env.FAKE_NO_WAIT) { console.log(JSON.stringify({ error: { code: 'agent_not_ready', message: 'agent is blocked' } })); process.exit(1); }
  if (process.env.FAKE_BLOCKED_START) { console.error(JSON.stringify({ error: { code: 'agent_not_ready' } })); process.exit(1); }
  out({ result: { agent: { name, pane_id: pane } } });
}
else if (verb === 'workspace create') {
  const cwd = rest[rest.indexOf('--cwd') + 1];
  const label = rest[rest.indexOf('--label') + 1];
  const id = 'wN' + (s.workspaces.length + 1);
  s.workspaces.push({ workspace_id: id, label, number: s.workspaces.length + 1, agent_status: 'unknown', active_tab_id: id + ':t1' });
  s.panes.push({ pane_id: id + ':p1', workspace_id: id, tab_id: id + ':t1', cwd, focused: false });
  save(s);
  out({ result: { workspace: { workspace_id: id }, tab: { tab_id: id + ':t1' }, root_pane: { pane_id: id + ':p1' } } });
}
else if (verb === 'worktree open') {
  const repoRoot = rest[rest.indexOf('--cwd') + 1];
  const path = rest[rest.indexOf('--path') + 1];
  const id = 'wN' + (s.workspaces.length + 1);
  const worktree = { checkout_path: path, repo_name: repoRoot.split('/').pop(), repo_root: repoRoot, is_linked_worktree: path !== repoRoot };
  s.workspaces.push({ workspace_id: id, label: path.split('/').pop(), number: s.workspaces.length + 1, agent_status: 'unknown', active_tab_id: id + ':t1', worktree });
  s.panes.push({ pane_id: id + ':p1', workspace_id: id, tab_id: id + ':t1', cwd: path, focused: false });
  save(s);
  out({ result: { type: 'worktree_opened', already_open: false, workspace: { workspace_id: id }, tab: { tab_id: id + ':t1' }, root_pane: { pane_id: id + ':p1' }, worktree } });
}
else if (verb === 'workspace close') {
  const id = rest[2];
  for (const p of s.panes.filter(p => p.workspace_id === id)) { const a = live(p.pane_id); if (a) process.kill(a.pid, 'SIGKILL'); }
  s.workspaces = s.workspaces.filter(w => w.workspace_id !== id);
  s.panes = s.panes.filter(p => p.workspace_id !== id);
  save(s);
  out({ ok: true });
}
else die('fake herdr: unexpected ' + JSON.stringify(args), 8);
`);
  chmodSync(fake, 0o700);
  writeFileSync(join(bin, 'ghq'), `#!/bin/sh\n[ "$1" = root ] && echo ${JSON.stringify(ghqRoot)}\n`);
  chmodSync(join(bin, 'ghq'), 0o700);

  // --- fixture: spaces, panes, agents -----------------------------------------------------
  const W = (id, name) => ({ workspace_id: id, label: name, number: 1, agent_status: 'idle', focused: false, active_tab_id: `${id}:t1`, worktree: { checkout_path: wt[name], repo_name: 'lc-oracle', repo_root: repo, is_linked_worktree: true } });
  const P = (id, name) => ({ pane_id: id, workspace_id: id.split(':')[0], tab_id: `${id.split(':')[0]}:t1`, cwd: wt[name], focused: false });
  writeFileSync(stateFile, JSON.stringify({
    workspaces: [W('wA', 'feat-a'), W('wB', 'pair'), W('wC', 'shelly'), W('wD', 'chan'), W('wE', 'selfie'), W('wF', 'killme'), W('wG', 'closer')],
    panes: [P('wA:p1', 'feat-a'), P('wB:p1', 'pair'), P('wB:p2', 'pair'), P('wC:p1', 'shelly'), P('wD:p1', 'chan'), P('wE:p1', 'selfie'), P('wF:p1', 'killme'), P('wG:p1', 'closer'), P('wG:p2', 'closer')],
    procs: {}, names: {}, agentSession: {}, accepted: {}, starts: [],
  }));

  mkdirSync(join(home, '.config', 'herdr'), { recursive: true });
  const sock = join(home, '.config', 'herdr', 'herdr.sock');
  const baseEnv = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, HERDR_BIN_PATH: fake, NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1' };
  const fakeHerdr = (a, extra = {}) => execFileSync(fake, a, { env: { ...baseEnv, ...extra }, encoding: 'utf8' });
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const verbOf = a => (a[0] === '--session' ? a.slice(2) : a).slice(0, 2).join(' ');
  const READS = new Set(['session list', 'api snapshot', 'pane process-info', 'pane get', 'pane read']);
  const mutationsSince = n => calls().slice(n).filter(a => !READS.has(verbOf(a)));
  const cli = (args, { pane, cwd = tmp, env = {} } = {}) => {
    const r = spawnSync(runtime, [entry, ...args], { cwd, encoding: 'utf8', timeout: 60_000, env: { ...baseEnv, ...(pane ? { HERDR_PANE_ID: pane, HERDR_SOCKET_PATH: sock } : {}), ...env } });
    return { rc: r.status, out: r.stdout, err: r.stderr };
  };
  const start = (pane, name, kind, args, extra) => fakeHerdr(['agent', 'start', name, '--kind', kind, '--pane', pane, '--', ...args], extra);

  const SKIP = '--dangerously-skip-permissions';
  start('wA:p1', 'feat-a-bot', 'claude', [SKIP, '--channels=plugin:x', SKIP, '--channels=plugin:x', '--resume', 'stale-1']);
  start('wB:p1', 'pair-left', 'claude', [SKIP, '--resume', 'left-1']);
  start('wB:p2', 'pair-right', 'claude', [SKIP, '--resume', 'right-1']);
  start('wD:p1', 'chan-bot', 'claude', [DEV, 'server:fleet', '--resume', 'chan-1'], { FAKE_NO_WAIT: '1' });
  start('wF:p1', 'kill-bot', 'claude', ['--resume', 'kill-1']);
  start('wG:p1', 'close-bot', 'codex', ['resume', 'close-1']);
  // herdr's own record of the session moved on (a fork / clear) — restart must use it
  { const s = state(); s.agentSession['wA:p1'] = 'fresh-2'; s.accepted['wD:p1'] = true; writeFileSync(stateFile, JSON.stringify(s)); }
  const pid = pane => state().procs[pane]?.pid;
  const argv = pane => state().procs[pane]?.argv;
  for (const p of ['wA:p1', 'wB:p1', 'wB:p2', 'wD:p1', 'wF:p1', 'wG:p1']) ok(alive(pid(p)), `fixture agent in ${p} runs`);
  // the fake agent's argv, as the OS reports it, is what the fake says it is
  eq(execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid('wA:p1'))], { encoding: 'utf8' }).trim(), argv('wA:p1').join(' '), 'fake agent argv matches ps');

  // --- restart --dry: reads only ------------------------------------------------------------
  let n = calls().length;
  const oldA = pid('wA:p1');
  let r = cli(['restart', 'wA:p1', '--dry']);
  eq(r.rc, 0, `restart --dry: ${r.err}`);
  ok(r.out.includes('--dry: nothing was done') && r.out.includes(`pid ${oldA}`) && r.out.includes('agent "feat-a-bot"'), r.out);
  ok(r.out.includes('--resume fresh-2') && r.out.includes('herdr agent_session'), `dry shows the pinned session: ${r.out}`);
  ok(r.out.includes(process.platform === 'linux' ? `/proc/${oldA}/cmdline` : `ps -p ${oldA}`), `dry names where argv came from: ${r.out}`);
  eq(mutationsSince(n), [], 'restart --dry mutates nothing');
  ok(alive(oldA));
  r = cli(['restart', 'feat-a', '--dry-run']);
  eq(r.rc, 0, '--dry-run is --dry'); ok(r.out.includes('feat-a-bot'));

  // --- restart by pane id, from outside: foreground ----------------------------------------
  n = calls().length;
  r = cli(['restart', 'wA:p1']);
  eq(r.rc, 0, `restart wA:p1: ${r.err}`);
  ok(!alive(oldA), 'the old agent process is gone');
  ok(alive(pid('wA:p1')) && pid('wA:p1') !== oldA, 'a new agent runs in the same pane');
  eq(argv('wA:p1'), ['claude', agentScript, SKIP, '--channels=plugin:x', '--resume', 'fresh-2'], 'relaunched with its own argv, deduplicated, session pinned to herdr\'s');
  eq(state().names['wA:p1'], 'feat-a-bot', 'it keeps its herdr name');
  const keys = mutationsSince(n).filter(a => verbOf(a) === 'pane send-keys');
  ok(keys.length >= 2 && keys.every(a => a.includes('wA:p1') && a.includes('ctrl+c')), `ctrl+c until it exits, not once: ${JSON.stringify(keys)}`);
  eq(mutationsSince(n).filter(a => verbOf(a) === 'agent start').length, 1);
  ok(r.out.includes('restarted feat-a'), r.out);
  // a second restart keeps it stable: no growth, same name
  r = cli(['restart', wt['feat-a']]);
  eq(r.rc, 0, `restart by path: ${r.err}`);
  eq(argv('wA:p1'), ['claude', agentScript, SKIP, '--channels=plugin:x', '--resume', 'fresh-2'], 'restart twice does not grow the command');
  eq(state().names['wA:p1'], 'feat-a-bot');

  // --- two agents in one worktree -------------------------------------------------------------
  const [left, right] = [pid('wB:p1'), pid('wB:p2')];
  n = calls().length;
  r = cli(['restart', 'pair']);
  eq(r.rc, 1, 'a worktree with two agents is ambiguous by name');
  ok(r.err.includes('maw herdr restart --session default wB:p1') && r.err.includes('maw herdr restart --session default wB:p2'), `lists both panes as commands: ${r.err}`);
  eq(mutationsSince(n), [], 'ambiguity does nothing');
  r = cli(['restart', 'self', '--dry'], { pane: 'wB:p2' });
  eq(r.rc, 0, r.err); ok(r.out.includes('wB:p2') && r.out.includes('pair-right') && !r.out.includes('pair-left'), `self is this pane, not its neighbour: ${r.out}`);
  r = cli(['restart', 'self'], { pane: 'wB:p2' });
  eq(r.rc, 0, `restart self (wB:p2): ${r.err}`);
  ok(r.out.includes('restart scheduled') && r.out.includes('lifecycle.log'), `self is handed to a detached worker: ${r.out}`);
  const logFile = join(home, '.maw', 'herdr', 'lifecycle.log');
  ok(r.out.includes(logFile), 'the scheduled message prints the real log path');
  for (let i = 0; i < 100 && !(pid('wB:p2') !== right && alive(pid('wB:p2'))); i++) await sleep(100);
  ok(!alive(right) && alive(pid('wB:p2')), 'self restarted: new process in wB:p2');
  eq(pid('wB:p1'), left, 'the neighbour in the same worktree is untouched'); ok(alive(left));
  eq(state().names['wB:p2'], 'pair-right');
  eq(argv('wB:p2'), ['claude', agentScript, SKIP, '--resume', 'right-1']);

  // --- restart self from INSIDE the agent: the command is the agent's own child -----------------
  const out = join(tmp, 'selfie.out');
  start('wE:p1', 'selfie-bot', 'claude', ['--resume', 'selfie-1'], { FAKE_AGENT_RUN: JSON.stringify([runtime, entry, 'restart', 'self']), FAKE_AGENT_OUT: out });
  const oldE = pid('wE:p1');
  for (let i = 0; i < 150 && !(pid('wE:p1') !== oldE && alive(pid('wE:p1'))); i++) await sleep(100);
  const said = existsSync(out) ? readFileSync(out, 'utf8') : '';
  ok(said.includes('restart scheduled'), `the agent's own command scheduled it: ${said}`);
  ok(!alive(oldE) && alive(pid('wE:p1')) && pid('wE:p1') !== oldE, 'the worker outlived the agent that ran it and relaunched it');
  eq(argv('wE:p1'), ['claude', agentScript, '--resume', 'selfie-1']);
  eq(state().names['wE:p1'], 'selfie-bot');
  for (let i = 0; i < 50 && !readFileSync(logFile, 'utf8').includes('restart wE:p1: claude is back'); i++) await sleep(100);
  ok(readFileSync(logFile, 'utf8').includes('restart wE:p1: claude is back'), 'the worker logged its result');

  // --- restart on something that is not running names resume ----------------------------------
  r = cli(['restart', 'shelly']);
  eq(r.rc, 1); ok(r.err.includes(`maw herdr resume ${wt.shelly}`), `shell pane → resume: ${r.err}`);
  r = cli(['restart', 'cold-wt']);
  eq(r.rc, 1); ok(r.err.includes('no open herdr space') && r.err.includes(`maw herdr resume ${wt['cold-wt']}`), `closed → resume: ${r.err}`);
  r = cli(['restart', 'wC:p1']);
  eq(r.rc, 1); ok(r.err.includes('maw herdr resume'), r.err);

  // --- channel ----------------------------------------------------------------------------------
  n = calls().length;
  r = cli(['restart', 'chan']);
  eq(r.rc, 0, `restart a channel agent: ${r.err}`);
  ok(argv('wD:p1').includes(DEV) && argv('wD:p1').includes('server:fleet'), 'the channel it had is kept');
  ok(mutationsSince(n).some(a => verbOf(a) === 'pane send-keys' && a.includes('enter')), 'the channel warning was accepted');
  r = cli(['restart', 'chan', '--no-channel']);
  eq(r.rc, 0, r.err); ok(!argv('wD:p1').includes(DEV), '--no-channel drops it');
  r = cli(['restart', 'chan', '--channel', 'server:fleet']);
  eq(r.rc, 0, r.err); eq(argv('wD:p1').slice(2, 4), [DEV, 'server:fleet'], '--channel adds it back');
  r = cli(['restart', 'chan', '--channel']);
  eq(r.rc, 2, 'a bare --channel is a usage error'); ok(r.err.includes('maw herdr restart self --channel server:fleet'), r.err);

  // a start blocked on anything but the channel warning is reported, with where to look
  r = cli(['restart', 'feat-a'], { env: { FAKE_BLOCKED_START: '1' } });
  eq(r.rc, 1, 'a relaunch blocked at startup is not reported as done');
  ok(r.err.includes('agent_not_ready') && r.err.includes('pane read wA:p1'), r.err);
  ok(alive(pid('wA:p1')), 'it did start, it is only waiting on a screen');

  // --- kill -------------------------------------------------------------------------------------
  const oldF = pid('wF:p1');
  n = calls().length;
  r = cli(['kill', 'killme', '--dry']);
  eq(r.rc, 0, r.err); ok(r.out.includes('--dry: nothing was done')); eq(mutationsSince(n), []); ok(alive(oldF));
  r = cli(['kill', 'killme']);
  eq(r.rc, 0, `kill: ${r.err}`);
  ok(!alive(oldF), 'kill stops the agent');
  ok(state().panes.some(p => p.pane_id === 'wF:p1'), 'the pane stays');
  ok(r.out.includes(`maw herdr resume ${wt.killme}`), r.out);
  eq(mutationsSince(n).filter(a => verbOf(a) === 'agent start'), [], 'kill starts nothing');
  r = cli(['kill', 'killme']);
  eq(r.rc, 0, 'killing a stopped agent is a no-op'); ok(r.out.includes('nothing to stop'), r.out);
  r = cli(['restart', 'killme']);
  eq(r.rc, 1, 'restart after kill refuses'); ok(r.err.includes(`maw herdr resume ${wt.killme}`), r.err);

  // --- resume -----------------------------------------------------------------------------------
  // into the open space kill left behind: its shell pane, newest transcript by provider
  const cdir = join(home, '.claude', 'projects', encodeClaudeDir(wt.killme));
  mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, 'killme-session-3.jsonl'), 'k'.repeat(3000));
  r = cli(['resume', 'killme']);
  eq(r.rc, 0, `resume into the open pane: ${r.err}`);
  eq(state().procs['wF:p1'].argv, ['claude', agentScript, '--resume', 'killme-session-3']);
  r = cli(['resume', 'killme']);
  eq(r.rc, 1, 'resume on a running agent refuses'); ok(r.err.includes('maw herdr restart --session default wF:p1'), r.err);

  // a closed worktree: a space is opened, then claude resumes its newest transcript
  n = calls().length;
  r = cli(['resume', wt['cold-wt'], '--dry']);
  eq(r.rc, 0, r.err); ok(r.out.includes('cold-session-1') && r.out.includes(`worktree open --cwd ${repo} --path ${wt['cold-wt']}`), r.out); eq(mutationsSince(n), []);
  r = cli(['resume', 'cold-wt']);
  eq(r.rc, 0, `resume closed: ${r.err}`);
  const made = mutationsSince(n).find(a => verbOf(a) === 'worktree open');
  ok(made && made.includes(wt['cold-wt']) && made.includes(repo), `opened the worktree's space through its repo: ${JSON.stringify(made)}`);
  const s1 = state().starts.at(-1);
  eq([s1.kind, s1.name, s1.args], ['claude', 'cold-wt', ['--resume', 'cold-session-1']], 'the newest transcript with an id-shaped name');
  ok(!existsSync(join(tmp, 'pwned')) && !existsSync(join(home, 'pwned')), 'a transcript name that is a shell command never reaches a shell');
  // codex, from its rollout's session_meta cwd
  r = cli(['resume', 'codexy']);
  eq(r.rc, 0, `resume codex: ${r.err}`);
  const s2 = state().starts.at(-1);
  eq([s2.kind, s2.args], ['codex', ['resume', 'codex-session-9']]);
  // no transcript anywhere / providers off
  r = cli(['resume', 'bare-wt']);
  eq(r.rc, 1); ok(r.err.includes('no transcript') && r.err.includes('ls -la '), r.err);
  r = cli(['resume', 'bare-wt'], { env: { MAW_HERDR_RESUME_PROVIDERS: 'none' } });
  eq(r.rc, 1); ok(r.err.includes(`MAW_HERDR_RESUME_PROVIDERS=claude,codex maw herdr resume ${wt['bare-wt']}`), r.err);
  r = cli(['resume', 'cold-wt'], { env: { MAW_HERDR_CLAUDE_ROOTS: join(tmp, 'nowhere'), MAW_HERDR_RESUME_PROVIDERS: 'claude' } });
  eq(r.rc, 1, 'a resumed worktree now runs: resume refuses before any lookup'); ok(r.err.includes('already runs'), r.err);
  r = cli(['restart', 'cold-wt', '--dry']);
  eq(r.rc, 0, `the resumed worktree resolves as one open worktree and restarts: ${r.err}`); ok(r.out.includes('--resume cold-session-1'), r.out);

  // --- close ------------------------------------------------------------------------------------
  const oldG = pid('wG:p1');
  n = calls().length;
  r = cli(['close', 'closer']);
  eq(r.rc, 1, 'a space with a live agent is refused');
  ok(r.err.includes('maw herdr kill --session default wG:p1') && r.err.includes(`maw herdr close ${wt.closer} --force`), r.err);
  eq(mutationsSince(n), []); ok(alive(oldG));
  r = cli(['close', 'closer', '--force', '--dry']);
  eq(r.rc, 0, r.err); ok(r.out.includes('workspace close wG')); eq(mutationsSince(n), []);
  r = cli(['close', 'closer', '--force']);
  eq(r.rc, 0, `close --force: ${r.err}`);
  ok(!state().workspaces.some(w => w.workspace_id === 'wG'), 'the space is closed');
  ok(existsSync(wt.closer), 'the worktree stays on disk');
  r = cli(['close', 'shelly']);
  eq(r.rc, 0, `close a shell-only space: ${r.err}`);
  r = cli(['close', 'shelly']);
  eq(r.rc, 0, 'closing a closed worktree is a no-op'); ok(r.out.includes('nothing to close'), r.out);

  // --- usage ------------------------------------------------------------------------------------
  r = cli(['kill', 'a', 'b']);
  eq(r.rc, 2); ok(r.err.includes('maw herdr kill a') && r.err.includes('maw herdr kill b'), r.err);
  r = cli(['close', '--bogus']);
  eq(r.rc, 2); ok(r.err.includes('maw herdr close --help'), r.err);
  r = cli(['restart', '--force']);
  eq(r.rc, 2, '--force belongs to close only');
  for (const v of ['restart', 'resume', 'kill', 'close']) { r = cli([v, '--help']); eq(r.rc, 0); ok(r.out.startsWith(`maw herdr ${v}`), r.out); }
  r = cli(['restart']);
  eq(r.rc, 1, 'no target outside a pane is self, which needs HERDR_PANE_ID'); ok(r.err.includes('maw herdr resolve'), r.err);

  // --- never outside the fake -------------------------------------------------------------------
  const unexpected = calls().filter(a => ![...READS, 'pane send-keys', 'agent start', 'worktree open', 'workspace close'].includes(verbOf(a)) && a.length);
  eq(unexpected, [], 'only the verbs these commands are meant to use reached herdr');
  ok(!readFileSync(logFile, 'utf8').includes('FAILED'), 'no worker failed');

  console.log(`lifecycle smoke ok: ${checks} checks (${entry === join(root, 'index.mjs') ? 'source' : 'bundle'})`);
} finally {
  try {
    const s = JSON.parse(readFileSync(stateFile, 'utf8'));
    for (const a of Object.values(s.procs)) { try { process.kill(-a.pid, 'SIGKILL'); } catch {} try { process.kill(a.pid, 'SIGKILL'); } catch {} }
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
}
