#!/usr/bin/env node
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const HELP = `maw herdr <ls|a|attach|wake|hey|peek> [args]
  ls [--json]                          workspaces, grouped machine → repo → worktree
  ls --agents [--json]                 every agent pane across all sessions
  ls --sessions [--json]               herdr server instances (what 'herdr session list' means)
  a <session> [--print]                attach to a herdr session (alias: attach)
  wake <oracle> [--engine <kind>] [--prompt <text>] [--attach] [--dry-run]
       [--own-session]                 start an oracle's agent as a workspace in the
                                       running session (--own-session: its own server)
  hey <target> <message> [--dry-run]   submit a prompt to an agent (herdr's 'maw hey')
  peek <target> [--lines N] [--json]   read what an agent's pane is showing

Mirrors 'maw ls', 'maw a', 'maw wake' and 'maw hey' against the herdr multiplexer.
herdr is a sibling multiplexer: it cannot see tmux panes, and maw cannot see herdr panes.

A herdr SESSION is a server process, not a workspace. The thing that plays a tmux
session's role — the place work lives — is a WORKSPACE, and one session holds many.
'ls' therefore lists workspaces; 'ls --sessions' lists the servers.

<target> is a workspace label (the oracle name), a pane id, or an agent name.
Herdr agents are usually unnamed — 0 of 28 panes carried one on the machine this
was written for — so the workspace label is the handle that actually exists.
Scope to one session with --session <name> when two sessions share a label.`;

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

// --- workspaces -------------------------------------------------------------

/**
 * The tree herdr's own sidebar draws: machine → repo → linked worktrees.
 *
 * NOT `herdr session list`. A herdr session is a server process — one socket
 * under ~/.config/herdr/sessions/<name>/ — while the noun that corresponds to a
 * tmux session, the place work actually lives, is a workspace. Listing sessions
 * showed 8 rows, 7 of them dead servers reporting 0 panes, while the one running
 * session held 22 workspaces across 7 repos. Same data herdr renders; this is the
 * shape it renders it in.
 */
async function workspaceTree() {
  const sessions = sessionIndex().filter(s => s.status === 'active');
  const rows = await Promise.all(sessions.map(async s => {
    let snapshot;
    try {
      snapshot = unwrapSnapshot(await herdrJsonAsync(['api', 'snapshot'], s.session));
    } catch {
      return [];
    }
    // A workspace only carries a `worktree` block when herdr recognised a repo
    // there; a plain shell space has none, and its branch has to come from the
    // pane's own cwd — which is how the sidebar still shows one for them.
    const cwdOf = new Map();
    for (const pane of snapshot.panes ?? []) {
      if (pane.workspace_id && pane.cwd && !cwdOf.has(pane.workspace_id)) cwdOf.set(pane.workspace_id, pane.cwd);
    }
    return (snapshot.workspaces ?? []).map(w => {
      const wt = w.worktree ?? {};
      return {
        session: s.session,
        id: w.workspace_id,
        label: w.label ?? w.workspace_id,
        number: w.number ?? null,
        panes: w.pane_count ?? 0,
        tabs: w.tab_count ?? 0,
        status: w.agent_status ?? 'unknown',
        focused: !!w.focused,
        repo: wt.repo_name ?? null,
        checkout: wt.checkout_path ?? cwdOf.get(w.workspace_id) ?? null,
        linked: !!wt.is_linked_worktree,
      };
    });
  }));
  return rows.flat();
}

/**
 * Branch and ahead/behind, the way the sidebar shows them. Local reads only —
 * no fetch, so this never touches the network and never blocks on a remote.
 * Best effort: a checkout that has gone missing simply reports nothing.
 */
async function gitInfo(paths) {
  const out = new Map();
  await Promise.all([...new Set(paths.filter(Boolean))].map(async path => {
    const run = async args => {
      try {
        const { stdout } = await execFileP('git', ['-C', path, ...args], { encoding: 'utf8', timeout: 5_000 });
        return stdout.trim();
      } catch {
        return '';
      }
    };
    const branch = await run(['branch', '--show-current']);
    if (!branch) return;
    // one rev-list, two numbers — `git status -sb` would stat the whole worktree
    const counts = await run(['rev-list', '--left-right', '--count', `${branch}...@{u}`]);
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    out.set(path, { branch, ahead: ahead || 0, behind: behind || 0 });
  }));
  return out;
}

// --- roster -----------------------------------------------------------------

// A snapshot arrives wrapped as {id, result:{snapshot}} from the socket, but the
// shape has moved before; unwrap defensively rather than index blindly.
function unwrapSnapshot(raw) {
  return raw?.result?.snapshot ?? raw?.snapshot ?? raw?.result ?? raw;
}

/**
 * Every agent pane in every running session, flattened.
 *
 * Built from `api snapshot`, never from `agent list`: agent list returns one row
 * per agent and so collapses a split tab into a single entry — it reported 25
 * agents where the snapshot's panes array held 28. The snapshot also carries
 * tab_id and workspace_id, which is what makes a workspace label usable as a
 * target at all.
 */
async function roster() {
  const sessions = sessionIndex().filter(s => s.status === 'active');
  const rows = await Promise.all(sessions.map(async s => {
    let snapshot;
    try {
      snapshot = unwrapSnapshot(await herdrJsonAsync(['api', 'snapshot'], s.session));
    } catch {
      return [];
    }
    const spaces = new Map((snapshot.workspaces ?? []).map(w => [w.workspace_id, w]));
    const tabs = new Map((snapshot.tabs ?? []).map(t => [t.tab_id, t]));
    return (snapshot.panes ?? [])
      .filter(p => p.agent)          // a bare shell is not something to talk to
      .map(p => {
        const space = spaces.get(p.workspace_id);
        return {
          session: s.session,
          pane: p.pane_id,
          agent: p.agent,
          name: p.agent_name ?? null,
          status: p.agent_status ?? 'unknown',
          workspace: space?.label ?? p.workspace_id ?? '?',
          activeTab: space?.active_tab_id,
          tab: p.tab_id,
          tabLabel: tabs.get(p.tab_id)?.label ?? null,
          focused: !!p.focused,
          cwd: p.cwd ?? null,
        };
      });
  }));
  return rows.flat();
}

// A tab keeps its number as its label until someone renames it, and "digger-oracle/1"
// says less than "digger-oracle". Only a real name earns the suffix.
const named = t => t && t !== '' && !/^\d+$/.test(t);
const label = a => `${a.workspace}${named(a.tabLabel) && a.tabLabel !== a.workspace ? `/${a.tabLabel}` : ''}`;

// A workspace commonly holds several agent panes (a split tab, or several tabs),
// so an exact label match is routinely plural. Prefer the pane the operator is
// looking at, then the workspace's own active tab. Anything left is genuinely
// ambiguous and is reported rather than guessed.
function narrow(hits) {
  const focused = hits.filter(a => a.focused);
  if (focused.length === 1) return { pick: focused[0], why: 'focused pane' };
  const active = hits.filter(a => a.tab && a.tab === a.activeTab);
  if (active.length === 1) return { pick: active[0], why: 'active tab' };
  return null;
}

function resolveAgent(all, target, verb) {
  if (!all.length) throw new Error('no agent panes in any running herdr session');
  // Pane ids are colon-shaped too (wD:p4), so scoping is a flag, never a prefix.
  const tiers = [
    ['pane', a => a.pane === target],
    ['agent name', a => a.name === target],
    ['workspace', a => a.workspace === target],
    ['tab', a => a.tabLabel === target],
    ['prefix', a => a.workspace.startsWith(target)],
    ['substring', a => a.workspace.includes(target) || (a.name ?? '').includes(target)],
  ];
  for (const [how, test] of tiers) {
    const hits = all.filter(test);
    if (hits.length === 1) return { ...hits[0], how };
    if (hits.length > 1) {
      const narrowed = narrow(hits);
      if (narrowed) return { ...narrowed.pick, how: `${how}, ${narrowed.why}` };
      const lines = hits.map(a => `    ${a.pane.padEnd(8)} ${label(a).padEnd(22)} ${a.agent} (${a.status})`);
      throw new Error(
        `'${target}' matches ${hits.length} agent panes and none is focused:\n${lines.join('\n')}\n  target one by pane id: maw herdr ${verb} ${hits[0].pane}${verb === 'hey' ? ' "…"' : ''}`,
      );
    }
  }
  const known = [...new Set(all.map(a => a.workspace))].sort();
  throw new Error(`no agent '${target}'. workspaces: ${known.join(', ') || '(none)'}\n  see them all: maw herdr ls --agents`);
}

function statusDot(status) {
  if (status === 'working') return `${C.green}●${C.off}`;
  if (status === 'blocked') return `${C.red}●${C.off}`;
  return `${C.dim}○${C.off}`;
}

async function cmdLsAgents(json) {
  const agents = await roster();
  if (json) {
    console.log(JSON.stringify({ command: 'ls', mode: 'agents', scope: 'herdr', json: true, agents }));
    return;
  }
  if (!agents.length) {
    console.log(`${C.dim}no agent panes in any running herdr session${C.off}`);
    return;
  }
  // width from the data, so one long worktree name does not shear the column
  const wide = Math.max(...agents.map(a => label(a).length));
  let last = null;
  for (const a of agents) {
    if (a.session !== last) {
      console.log(`  ${C.cyan}${a.session}${C.off}`);
      last = a.session;
    }
    const focus = a.focused ? ` ${C.blue}◂${C.off}` : '';
    console.log(`    ${statusDot(a.status)} ${a.pane.padEnd(8)} ${label(a).padEnd(wide)} ${C.dim}${a.agent}${C.off}${focus}`);
  }
  console.log(`  ${C.dim}${plural(agents.length, 'agent pane')} · maw herdr peek <target> · maw herdr hey <target> "…"${C.off}`);
}

/** The old listing: herdr server instances. Real, but not where work lives. */
async function cmdLsSessions(json) {
  const sessions = await listSessions();
  if (json) {
    console.log(JSON.stringify({ command: 'ls', mode: 'sessions', scope: 'herdr', json: true, sessions }));
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
  const stale = sessions.filter(s => s.status !== 'active').length;
  if (stale) console.log(`  ${C.dim}${stale} stopped server${stale === 1 ? '' : 's'} — a session is a process, not a workspace. Work lives in: maw herdr ls${C.off}`);
}

async function cmdLs(args) {
  const json = args.includes('--json');
  const rest = args.filter(a => a !== '--json');
  if (rest[0] === '--agents') {
    rest.shift();
    if (rest.length) throw new UsageError(`unknown argument: ${rest[0]}`);
    return cmdLsAgents(json);
  }
  if (rest[0] === '--sessions') {
    rest.shift();
    if (rest.length) throw new UsageError(`unknown argument: ${rest[0]}`);
    return cmdLsSessions(json);
  }
  if (rest.length) throw new UsageError(`unknown argument: ${rest[0]}`);

  const spaces = await workspaceTree();
  if (json) {
    console.log(JSON.stringify({ command: 'ls', mode: 'workspaces', scope: 'herdr', json: true, workspaces: spaces }));
    return;
  }
  if (!spaces.length) {
    console.log(`${C.dim}no workspaces in any running herdr session${C.off}`);
    console.log(`  ${C.dim}servers, running or not: maw herdr ls --sessions${C.off}`);
    return;
  }

  const git = await gitInfo(spaces.map(w => w.checkout));

  // repo groups, mother first, its linked worktrees beneath — the sidebar's shape.
  // A workspace with no worktree metadata (a plain shell space) is its own group.
  const groups = new Map();
  for (const w of spaces) {
    const key = w.repo ?? `\u0000${w.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }

  const dot = w => (w.status === 'working' ? `${C.green}●${C.off}` : w.status === 'blocked' ? `${C.red}●${C.off}` : `${C.dim}○${C.off}`);
  const meta = w => {
    const g = w.checkout ? git.get(w.checkout) : null;
    const counts = `${plural(w.panes, 'pane')}`;
    if (!g) return `${C.dim}${counts}${C.off}`;
    const ahead = g.ahead ? ` ${C.green}↑${g.ahead}${C.off}` : '';
    const behind = g.behind ? ` ${C.red}↓${g.behind}${C.off}` : '';
    // A worktree is normally checked out on a branch of its own name, and
    // printing "neo-haos-14sep-mon2026  neo-haos-14sep-mon2026" says nothing.
    const branch = g.branch === w.label ? '' : `${C.dim}${g.branch}${C.off}`;
    return `${branch}${ahead}${behind}${branch || ahead || behind ? '  ' : ''}${C.dim}${counts}${C.off}`;
  };

  console.log(`  ${C.blue}Local${C.off}`);
  for (const items of groups.values()) {
    const mothers = items.filter(w => !w.linked);
    const links = items.filter(w => w.linked);
    const head = mothers[0] ?? links[0];
    const children = head === mothers[0] ? links : links.slice(1);
    console.log(`    ${dot(head)} ${C.cyan}${head.label}${C.off}  ${meta(head)}`);
    children.forEach((w, i) => {
      const tee = i === children.length - 1 ? '└─' : '├─';
      console.log(`      ${C.dim}${tee}${C.off} ${dot(w)} ${w.label}  ${meta(w)}`);
    });
  }

  const linked = spaces.filter(w => w.linked).length;
  console.log(`  ${C.dim}${plural(spaces.length, 'workspace')} · ${groups.size} repos · ${linked} worktrees · agents: maw herdr ls --agents${C.off}`);

  // Remote machines are separate herdr servers reached over SSH; this listing is
  // local only, so say so rather than imply the fleet is one machine.
  try {
    const machines = execFileSync('herdr', ['machine', 'list'], { encoding: 'utf8', timeout: 5_000 })
      .split('\n').filter(Boolean).map(l => l.split('\t')[1]).filter(Boolean);
    if (machines.length) console.log(`  ${C.dim}remote: ${machines.join(', ')} — herdr --remote <machine>${C.off}`);
  } catch {
    // no saved machines, or an older herdr without the verb
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

// --- hey / peek -------------------------------------------------------------

function takeSession(args) {
  const at = args.indexOf('--session');
  if (at === -1) return null;
  const value = args[at + 1];
  if (!value || value.startsWith('-')) throw new UsageError('--session needs a name');
  args.splice(at, 2);
  return value;
}

async function poolFor(args, verb) {
  const session = takeSession(args);
  const all = await roster();
  const pool = session ? all.filter(a => a.session === session) : all;
  if (session && !pool.length) throw new Error(`no agent panes in herdr session '${session}'`);
  return { pool, verb };
}

async function cmdHey(args) {
  // --dry-run mirrors wake's: prompting a live agent is not free, so show the
  // resolution and the exact herdr call before committing to it.
  const dryRun = args.includes('--dry-run');
  if (dryRun) args.splice(args.indexOf('--dry-run'), 1);
  const { pool, verb } = await poolFor(args, 'hey');
  const target = args.shift();
  if (!target) throw new UsageError('hey needs a target and a message: maw herdr hey <target> <message>');
  // Everything after the target is the message, unquoted included — `maw hey`
  // behaves this way and retyping quotes for a sentence is friction nobody wants.
  const message = args.join(' ').trim();
  if (!message) throw new UsageError(`hey needs a message: maw herdr hey ${target} "<message>"`);

  const hit = resolveAgent(pool, target, verb);
  console.log(`  ${statusDot(hit.status)} ${C.cyan}${label(hit)}${C.off} ${C.dim}${hit.pane} · ${hit.agent} · ${hit.status} · ${hit.session}${C.off}`);
  if (dryRun) {
    console.log(`  ${C.dim}would run:${C.off} herdr --session ${hit.session} agent prompt ${hit.pane} ${JSON.stringify(message)}`);
    console.log(`  ${C.dim}matched by ${hit.how} · nothing was sent${C.off}`);
    return;
  }
  // `agent prompt` takes a PANE ID here, not a handle: herdr agents are almost
  // always unnamed, so handle targeting would fail for nearly every pane.
  herdr(['agent', 'prompt', hit.pane, message], hit.session, 30_000);
  console.log(`  sent ${C.dim}(matched by ${hit.how})${C.off}`);
  console.log(`  read it back: maw herdr peek ${hit.pane}`);
}

async function cmdPeek(args) {
  const json = args.includes('--json');
  const rest = args.filter(a => a !== '--json');
  let lines = 40;
  const at = rest.indexOf('--lines');
  if (at !== -1) {
    lines = Number(rest[at + 1]);
    if (!Number.isInteger(lines) || lines < 1) throw new UsageError('--lines needs a positive integer');
    rest.splice(at, 2);
  }
  const { pool, verb } = await poolFor(rest, 'peek');
  const target = rest.shift();
  if (!target) throw new UsageError('peek needs a target: maw herdr peek <target> [--lines N]');
  if (rest.length) throw new UsageError(`unknown argument: ${rest[0]}`);

  const hit = resolveAgent(pool, target, verb);

  // --source visible, ALWAYS. herdr's own default is `recent`, which asks for
  // scrollback — and on an idle agent herdr gathers that by driving the pane's
  // own mouse-scroll, so the operator watches their real terminal scroll up and
  // snap back once per read. Measured: a 400-line `recent` text read took 13.8s
  // against ~0.1s for `visible`. A read that moves the thing being read is not a
  // read, so this flag is not configurable and there is no --scrollback.
  // `pane read` answers with the terminal text itself, not JSON — unlike
  // `pane list` and `session list --json`, which do. Do not hand it to JSON.parse.
  const text = herdr(['pane', 'read', hit.pane, '--source', 'visible', '--lines', String(lines), '--format', 'text'], hit.session, 20_000);

  if (json) {
    console.log(JSON.stringify({ command: 'peek', pane: hit.pane, session: hit.session, workspace: hit.workspace, agent: hit.agent, status: hit.status, source: 'visible', lines, text }));
    return;
  }
  console.log(`  ${statusDot(hit.status)} ${C.cyan}${label(hit)}${C.off} ${C.dim}${hit.pane} · ${hit.agent} · ${hit.status} · ${hit.session}${C.off}`);
  console.log(`${C.dim}${'─'.repeat(60)}${C.off}`);
  console.log(text.replace(/\n+$/, ''));
  console.log(`${C.dim}${'─'.repeat(60)}${C.off}`);
  console.log(`  ${C.dim}visible viewport, last ${lines} lines · talk back: maw herdr hey ${hit.pane} "…"${C.off}`);
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
  const opts = { engine: 'claude', prompt: null, attach: false, dryRun: false, ownSession: false };
  let target;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--engine' || arg === '--kind') opts.engine = args.shift() ?? '';
    else if (arg === '--prompt') opts.prompt = args.shift() ?? '';
    else if (arg === '--attach' || arg === '-a') opts.attach = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--own-session') opts.ownSession = true;
    else if (arg.startsWith('-')) throw new UsageError(`unknown argument: ${arg}`);
    else if (target === undefined) target = arg;
    else throw new UsageError(`unexpected argument: ${arg}`);
  }
  if (!target) throw new UsageError('wake needs an oracle: maw herdr wake <oracle> [--engine <kind>] [--prompt <text>] [--attach] [--dry-run]');
  if (!opts.engine) throw new UsageError('--engine needs a value (herdr agent kind, e.g. claude, codex, gemini)');

  const oracle = resolveOracle(target);

  /**
   * Wake into the RUNNING session, as a workspace — not into a server of its own.
   *
   * A herdr session is a server process; a workspace is where work lives, and one
   * session holds many. Giving every oracle its own session meant one socket
   * directory per oracle that nobody attaches to again: ~/.config/herdr/sessions/
   * accumulated seven, all stopped, and they were the seven noise rows in
   * `maw herdr ls`. The fleet itself does the opposite — 22 workspaces across 7
   * repos inside a single session. So do that, and keep the old behaviour behind
   * --own-session for the case where isolation is actually wanted.
   */
  const known = sessionIndex();
  const fallback = known.find(s => s.default)?.session ?? 'default';
  const session = opts.ownSession ? oracle.repo : fallback;
  if (!opts.ownSession && !opts.dryRun && !known.some(s => s.session === session && s.status === 'active')) {
    throw new Error(`herdr session '${session}' is not running — start herdr first, or isolate this oracle with --own-session`);
  }
  const agent = agentNameFor(oracle);
  const plan = [
    ...(opts.ownSession ? [`herdr --session ${session} server   # headless, detached (only if not running)`] : []),
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

  const running = known.some(s => s.session === session && s.status === 'active');
  if (opts.ownSession && !running) {
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
  else if (command === 'hey') await cmdHey(args);
  else if (command === 'peek' || command === 'read') await cmdPeek(args);
  else throw new UsageError(`unknown command: ${command}`);
} catch (err) {
  console.error(`maw herdr: ${err.message}`);
  process.exitCode = err instanceof UsageError ? 2 : 1;
}
