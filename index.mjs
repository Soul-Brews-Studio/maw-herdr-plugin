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

function herdr(args, session) {
  const argv = session ? ['--session', session, ...args] : args;
  return execFileSync('herdr', argv, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const raw = JSON.parse(herdr(['session', 'list', '--json']));
  return (raw.sessions ?? []).map(s => {
    const status = s.running ? 'active' : 'stale';
    const counts = s.running ? countFor(s.name) : { panes: 0, agents: 0 };
    return { session: s.name, status, panes: counts.panes, agents: counts.agents, ...(s.default ? { default: true } : {}) };
  });
}

// Mirrors maw a: exact name, then unique prefix, then unique substring.
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
  throw new Error(`no herdr session '${target}'. known: ${names.join(', ') || '(none)'}`);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function cmdLs(args) {
  const json = args.includes('--json');
  const rest = args.filter(a => a !== '--json');
  if (rest.length) throw new Error(`unknown argument: ${rest[0]}`);
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
  if (!target) throw new Error('attach needs a session name: maw herdr a <session>');
  if (rest.length) throw new Error(`unknown argument: ${rest[0]}`);

  const known = listSessions();
  const match = resolveSession(known, target);
  if (match.status !== 'active') throw new Error(`herdr session '${match.session}' is stopped; start it before attaching`);

  const argv = match.default ? ['herdr'] : ['herdr', '--session', match.session];
  if (match.session !== target) console.log(`  resolved: ${target} → ${match.session}`);
  if (print) {
    console.log(argv.join(' '));
    return;
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
  else throw new Error(`unknown command: ${command}`);
} catch (err) {
  console.error(`maw herdr: ${err.message}`);
  process.exitCode = 1;
}
