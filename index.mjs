#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';

const HELP = `maw herdr <ls|a|attach> [args]
  ls [--json]        list herdr sessions with pane and agent counts
  a <session> [--print]   attach to a herdr session (alias: attach)

Mirrors 'maw ls' and 'maw a' against the herdr multiplexer.
herdr is a sibling multiplexer: it cannot see tmux panes, and maw cannot see herdr panes.`;

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', cyan: '\x1b[36m', blue: '\x1b[94m', green: '\x1b[32m', red: '\x1b[31m', off: '\x1b[0m' }
  : { dim: '', cyan: '', blue: '', green: '', red: '', off: '' };

// Usage mistakes exit 2 like maw's own verbs; lookup failures exit 1.
class UsageError extends Error {}

function herdr(args, session) {
  const argv = session ? ['--session', session, ...args] : args;
  return execFileSync('herdr', argv, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

function sessionIndex() {
  const raw = JSON.parse(herdr(['session', 'list', '--json']));
  return (raw.sessions ?? []).map(s => ({
    session: s.name,
    status: s.running ? 'active' : 'stale',
    ...(s.default ? { default: true } : {}),
  }));
}

function countFor(session) {
  let panes = 0;
  let agents = 0;
  try {
    panes = JSON.parse(herdr(['pane', 'list'], session)).result?.panes?.length ?? 0;
  } catch {}
  try {
    agents = JSON.parse(herdr(['agent', 'list'], session)).result?.agents?.length ?? 0;
  } catch {}
  return { panes, agents };
}

function listSessions() {
  return sessionIndex().map(s => {
    const counts = s.status === 'active' ? countFor(s.session) : { panes: 0, agents: 0 };
    return { session: s.session, status: s.status, ...counts, ...(s.default ? { default: true } : {}) };
  });
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

function cmdLs(args) {
  const json = args.includes('--json');
  const rest = args.filter(a => a !== '--json');
  if (rest.length) throw new UsageError(`unknown argument: ${rest[0]}`);
  const sessions = listSessions();
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

function cmdAttach(args) {
  const print = args.includes('--print');
  const rest = args.filter(a => a !== '--print');
  const target = rest.shift();
  if (!target) throw new UsageError('attach needs a session name: maw herdr a <session>');
  if (rest.length) throw new UsageError(`unknown argument: ${rest[0]}`);

  const match = resolveSession(sessionIndex(), target);
  if (match.status !== 'active') throw new Error(`herdr session '${match.session}' is stopped; start it before attaching`);

  const argv = match.default ? ['herdr'] : ['herdr', '--session', match.session];
  if (match.session !== target) console.log(`  resolved: ${target} → ${match.session}`);
  if (print) {
    console.log(argv.join(' '));
    return;
  }
  if (!process.stdin.isTTY) {
    throw new Error(`stdin is not a terminal, so herdr's TUI cannot run here.\n  maw hands plugins a terminal only with cli.interactive support (maw-rs #992);\n  until then run it yourself: ${argv.join(' ')}`);
  }
  const run = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' });
  process.exitCode = run.status ?? 1;
}

const args = process.argv.slice(2);
const command = args.shift() || 'help';
try {
  if (['help', '--help', '-h'].includes(command)) console.log(HELP);
  else if (command === 'ls' || command === 'list') cmdLs(args);
  else if (command === 'a' || command === 'attach') cmdAttach(args);
  else throw new UsageError(`unknown command: ${command}`);
} catch (err) {
  console.error(`maw herdr: ${err.message}`);
  process.exitCode = err instanceof UsageError ? 2 : 1;
}
