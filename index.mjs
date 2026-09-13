#!/usr/bin/env node
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const HELP = `maw herdr <ls|a|attach|wake> [args]
  ls [--json]                          list herdr sessions with pane and agent counts
  a <session> [--print]                attach to a herdr session (alias: attach)
  wake <oracle> [--engine <kind>] [--prompt <text>] [--attach] [--dry-run]
                                       start an oracle's agent in its own herdr session

Mirrors 'maw ls', 'maw a' and 'maw wake' against the herdr multiplexer.
herdr is a sibling multiplexer: it cannot see tmux panes, and maw cannot see herdr panes.`;

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', cyan: '\x1b[36m', blue: '\x1b[94m', green: '\x1b[32m', red: '\x1b[31m', off: '\x1b[0m' }
  : { dim: '', cyan: '', blue: '', green: '', red: '', off: '' };

// Usage mistakes exit 2 like maw's own verbs; lookup failures exit 1.
class UsageError extends Error {}

function herdr(args, session, timeout = 10_000) {
  const argv = session ? ['--session', session, ...args] : args;
  return execFileSync('herdr', argv, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
}

function herdrJson(args, session, timeout) {
  return JSON.parse(herdr(args, session, timeout));
}

function sessionIndex() {
  const raw = herdrJson(['session', 'list', '--json']);
  return (raw.sessions ?? []).map(s => ({
    session: s.name,
    status: s.running ? 'active' : 'stale',
    ...(s.default ? { default: true } : {}),
  }));
}

async function herdrJsonAsync(args, session) {
  const argv = session ? ['--session', session, ...args] : args;
  const { stdout } = await execFileP('herdr', argv, { encoding: 'utf8', timeout: 10_000 });
  return JSON.parse(stdout);
}

// Every count is an independent herdr call, so run them all at once.
async function countFor(session) {
  const [panes, agents] = await Promise.all([
    herdrJsonAsync(['pane', 'list'], session).then(r => r.result?.panes?.length ?? 0, () => 0),
    herdrJsonAsync(['agent', 'list'], session).then(r => r.result?.agents?.length ?? 0, () => 0),
  ]);
  return { panes, agents };
}

async function listSessions() {
  return Promise.all(sessionIndex().map(async s => {
    const counts = s.status === 'active' ? await countFor(s.session) : { panes: 0, agents: 0 };
    return { session: s.session, status: s.status, ...counts, ...(s.default ? { default: true } : {}) };
  }));
}

// Mirrors maw a's first tiers: exact name, then unique prefix, then unique substring.
function resolveSession(known, target) {
  const names = known.map(s => s.session);
  const exact = known.find(s => s.session === target);
  if (exact) return exact;
  for (const test of [n => n.startsWith(target), n => n.includes(target)]) {
    const hits = known.filter(s => test(s.session));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new Error(`'${target}' matches multiple sessions: ${hits.map(s => s.session).join(', ')}\n  use the full name: maw herdr a <exact-session>`);
    }
  }
  let message = `no herdr session '${target}'. known: ${names.join(', ') || '(none)'}`;
  const nearby = nearbyTmuxSessions(target);
  if (nearby.length) {
    message += '\n  Found nearby (tmux, not herdr):';
    nearby.slice(0, 5).forEach((s, i) => {
      message += `\n  ${i + 1}. tmux ${s.session} (${s.how}, ${s.status})   → maw a ${s.session}`;
    });
  }
  throw new Error(message);
}

// herdr and tmux are blind to each other, so when a name is not a herdr session
// ask maw's own listing whether it lives in tmux instead. Silent on any failure.
function nearbyTmuxSessions(target) {
  let sessions;
  try {
    const raw = execFileSync('maw', ['ls', '--json'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
    sessions = JSON.parse(raw).sessions ?? [];
  } catch {
    return [];
  }
  const bare = n => n.replace(/^\d+-/, '');
  const tiers = [
    ['Exact', n => n === target || bare(n) === target],
    ['Prefix', n => n.startsWith(target) || bare(n).startsWith(target)],
    ['Substring', n => n.includes(target)],
  ];
  for (const [how, test] of tiers) {
    const hits = sessions.filter(s => typeof s.session === 'string' && test(s.session));
    if (hits.length) return hits.map(s => ({ how, session: s.session, status: s.status ?? 'unknown' }));
  }
  return [];
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

async function cmdLs(args) {
  const json = args.includes('--json');
  const rest = args.filter(a => a !== '--json');
  if (rest.length) throw new UsageError(`unknown argument: ${rest[0]}`);
  const sessions = await listSessions();
  if (json) {
    console.log(JSON.stringify({ command: 'ls', mode: 'compact', scope: 'herdr', json: true, sessions }));
    return;
  }
  if (!sessions.length) {
    console.log(`${C.dim}no herdr sessions${C.off}`);
    return;
  }
  for (const s of sessions) {
    const dot = s.status === 'active' ? `${C.green}●${C.off}` : `${C.red}◌${C.off}`;
    const agents = s.agents ? `  ${C.blue}${plural(s.agents, 'agent')}${C.off}` : '';
    console.log(`  ${dot} ${C.cyan}${s.session}${C.off}  ${C.dim}${plural(s.panes, 'pane')}${C.off}${agents}`);
  }
}

function attachArgv(match) {
  return match.default ? ['herdr'] : ['herdr', '--session', match.session];
}

function runAttach(argv) {
  if (!process.stdin.isTTY) {
    throw new Error(`stdin is not a terminal, so herdr's TUI cannot run here.\n  maw hands plugins a terminal only with cli.interactive support (maw-rs #992);\n  until then run it yourself: ${argv.join(' ')}`);
  }
  const run = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' });
  process.exitCode = run.status ?? 1;
}

function cmdAttach(args) {
  const print = args.includes('--print');
  const rest = args.filter(a => a !== '--print');
  const target = rest.shift();
  if (!target) throw new UsageError('attach needs a session name: maw herdr a <session>');
  if (rest.length) throw new UsageError(`unknown argument: ${rest[0]}`);

  const match = resolveSession(sessionIndex(), target);
  if (match.status !== 'active') throw new Error(`herdr session '${match.session}' is stopped; start it before attaching`);

  const argv = attachArgv(match);
  if (match.session !== target) console.log(`  resolved: ${target} → ${match.session}`);
  if (print) {
    console.log(argv.join(' '));
    return;
  }
  runAttach(argv);
}

// --- wake -------------------------------------------------------------------

function readOracleRegistry() {
  const path = process.env.MAW_ORACLES_JSON || join(homedir(), '.maw', 'oracles.json');
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return { oracles: raw.oracles ?? [], ghqRoot: raw.ghq_root };
  } catch {
    return { oracles: [], ghqRoot: undefined };
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function oracleFromPath(path) {
  const repo = basename(path);
  return { name: repo.replace(/-oracle$/, ''), repo, path, org: basename(resolve(path, '..')) };
}

// Accepts a directory, org/repo, or a registry name; registry names are not
// unique across orgs (fleet trap), so a collision must be disambiguated by org/repo.
function resolveOracle(target) {
  if (target.startsWith('/') || target.startsWith('.') || target.startsWith('~')) {
    const path = resolve(target.replace(/^~(?=\/|$)/, homedir()));
    if (!isDir(path)) throw new Error(`wake: '${target}' is not a directory`);
    return oracleFromPath(path);
  }
  const { oracles, ghqRoot } = readOracleRegistry();
  if (target.includes('/')) {
    const [org, repo] = target.split('/');
    const hit = oracles.find(o => o.org === org && o.repo === repo);
    if (hit) return { name: hit.name, repo: hit.repo, path: hit.local_path, org: hit.org };
    const guess = ghqRoot ? join(ghqRoot, 'github.com', org, repo) : null;
    if (guess && isDir(guess)) return { ...oracleFromPath(guess), name: repo.replace(/-oracle$/, '') };
    throw new Error(`wake: '${target}' is not in ~/.maw/oracles.json and has no local checkout`);
  }
  const hits = oracles.filter(o => o.name === target && isDir(o.local_path));
  if (hits.length === 1) return { name: hits[0].name, repo: hits[0].repo, path: hits[0].local_path, org: hits[0].org };
  if (hits.length > 1) {
    throw new Error(`wake: '${target}' names ${hits.length} oracles; pick one by org/repo:\n${hits.map(h => `  maw herdr wake ${h.org}/${h.repo}`).join('\n')}`);
  }
  let located;
  try {
    located = execFileSync('maw', ['locate', target, '--path', '--no-remote'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {}
  if (located && isDir(located)) return oracleFromPath(located);
  throw new Error(`wake: no oracle '${target}' in ~/.maw/oracles.json (try org/repo or a path)`);
}

function agentNameFor(oracle) {
  const name = oracle.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '');
  return (name || 'oracle').slice(0, 32);
}

function waitForSession(session, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (sessionIndex().some(s => s.session === session && s.status === 'active')) return true;
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return false;
}

function cmdWake(args) {
  const opts = { engine: 'claude', prompt: null, attach: false, dryRun: false };
  let target;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--engine' || arg === '--kind') opts.engine = args.shift() ?? '';
    else if (arg === '--prompt') opts.prompt = args.shift() ?? '';
    else if (arg === '--attach' || arg === '-a') opts.attach = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('-')) throw new UsageError(`unknown argument: ${arg}`);
    else if (target === undefined) target = arg;
    else throw new UsageError(`unexpected argument: ${arg}`);
  }
  if (!target) throw new UsageError('wake needs an oracle: maw herdr wake <oracle> [--engine <kind>] [--prompt <text>] [--attach] [--dry-run]');
  if (!opts.engine) throw new UsageError('--engine needs a value (herdr agent kind, e.g. claude, codex, gemini)');

  const oracle = resolveOracle(target);
  const session = oracle.repo;
  const agent = agentNameFor(oracle);
  const plan = [
    `herdr --session ${session} server   # headless, detached (only if not running)`,
    `herdr --session ${session} workspace create --cwd ${oracle.path} --label ${oracle.name} --no-focus`,
    `herdr --session ${session} agent start ${agent} --kind ${opts.engine} --pane <root pane>`,
    ...(opts.prompt !== null ? [`herdr --session ${session} agent prompt ${agent} <prompt>`] : []),
    ...(opts.attach ? [`herdr --session ${session}`] : []),
  ];
  console.log(`  ${C.cyan}${oracle.name}${C.off} ${C.dim}→ ${oracle.org}/${oracle.repo}  herdr session ${session}, agent ${agent} (${opts.engine})${C.off}`);
  if (opts.dryRun) {
    console.log('Plan:');
    for (const line of plan) console.log(`  ${line}`);
    return;
  }

  const running = sessionIndex().some(s => s.session === session && s.status === 'active');
  if (!running) {
    spawn('herdr', ['--session', session, 'server'], { detached: true, stdio: 'ignore' }).unref();
    if (!waitForSession(session)) throw new Error(`wake: herdr session '${session}' did not come up; see ~/.config/herdr/sessions/${session}/herdr-server.log`);
    console.log(`  ${C.green}●${C.off} started herdr session ${session}`);
  }

  const existing = (herdrJson(['agent', 'list'], session).result?.agents ?? []).find(a => a.name === agent);
  if (existing) {
    console.log(`  already awake: ${agent} in ${session} pane ${existing.pane_id} (${existing.agent_status ?? 'unknown'})`);
    if (opts.attach) runAttach(['herdr', '--session', session]);
    else console.log(`  attach with: maw herdr a ${session}`);
    return;
  }

  const created = herdrJson(['workspace', 'create', '--cwd', oracle.path, '--label', oracle.name, '--no-focus'], session);
  const pane = created.result?.root_pane?.pane_id;
  if (!pane) throw new Error(`wake: workspace create returned no root pane: ${JSON.stringify(created).slice(0, 200)}`);

  let started;
  try {
    started = herdr(['agent', 'start', agent, '--kind', opts.engine, '--pane', pane], session, 60_000);
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || '').toString().trim().split('\n')[0];
    throw new Error(`wake: agent start failed in ${session} pane ${pane}: ${detail}`);
  }
  const status = (() => {
    try { return JSON.parse(started).result?.agent?.agent_status ?? JSON.parse(started).result?.agent_status; } catch { return undefined; }
  })();
  console.log(`  ${C.green}●${C.off} woke ${agent} (${opts.engine}) in ${session} pane ${pane}${status ? ` — ${status}` : ''}`);

  if (opts.prompt !== null) {
    herdr(['agent', 'prompt', agent, opts.prompt], session, 30_000);
    console.log(`  prompt sent`);
  }
  if (opts.attach) runAttach(['herdr', '--session', session]);
  else console.log(`  attach with: maw herdr a ${session}`);
}

const args = process.argv.slice(2);
const command = args.shift() || 'help';
try {
  if (['help', '--help', '-h'].includes(command)) console.log(HELP);
  else if (command === 'ls' || command === 'list') await cmdLs(args);
  else if (command === 'a' || command === 'attach') cmdAttach(args);
  else if (command === 'wake') cmdWake(args);
  else throw new UsageError(`unknown command: ${command}`);
} catch (err) {
  console.error(`maw herdr: ${err.message}`);
  process.exitCode = err instanceof UsageError ? 2 : 1;
}
