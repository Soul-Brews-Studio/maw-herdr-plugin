#!/usr/bin/env bun
// Lifecycle verbs (#62) — restart, resume, kill, close — through the actual CLI
// process, against a FAKE herdr and FAKE agent processes. Never a real pane.
//
// The fake herdr keeps its state in a JSON file and hosts real child processes as
// "agents": the canonical executable of kind K is a script named K run by this
// runtime — `<runtime> <agents>/claude <args…>` — the shape of an interpreter-hosted
// agent (omp is `bun ~/.bun/bin/omp`), so its argv as ps and /proc see it is exactly
// what the fake reports, and a relaunch has to drop BOTH the runtime and the script.
// The fake records the args it is handed verbatim, with nothing stripped, so an
// off-by-one in that slice shows up in `starts`. An agent ignores the first SIGINT
// (mid-turn) and exits on the second;
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
import { commandOf, execIndex, freeName, isKindProcess, secretValues } from '../src/cli/mod.agentArgv.mjs';
import { spawnWorker } from '../src/cli/mod.lifecycle.mjs';

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
  eq(redactArgs(['-c', 'model_providers.x.api_key=sk-9', '-c', 'model=o3', '--config=auth.token=t1']), ['-c', 'model_providers.x.api_key=<redacted>', '-c', 'model=o3', '--config=auth.token=<redacted>'], 'a -c override whose key is secret is hidden');
  eq(secretValues(['--api-key', 'sk-live-1', '-c', 'x.api_key=sk-2', '--model', 'm']), ['sk-live-1', 'sk-2']);
  eq(withChannel([DEV, 'server:a', 'server:b', '--x'], false), ['--x'], 'every entry of a variadic channel flag goes with it');
  eq(withChannel([DEV, 'server:a', 'server:b'], 'server:b'), [DEV, 'server:a', 'server:b'], 'the second entry counts as loaded');
  eq(dedupeArgs(['--add-dir', 'a', 'b', '--add-dir', 'a', 'b']), ['--add-dir', 'a', 'b'], 'a variadic flag unit is one unit');
  // where the agent's executable sits in a process argv
  eq(execIndex(['claude', '--x'], 'claude'), 0);
  eq(execIndex(['/Users/x/.local/share/claude/versions/2.1.280', '--x'], 'claude', { argv0: 'claude', name: '2.1.280' }), 0, 'native binary under a version file name');
  eq(execIndex(['bun', '/Users/x/.bun/bin/omp', '--yolo'], 'omp'), 1, 'script under its runtime');
  eq(execIndex(['node', '/Users/x/.local/bin/codex', 'resume'], 'codex'), 1);
  eq(execIndex(['node', '/opt/homebrew/bin/omx', '--direct'], 'codex'), -1, 'a wrapper is not the agent');
  eq(execIndex(['pip', 'install', 'x'], 'pi'), -1, 'no substring match for a short kind');
  ok(!isKindProcess({ argv: ['vim', '/Users/x/api.md'], argv0: 'vim', name: 'vim' }, 'pi'), 'vim ~/api.md is not the pi agent');
  ok(isKindProcess({ argv: ['codex'], argv0: 'codex', name: 'codex' }, 'codex'));
  eq(commandOf(['node', '/opt/homebrew/bin/omx', '--direct', '--madmax']), ['/opt/homebrew/bin/omx', '--direct', '--madmax']);
  eq(agentName('01-petkeeper'), 'w-01-petkeeper');
  eq(agentName('nexus-lancedb-turso-14sep-sun2026-extra'), 'nexus-lancedb-turso-14sep-sun202', 'names keep 32 characters, as herdr allows');
  eq(freeName('cold-wt', ['cold-wt', 'cold-wt-2']), 'cold-wt-3');
  eq(freeName('a'.repeat(32), ['a'.repeat(32)]), `${'a'.repeat(30)}-2`, 'a suffix never grows the name past 32');
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
  const WT = ['feat-a', 'pair', 'shelly', 'chan', 'selfie', 'killme', 'closer', 'cold-wt', 'codexy', 'bare-wt', 'wrapped', 'secret', 'nopane', 'ompy', 'ctrl'];
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
  const agentsDir = join(tmp, 'agents');
  mkdirSync(agentsDir);
  const agentScript = join(agentsDir, 'claude');
  const agentSource = `
import { openSync } from 'node:fs';
import { spawn } from 'node:child_process';
let ints = 0;
const bye = () => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} process.exit(0); };
process.on('SIGINT', () => { if (++ints >= 2) bye(); });   // the first ctrl+c only cancels the turn
process.on('SIGTERM', bye);
if (process.env.FAKE_AGENT_RUN) {
  const cmd = JSON.parse(process.env.FAKE_AGENT_RUN);
  const env = { ...process.env }; delete env.FAKE_AGENT_RUN;
  if (env.FAKE_AGENT_NO_PANE) delete env.HERDR_PANE_ID;
  const fd = openSync(process.env.FAKE_AGENT_OUT, 'a');
  spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', fd, fd], env });   // same process group: an agent's own tool call
}
setInterval(() => {}, 1 << 30);
`;
  for (const k of ['claude', 'codex', 'omp', 'omx']) writeFileSync(join(agentsDir, k), agentSource);
  const exe = kind => join(agentsDir, kind);
  const fake = join(bin, 'herdr');
  writeFileSync(fake, `#!${runtime}
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const STATE = ${JSON.stringify(stateFile)};
const AGENTS = ${JSON.stringify(agentsDir)};
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
const host = argv => spawn(RUNTIME, argv, { detached: true, stdio: 'ignore', env: { ...process.env, HERDR_SOCKET_PATH: process.env.HOME + '/.config/herdr/herdr.sock' } });
if (session !== 'default') die('fake herdr: no session ' + session);
if (verb === 'session list') out({ sessions: [{ name: 'default', running: true, default: true }] });
else if (verb === 'agent list') {
  const agents = s.panes.filter(p => live(p.pane_id)).map(p => ({ pane_id: p.pane_id, agent: live(p.pane_id).kind, name: s.names[p.pane_id] ?? null, agent_session: s.agentSession[p.pane_id] ? { agent: live(p.pane_id).kind, kind: 'id', value: s.agentSession[p.pane_id] } : null }));
  out({ id: 'cli:agent:list', result: { agents } });
}
else if (verb === 'api snapshot') {
  const panes = s.panes.map(p => ({ ...p, agent: live(p.pane_id)?.kind ?? null, agent_status: live(p.pane_id) ? 'idle' : 'unknown' }));
  const agents = panes.filter(p => p.agent && s.names[p.pane_id]).map(p => ({ pane_id: p.pane_id, name: s.names[p.pane_id] }));
  out({ id: 1, result: { snapshot: { workspaces: s.workspaces, panes, agents } } });
}
else if (verb === 'pane process-info') {
  const pane = rest[rest.indexOf('--pane') + 1];
  if (process.env.FAKE_PROCESS_INFO === 'empty') { out({ result: {} }); process.exit(0); }
  if (process.env.FAKE_PROCESS_INFO === 'noinfo') { out({ result: { process_info: { pane_id: pane } } }); process.exit(0); }
  if (process.env.FAKE_PROCESS_INFO === 'garbage') { console.log('herdr: socket said something odd'); process.exit(0); }
  const a = live(pane);
  const rt = RUNTIME.split('/').pop();
  const me = a ? { pid: a.pid, argv: a.argv, argv0: rt, name: rt, cmdline: a.argv.join(' ') } : null;
  const w = a && s.wrappers[pane];
  const job = !a && s.jobs[pane];
  const procs = a ? [{ pid: a.pid + 100000, argv: ['bun', 'mcp.ts'], argv0: 'bun', name: 'bun' }, me, ...(w ? [{ pid: w.pid, argv: w.argv, argv0: rt, name: rt }] : [])]
    : job ? [job] : [{ pid: SHELL, argv: ['-zsh'], argv0: '-zsh', name: 'zsh' }];
  const pg = w ? w.pid : a ? a.pid : job ? job.pid : SHELL;
  out({ result: { process_info: { pane_id: pane, shell_pid: SHELL, foreground_process_group_id: pg, foreground_processes: procs } } });
}
else if (verb === 'pane get') out({ result: { pane: { pane_id: rest[2], agent_session: s.agentSession[rest[2]] ? { agent: 'x', kind: 'id', value: s.agentSession[rest[2]] } : null } } });
else if (verb === 'pane send-keys') {
  const [pane, key] = [rest[2], rest[3]];
  const a = live(pane);
  if (key === 'ctrl+c' && a) process.kill(a.pid, 'SIGINT');
  if (key === 'ctrl+c' && s.wrappers[pane] && alive(s.wrappers[pane].pid)) process.kill(s.wrappers[pane].pid, 'SIGINT');
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
  // verbatim: herdr prepends the kind's canonical executable and nothing else
  const extra = dd === -1 ? [] : rest.slice(dd + 1);
  if (!s.panes.some(p => p.pane_id === pane)) die('fake herdr: no pane ' + pane);
  if (live(pane)) die(JSON.stringify({ error: { code: 'agent_pane_busy', message: 'agent target pane ' + pane + ' is not an available shell' } }));
  // herdr's own refusals, in its order
  if (extra.some(x => /[\x00-\x1f\x7f]/.test(x)) && !process.env.FAKE_ALLOW_CTRL) die(JSON.stringify({ error: { code: 'invalid_agent_argument' } }));
  if (Object.entries(s.names).some(([p, n]) => n === name && p !== pane && live(p))) die(JSON.stringify({ error: { code: 'agent_name_taken', message: 'agent name ' + name + ' is already used' } }));
  if (process.env.FAKE_BUSY_FILE) {
    const left = Number(readFileSync(process.env.FAKE_BUSY_FILE, 'utf8'));
    if (left > 0) { writeFileSync(process.env.FAKE_BUSY_FILE, String(left - 1)); die(JSON.stringify({ error: { code: 'agent_pane_busy', message: 'agent target pane ' + pane + ' is not an available shell' } })); }
  }
  // a failure message that quotes the args back, the worst case for a secret
  if (process.env.FAKE_FAIL_START) die('fake herdr: start failed for ' + JSON.stringify(extra));
  const argv = [AGENTS + '/' + kind, ...extra];
  const child = spawn(RUNTIME, argv, {
    detached: true, stdio: 'ignore', env: { ...process.env, HERDR_PANE_ID: pane, HERDR_SOCKET_PATH: process.env.HOME + '/.config/herdr/herdr.sock' },
  });
  child.unref();
  if (process.env.FAKE_WRAPPER) {
    const wargv = [AGENTS + '/omx', ...JSON.parse(process.env.FAKE_WRAPPER)];
    const w = host(wargv); w.unref();
    s.wrappers[pane] = { pid: w.pid, argv: [RUNTIME, ...wargv] };
  } else delete s.wrappers[pane];
  const sid = (() => { const i = extra.indexOf(kind === 'codex' ? 'resume' : '--resume'); return i === -1 ? null : extra[i + 1]; })();
  s.procs[pane] = { pid: child.pid, argv: [RUNTIME, ...argv], kind };
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
    workspaces: [W('wA', 'feat-a'), W('wB', 'pair'), W('wC', 'shelly'), W('wD', 'chan'), W('wE', 'selfie'), W('wF', 'killme'), W('wG', 'closer'),
      W('wH', 'wrapped'), W('wI', 'secret'), W('wJ', 'nopane'), W('wK', 'ompy'), W('wL', 'ctrl')],
    panes: [P('wA:p1', 'feat-a'), P('wB:p1', 'pair'), P('wB:p2', 'pair'), P('wC:p1', 'shelly'), P('wD:p1', 'chan'), P('wE:p1', 'selfie'), P('wF:p1', 'killme'), P('wG:p1', 'closer'), P('wG:p2', 'closer'),
      P('wH:p1', 'wrapped'), P('wI:p1', 'secret'), P('wJ:p1', 'nopane'), P('wK:p1', 'ompy'), P('wL:p1', 'ctrl')],
    procs: {}, names: {}, agentSession: {}, accepted: {}, starts: [], wrappers: {}, jobs: {},
  }));

  mkdirSync(join(home, '.config', 'herdr'), { recursive: true });
  const sock = join(home, '.config', 'herdr', 'herdr.sock');
  const baseEnv = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, HERDR_BIN_PATH: fake, NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1' };
  const fakeHerdr = (a, extra = {}) => execFileSync(fake, a, { env: { ...baseEnv, ...extra }, encoding: 'utf8' });
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const verbOf = a => (a[0] === '--session' ? a.slice(2) : a).slice(0, 2).join(' ');
  const READS = new Set(['session list', 'api snapshot', 'pane process-info', 'pane get', 'pane read', 'agent list']);
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
  start('wH:p1', 'wrap-bot', 'codex', ['--dangerously-bypass-approvals-and-sandbox', 'resume', 'wrap-1'], { FAKE_WRAPPER: JSON.stringify(['--direct', '--madmax']) });
  start('wI:p1', 'secret-bot', 'claude', ['--api-key', 'sk-live-123456', '--resume', 'sec-1']);
  start('wK:p1', 'omp-bot', 'omp', ['--approval-mode=yolo']);
  start('wL:p1', 'ctrl-bot', 'claude', ['--append-system-prompt', 'line one\nline two', '--resume', 'ctrl-1'], { FAKE_ALLOW_CTRL: '1' });
  // herdr's own record of the session moved on (a fork / clear) — restart must use it
  { const s = state(); s.agentSession['wA:p1'] = 'fresh-2'; s.accepted['wD:p1'] = true; writeFileSync(stateFile, JSON.stringify(s)); }
  const pid = pane => state().procs[pane]?.pid;
  const argv = pane => state().procs[pane]?.argv;
  const lastStart = () => state().starts.at(-1);
  for (const p of ['wA:p1', 'wB:p1', 'wB:p2', 'wD:p1', 'wF:p1', 'wG:p1', 'wH:p1', 'wI:p1', 'wK:p1', 'wL:p1']) ok(alive(pid(p)), `fixture agent in ${p} runs`);
  eq(argv('wA:p1').slice(0, 2), [runtime, exe('claude')], 'a fake agent is a script under its runtime, like omp under bun');
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
  eq(lastStart().args, [SKIP, '--channels=plugin:x', '--resume', 'fresh-2'], 'herdr is handed the argv after the runtime AND the script, deduplicated, session pinned to herdr\'s');
  eq(argv('wA:p1'), [runtime, exe('claude'), SKIP, '--channels=plugin:x', '--resume', 'fresh-2']);
  eq(state().names['wA:p1'], 'feat-a-bot', 'it keeps its herdr name');
  const keys = mutationsSince(n).filter(a => verbOf(a) === 'pane send-keys');
  ok(keys.length >= 2 && keys.every(a => a.includes('wA:p1') && a.includes('ctrl+c')), `ctrl+c until it exits, not once: ${JSON.stringify(keys)}`);
  eq(mutationsSince(n).filter(a => verbOf(a) === 'agent start').length, 1);
  ok(r.out.includes('restarted feat-a'), r.out);
  // a second restart keeps it stable: no growth, same name
  r = cli(['restart', wt['feat-a']]);
  eq(r.rc, 0, `restart by path: ${r.err}`);
  eq(lastStart().args, [SKIP, '--channels=plugin:x', '--resume', 'fresh-2'], 'restart twice does not grow the command');
  eq(state().names['wA:p1'], 'feat-a-bot');

  // --- two agents in one worktree -------------------------------------------------------------
  const [left, right] = [pid('wB:p1'), pid('wB:p2')];
  n = calls().length;
  r = cli(['restart', 'pair']);
  eq(r.rc, 1, 'a worktree with two agents is ambiguous by name');
  ok(r.err.includes('maw herdr restart --session default wB:p1') && r.err.includes('maw herdr restart --session default wB:p2'), `lists both panes as commands: ${r.err}`);
  eq(mutationsSince(n), [], 'ambiguity does nothing');
  // focus does not decide which agent a name or path stops
  { const s = state(); s.panes.find(p => p.pane_id === 'wB:p2').focused = true; writeFileSync(stateFile, JSON.stringify(s)); }
  for (const [verb, t] of [['kill', 'pair'], ['restart', wt.pair]]) {
    r = cli([verb, t]);
    eq(r.rc, 1, `${verb} ${t} with one agent focused is still ambiguous: ${r.out}`);
    ok(r.err.includes(`maw herdr ${verb} --session default wB:p1`) && r.err.includes(`maw herdr ${verb} --session default wB:p2`), r.err);
  }
  eq(mutationsSince(n), [], 'a focused pane is not taken as the answer');
  ok(alive(left) && alive(right));
  { const s = state(); s.panes.find(p => p.pane_id === 'wB:p2').focused = false; writeFileSync(stateFile, JSON.stringify(s)); }
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
  eq(lastStart().args, [SKIP, '--resume', 'right-1']);

  // --- restart self from INSIDE the agent: the command is the agent's own child -----------------
  const out = join(tmp, 'selfie.out');
  start('wE:p1', 'selfie-bot', 'claude', ['--resume', 'selfie-1'], { FAKE_AGENT_RUN: JSON.stringify([runtime, entry, 'restart', 'self']), FAKE_AGENT_OUT: out });
  const oldE = pid('wE:p1');
  for (let i = 0; i < 150 && !(pid('wE:p1') !== oldE && alive(pid('wE:p1'))); i++) await sleep(100);
  const said = existsSync(out) ? readFileSync(out, 'utf8') : '';
  ok(said.includes('restart scheduled'), `the agent's own command scheduled it: ${said}`);
  ok(!alive(oldE) && alive(pid('wE:p1')) && pid('wE:p1') !== oldE, 'the worker outlived the agent that ran it and relaunched it');
  eq(lastStart().args, ['--resume', 'selfie-1']);
  eq(state().names['wE:p1'], 'selfie-bot');
  for (let i = 0; i < 50 && !readFileSync(logFile, 'utf8').includes('restart wE:p1: claude is back'); i++) await sleep(100);
  ok(readFileSync(logFile, 'utf8').includes('restart wE:p1: claude is back'), 'the worker logged its result');

  // the same, with HERDR_PANE_ID gone (env -i, a nested multiplexer): only the
  // ancestor check knows the command runs inside the agent it restarts
  const out2 = join(tmp, 'nopane.out');
  start('wJ:p1', 'nopane-bot', 'claude', ['--resume', 'nopane-1'], { FAKE_AGENT_RUN: JSON.stringify([runtime, entry, 'restart', '--session', 'default', 'wJ:p1']), FAKE_AGENT_OUT: out2, FAKE_AGENT_NO_PANE: '1' });
  const oldJ = pid('wJ:p1');
  for (let i = 0; i < 150 && !(pid('wJ:p1') !== oldJ && alive(pid('wJ:p1'))); i++) await sleep(100);
  const said2 = existsSync(out2) ? readFileSync(out2, 'utf8') : '';
  ok(said2.includes('restart scheduled'), `without HERDR_PANE_ID the ancestor check hands off: ${said2}`);
  ok(!alive(oldJ) && alive(pid('wJ:p1')), 'and the worker relaunched it');
  eq(lastStart().args, ['--resume', 'nopane-1']);

  // an interpreter-hosted kind with no known resume syntax: argv after the script, as read
  const oldK = pid('wK:p1');
  r = cli(['restart', 'ompy', '--dry']);
  eq(r.rc, 0, r.err); ok(r.out.includes('runs as a script under') && r.out.includes('not pinned'), r.out);
  r = cli(['restart', 'ompy']);
  eq(r.rc, 0, `restart omp: ${r.err}`);
  eq(lastStart().args, ['--approval-mode=yolo'], 'no script path reaches herdr as a positional');
  ok(!alive(oldK) && alive(pid('wK:p1')));

  // herdr answers agent_pane_busy while it still credits the pane to the old agent
  const busyFile = join(tmp, 'busy');
  writeFileSync(busyFile, '2');
  r = cli(['restart', 'ompy'], { env: { FAKE_BUSY_FILE: busyFile } });
  eq(r.rc, 0, `a transient agent_pane_busy is retried: ${r.err}`); eq(readFileSync(busyFile, 'utf8'), '0');
  writeFileSync(busyFile, '999');
  r = cli(['restart', 'ompy'], { env: { FAKE_BUSY_FILE: busyFile } });
  eq(r.rc, 1, 'a start that never succeeds is reported');
  ok(r.err.includes('was stopped but could not be relaunched') && r.err.trim().endsWith(`maw herdr resume ${wt.ompy}`), `ends with the resume that brings it back: ${r.err}`);

  // a wrapper leading the process group (omx around codex): refused, nothing done
  const oldH = pid('wH:p1');
  n = calls().length;
  r = cli(['restart', 'wrapped']);
  eq(r.rc, 1, 'a wrapped agent is not relaunched as the bare kind');
  ok(r.err.includes('runs under a wrapper') && r.err.includes('maw herdr kill --session default wH:p1') && r.err.includes(`${exe('omx')} --direct --madmax`), r.err);
  eq(mutationsSince(n), [], 'the wrapped agent is left alone'); ok(alive(oldH));

  // an argument with a control character: herdr would refuse the relaunch, so no quit
  const oldL = pid('wL:p1');
  n = calls().length;
  r = cli(['restart', 'ctrl']);
  eq(r.rc, 1, 'an argv herdr cannot take back is refused up front');
  ok(r.err.includes('control character') && r.err.includes('maw herdr kill --session default wL:p1 && maw herdr resume'), r.err);
  eq(mutationsSince(n), [], 'refused before any ctrl+c'); ok(alive(oldL));

  // a secret in the agent's argv never reaches a printed line or the worker log
  r = cli(['restart', 'secret', '--dry']);
  eq(r.rc, 0, r.err); ok(r.out.includes("--api-key '<redacted>'") && !r.out.includes('sk-live-123456'), r.out);
  r = cli(['restart', 'secret'], { env: { FAKE_FAIL_START: '1' } });
  eq(r.rc, 1, 'a failed relaunch fails');
  ok(!`${r.out}${r.err}`.includes('sk-live-123456'), `no secret in the failure: ${r.err}`);
  ok(r.err.trim().endsWith(`maw herdr resume ${wt.secret}`), r.err);
  start('wI:p1', 'secret-bot', 'claude', ['--api-key', 'sk-live-123456', '--resume', 'sec-1']);
  r = cli(['restart', 'self'], { pane: 'wI:p1', env: { FAKE_FAIL_START: '1' } });
  eq(r.rc, 0, r.err); ok(r.out.includes('restart scheduled'));
  for (let i = 0; i < 100 && !readFileSync(logFile, 'utf8').includes('restart wI:p1 FAILED'); i++) await sleep(100);
  ok(readFileSync(logFile, 'utf8').includes('restart wI:p1 FAILED'), 'the worker logged the failure');
  ok(!readFileSync(logFile, 'utf8').includes('sk-live-123456'), 'and no secret with it');

  // a worker that cannot be spawned says so, before anything is stopped
  assert.throws(() => spawnWorker({ verb: 'restart' }, { runtime: join(tmp, 'no-such-bun'), log: join(tmp, 'worker.log') }), /command -v 'no-such-bun'|command -v no-such-bun/); checks++;

  // process-info that says nothing is an error, not "nothing runs"
  for (const mode of ['empty', 'noinfo', 'garbage']) {
    r = cli(['kill', 'wA:p1'], { env: { FAKE_PROCESS_INFO: mode } });
    eq(r.rc, 1, `process-info ${mode}: kill must not report a live agent as gone (${r.out})`);
    ok(r.err.includes('herdr --session default pane process-info --pane wA:p1'), r.err);
    ok(alive(pid('wA:p1')));
  }

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
  eq(r.rc, 0, r.err); eq(lastStart().args.slice(0, 2), [DEV, 'server:fleet'], '--channel adds it back');
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
  r = cli(['kill', 'illm']);
  eq(r.rc, 1, 'kill never acts on a partial name');
  ok(r.err.includes('only part of') && r.err.includes(`maw herdr kill ${wt.killme}`), r.err);
  r = cli(['close', 'loser']);
  eq(r.rc, 1, 'nor does close'); ok(r.err.includes(`maw herdr close ${wt.closer}`), r.err);
  eq(mutationsSince(n), []); ok(alive(oldF));
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
  eq(lastStart().args, ['--resume', 'killme-session-3']);
  r = cli(['resume', 'killme']);
  eq(r.rc, 1, 'resume on a running agent refuses'); ok(r.err.includes('maw herdr restart --session default wF:p1'), r.err);

  // kill a wrapped agent: the wrapper goes too, and the way back names the wrapper
  r = cli(['kill', 'wrapped']);
  eq(r.rc, 0, `kill wrapped: ${r.err}`);
  ok(!alive(oldH) && !alive(state().wrappers['wH:p1'].pid), 'the agent and its wrapper are gone');
  ok(r.out.includes(`${exe('omx')} --direct --madmax`), `names the wrapper command to bring it back: ${r.out}`);

  // one of two agents in a worktree: kill it, then bring it back by its pane
  const leftNow = pid('wB:p1');
  r = cli(['kill', '--session', 'default', 'wB:p2']);
  eq(r.rc, 0, r.err);
  ok(r.out.includes('maw herdr resume --session default wB:p2'), `with a neighbour running, the hint names the pane: ${r.out}`);
  const pdir = join(home, '.claude', 'projects', encodeClaudeDir(wt.pair));
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, 'left-1.jsonl'), 'l'.repeat(3000));     // the live neighbour's, and newest
  r = cli(['resume', '--session', 'default', 'wB:p2', '--dry']);
  eq(r.rc, 1, 'the only transcript is the neighbour\'s own live session');
  ok(r.err.includes('maw herdr peek --session default wB:p1'), r.err);
  writeFileSync(join(pdir, 'right-1.jsonl'), 'r'.repeat(3000));
  await sleep(20);
  writeFileSync(join(pdir, 'left-1.jsonl'), 'l'.repeat(4000));     // the neighbour keeps writing
  r = cli(['resume', wt.pair]);
  eq(r.rc, 1, 'resume by path still refuses while the neighbour runs');
  ok(r.err.includes('maw herdr restart --session default wB:p1') && r.err.includes('maw herdr resume --session default wB:p2'), `and offers the stopped pane: ${r.err}`);
  r = cli(['resume', '--session', 'default', 'wB:p2']);
  eq(r.rc, 0, `resume one of two by pane: ${r.err}`);
  eq([lastStart().pane, lastStart().args], ['wB:p2', ['--resume', 'right-1']], 'its own session, not the neighbour\'s newer live one');
  ok(r.out.includes('skip') && r.out.includes('left-1'), r.out);
  eq(pid('wB:p1'), leftNow, 'the neighbour is untouched'); ok(alive(leftNow));

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
  // codex, from its rollout's session_meta cwd — under a free name: a live agent holds "codexy"
  { const s = state(); s.names['wG:p1'] = 'codexy'; writeFileSync(stateFile, JSON.stringify(s)); }
  r = cli(['resume', 'codexy']);
  eq(r.rc, 0, `resume codex: ${r.err}`);
  const s2 = state().starts.at(-1);
  eq([s2.kind, s2.args, s2.name], ['codex', ['resume', 'codex-session-9'], 'codexy-2'], 'a taken name gets a suffix before anything opens');
  { const s = state(); s.names['wG:p1'] = 'close-bot'; writeFileSync(stateFile, JSON.stringify(s)); }
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
  // a pane running a job that is not an agent (a dev server) also needs --force
  { const s = state(); s.jobs['wC:p1'] = { pid: 4242, argv: ['bun', 'run', 'dev'], argv0: 'bun', name: 'bun' }; writeFileSync(stateFile, JSON.stringify(s)); }
  n = calls().length;
  r = cli(['close', 'shelly']);
  eq(r.rc, 1, 'a space with a running job is refused');
  ok(r.err.includes('running a job') && r.err.includes('pane read wC:p1') && r.err.trim().endsWith(`maw herdr close ${wt.shelly} --force`), r.err);
  eq(mutationsSince(n), []);
  r = cli(['close', 'shelly', '--force']);
  eq(r.rc, 0, `close a space with a job, --force: ${r.err}`);
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
  ok(!readFileSync(logFile, 'utf8').split('\n').some(l => l.includes('FAILED') && !l.includes('wI:p1')), 'no worker failed but the one made to');

  console.log(`lifecycle smoke ok: ${checks} checks (${entry === join(root, 'index.mjs') ? 'source' : 'bundle'})`);
} finally {
  try {
    const s = JSON.parse(readFileSync(stateFile, 'utf8'));
    for (const a of [...Object.values(s.procs), ...Object.values(s.wrappers ?? {})]) { try { process.kill(-a.pid, 'SIGKILL'); } catch {} try { process.kill(a.pid, 'SIGKILL'); } catch {} }
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
}
