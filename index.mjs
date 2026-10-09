#!/usr/bin/env node
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runServe } from './src/serve/mod.runServe.mjs';
import { cmdTicket } from './src/cli/mod.cmdTicket.mjs';
import { TargetError, callerFromEnv, cmdResolve, label, resolveAgent, shq, takeDry } from './src/cli/mod.target.mjs';
import { describeFocus, focusPane, planFocus } from './src/cli/mod.attachFocus.mjs';
import { pickCandidate } from './src/cli/mod.pickCandidate.mjs';
import { promptLine } from './src/cli/mod.promptLine.mjs';
import { cmdClose, cmdKill, cmdRestart, cmdResume } from './src/cli/mod.lifecycle.mjs';
import { cmdWatch, runWatcher } from './src/cli/mod.watch.mjs';
import { cmdInbox, cmdReply } from './src/cli/mod.inbox.mjs';
import { checkoutLine } from './src/cli/mod.checkoutLine.mjs';
import { wantsHelp } from './src/cli/mod.wantsHelp.mjs';
import { repoGroups } from './src/cli/mod.repoGroups.mjs';
import { configuredProviders } from './src/cli/mod.resumeProviders.mjs';
import { STATES, ghqRoots, worktreeStates } from './src/cli/mod.worktreeStates.mjs';
import { showWorktreeStates, snapshotFailure, stateSummaryLine, takeStateFlag } from './src/cli/mod.lsStateView.mjs';
import { cmdAudit } from './src/cli/mod.audit.mjs';
import { cmdClean, cmdSync } from './src/cli/mod.cleanup.mjs';
import { cmdJoin } from './src/cli/mod.cmdJoin.mjs';
import { cmdBreak } from './src/cli/mod.cmdBreak.mjs';
import { cmdLayout } from './src/cli/mod.cmdLayout.mjs';
import { cmdWhoami } from './src/cli/mod.cmdWhoami.mjs';
import { cmdRestore } from './src/cli/mod.cmdRestore.mjs';
import { cmdWork } from './src/cli/mod.cmdWork.mjs';
import { cmdWt } from './src/cli/mod.cmdWt.mjs';
import { cmdHandover } from './src/cli/mod.cmdHandover.mjs';

const execFileP = promisify(execFile);

const HELP = `maw herdr <ls|list|a|attach|wake|work|wt|handover|hey|peek|read|resolve|restart|resume|restore|kill|close|join|here|break|back|layout|whoami|watch|inbox|reply|audit|clean|sync|ticket|federation|fed|serve> [args]
  ls [--json]                          workspaces, grouped machine → repo → worktree
  ls --path                            ...with each workspace's checkout path beneath it
  ls <running|open|resumable|cold>     every worktree in that state, open space or not
                                       (also --state <s>; combines with --path, --json)
  ls restorable [--json]               worktrees whose FOLDER is gone while the branch and
                                       the transcript remain (= maw herdr restore)
  ls --agents [--json]                 every agent pane across all sessions
  ls --sessions [--json]               herdr server instances (what 'herdr session list' means)
  a <target> [--print] [--dry] [-y]    bring a target to the front, like maw tmux a: focus its
                                       pane (inside herdr) or attach its session; a session
                                       name attaches that session (alias: attach), and a
                                       stopped one is started after asking, from outside
                                       herdr (herdr does not nest). An ambiguous
                                       name asks which one when run in a terminal; a target
                                       with no pane asks to wake it (-y: wake without asking).
  wake <oracle> [--engine <kind>] [--prompt <text>] [--attach] [--dry-run]
       [--own-session]                 start an oracle's agent as a workspace in the
                                       running session (--own-session: its own server)
  work <repo|.|path|url> [task] [--wt [slug]] [--engine <kind>] [--prompt <text>] [--attach] [--dry]
                                       open a repo, or one task worktree of it (agents/<slug>,
                                       space <repo>-<slug>), as a space with an agent in the
                                       running session (maw-rs: maw work). A GitHub URL is cloned
                                       with ghq when missing; an issue/pull URL names the task and
                                       is the agent's first prompt. A space already on that folder
                                       is reused. --dry plans every step and runs none.
  wt <slug> [--base REF] [--issue N] [--engine claude|codex|omx] [--brief <text>] [--repo <path>] [--dry]
                                       the /herdr-wt flow: cut <repo>/wt/<slug>-<owner>[-issue<N>]-<day>
                                       from origin/<default> as a locked herdr worktree space, fix its
                                       token, start the engine through the pane's shell, name the agent
                                       and (with --issue/--brief) brief it by pane id. Writes no issues.
                                       A folder-trust question is reported, never answered. --dry runs
                                       only reads.
  handover <space> <oracle> [--issue N] [--engine claude|codex|omx] [--dry]
                                       hand a space's repo to another oracle: read the space (repo from
                                       its origin, branch, clean?, agent idle?), run wt in the oracle's
                                       repo (maw locate) with a brief whose first step is
                                       /incubate <org>/<repo> --wt <slug>, then close the old space only
                                       when it is clean AND its agent idle; otherwise leave it, say why.
  hey <target> <message> [--dry]       submit a prompt to an agent (herdr's 'maw hey')
  peek <target> [--lines N] [--json] [--dry]
                                       read what an agent's pane is showing
  resolve [<target>] [--json]          what a target resolves to, and how; never acts
  resolve --list [--json]              every worktree and space a target can name
  restart [<target>] [--channel <entry>|--no-channel] [--dry]
                                       quit the agent, relaunch it in the same pane and
                                       name with the argv read from its running process
  resume [<target>] [--dry]            start the agent on its worktree's newest transcript
  restore [<name|path>] [--dry] [--no-resume] [--json]
                                       no target: what can come back. A target: git worktree
                                       add at the SAME path from its branch, then resume it
  kill [<target>] [--dry]              ctrl+c the agent until it exits; the pane stays
  close [<target>] [--force] [--dry]   close the target's herdr space; worktree stays
  join <target>... [--cols|--rows|--main [--ratio R]] [--tell] [--dry]
                                       bring agents' real panes into your tab (alias: here):
                                       no restart, history kept, each share set in the move
  break [<target>...] [--into <space>|--label <name>] [--tell] [--dry]
                                       move panes out to a space of their own (alias: back)
  layout <cols|rows|main> [--ratio R] [--dry]
                                       re-tile the tab you are in, keeping the panes' order
  whoami [--json]                      the pane this really runs in — HERDR_PANE_ID goes
                                       stale when a pane moves to another space
  watch [<target>] [--every] [--dry]   be told when that agent finishes: a note lands
                                       in this pane's inbox (from herdr's pushed events)
  watch --list [--all] [--json]        what this pane watches (--all: every pane's)
  watch [<target>] --stop              stop watching it
  inbox [--since <id>] [--all] [--json]
                                       notes addressed to this pane; reading never consumes
  reply <target> <text> [--dry]        file an answer in that pane's inbox, signed by this pane
  audit [<target>...] [--idle 24h] [--min-age 3] [--json]
                                       report only, never changes anything: worktrees whose
                                       folder is gone, spaces on nothing, idle agents,
                                       checkouts only behind, merged worktrees (or why kept)
  clean [<target>...] [--go|--pick] [--min-age 3] [--idle-shells] [--json]
                                       plan removing gone + merged worktrees, through herdr;
                                       a named target is removed if its commits are pushed;
                                       a pane in it (agent, or shell without --idle-shells) keeps it
  sync [<target>...] [--idle-agents] [--idle 24h] [--idle-shells] [--go|--pick] [--json]
                                       plan making herdr and git agree: prune gone worktrees,
                                       close spaces on nothing, fast-forward behind checkouts;
                                       --idle-agents also closes idle agents' spaces
  serve [--listen HOST:PORT]           core dashboard API (default 127.0.0.1:3457)
        --token-file PATH             required operator token file
        [--herdr PATH] [--data-dir PATH]
        [--mcp]                       also serve MCP at /mcp (writes always need the token)
  ticket <pick|open|continue|status>   one GitHub issue -> one worktree -> an agent (/herdr-ticket);
                                       --json for the oracle apps
  federation [--json]                  the mesh: who federates with whom (alias: fed)

Mirrors 'maw ls', 'maw a', 'maw wake' and 'maw hey' against the herdr multiplexer.
herdr is a sibling multiplexer: it cannot see tmux panes, and maw cannot see herdr panes.

A herdr SESSION is a server process, not a workspace. The thing that plays a tmux
session's role — the place work lives — is a WORKSPACE, and one session holds many.
'ls' therefore lists workspaces; 'ls --sessions' lists the servers.

<target> is one grammar, shared by every verb that takes one:
  self           the pane you are typing in (the default where a target is optional),
                 checked against the process tree: HERDR_PANE_ID goes stale when a pane moves
  /abs/path  .   the worktree containing that path (a directory inside one works)
  w5D:p1         a herdr pane id
  org/repo       that ghq clone's main worktree, in any case (the form 'maw locate' prints)
  digger-oracle  a name: exact label, then a repo's main worktree, then an oracle's main
                 worktree (neo = neo-oracle), then a unique substring
hey and peek also take an agent name or a workspace/tab label, as they always have.
An ambiguous target lists its candidates and does nothing. --dry (alias --dry-run)
prints what a target resolves to and exits. Most herdr agents are unnamed until
someone runs 'herdr agent rename', so the workspace label is the handle that always
exists. Scope to one session with --session <name> when two sessions share a label.

A worktree is running (agent in a pane), open (space, no agent), resumable (no
space, but a resume provider found a transcript) or cold. Providers: claude, codex;
MAW_HERDR_RESUME_PROVIDERS=none turns them off, MAW_HERDR_CLAUDE_ROOTS and
MAW_HERDR_CODEX_ROOTS move them. Worktrees are found under $GHQ_ROOT / ghq root.

clean and sync only print a plan until given --go (run it all) or --pick (ask
before each action, re-checking it first). A worktree holding gitignored data is
kept — gitignored is not worthless, and no commit brings it back; node_modules and
other rebuildable directories do not count. "Idle" is herdr's idle/done status
plus a transcript older than --idle, so a closed agent can always be resumed.

--help / -h after any verb prints this text; 'serve --help' has its own.`;

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', cyan: '\x1b[36m', blue: '\x1b[94m', green: '\x1b[32m', red: '\x1b[31m', warnTag: '\x1b[33m', off: '\x1b[0m' }
  : { dim: '', cyan: '', blue: '', green: '', red: '', warnTag: '', off: '' };

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
  // `a` also takes worktrees, workspaces and panes now (#82), so say so and end
  // with commands that list every valid target.
  message += `\n  no worktree, workspace or pane matches '${target}' either. List what a takes:\n  maw herdr resolve --list\n  maw herdr ls --sessions`;
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

// "17 audit entrys". Only the irregulars this codebase actually uses live here;
// a general pluraliser would be more code than the problem deserves.
const PLURALS = { entry: 'entries' };

function plural(n, word) {
  return `${n} ${n === 1 ? word : PLURALS[word] ?? `${word}s`}`;
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
async function workspaceTree(failed = []) {
  const sessions = sessionIndex().filter(s => s.status === 'active');
  const rows = await Promise.all(sessions.map(async s => {
    let snapshot;
    try {
      snapshot = unwrapSnapshot(await herdrJsonAsync(['api', 'snapshot'], s.session));
    } catch (err) {
      failed.push(snapshotFailure(s.session, err));   // ls says so; its spaces are missing
      return [];
    }
    // A workspace only carries a `worktree` block when herdr recognised a repo
    // there; a plain shell space has none, and its branch has to come from the
    // pane's own cwd — which is how the sidebar still shows one for them.
    const cwdOf = new Map();
    const agentsIn = new Map();   // agent panes per space: running vs open
    for (const pane of snapshot.panes ?? []) {
      if (pane.workspace_id && pane.cwd && !cwdOf.has(pane.workspace_id)) cwdOf.set(pane.workspace_id, pane.cwd);
      if (pane.agent) agentsIn.set(pane.workspace_id, (agentsIn.get(pane.workspace_id) ?? 0) + 1);
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
        repoKey: wt.repo_key ?? wt.repo_root ?? null,
        checkout: wt.checkout_path ?? cwdOf.get(w.workspace_id) ?? null,
        linked: !!wt.is_linked_worktree,
        agents: agentsIn.get(w.workspace_id) ?? 0,
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
    // The name lives on the AGENT record, not on the pane. `panes[]` carries
    // neither `name` nor `agent_name`, so reading it off a pane always yielded
    // undefined and the name tier in resolveAgent could never match — measured:
    // `herdr agent get zzz-probe` resolved while `maw herdr peek zzz-probe` said
    // no such agent. Join by pane_id.
    const names = new Map((snapshot.agents ?? []).filter(a => a.name).map(a => [a.pane_id, a.name]));
    return (snapshot.panes ?? [])
      .filter(p => p.agent)          // a bare shell is not something to talk to
      .map(p => {
        const space = spaces.get(p.workspace_id);
        return {
          session: s.session,
          pane: p.pane_id,
          agent: p.agent,
          name: names.get(p.pane_id) ?? null,
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

// label(), narrow() and resolveAgent() live in src/cli/mod.target.mjs, the one
// resolver every target-taking verb shares.

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

/**
 * Every agent on every node the federation can reach, grouped by node.
 *
 * `ls --agents` asks the local herdr socket and therefore stops at this
 * machine. This asks the federation node instead, so one command answers
 * "what is running anywhere" — including nodes we hold no link to, seen
 * through a hub.
 */
async function cmdLsFederation(json, agentsOnly) {
  let fleet;
  try {
    fleet = await fleetRoster();
  } catch (err) {
    throw new Error(`no federation node at ${FED_URL} — ${String(err).replace(/^Error:\s*/, '')}\n  start one: cd <herdr-federation> && just node start\n  or point at another: HERDR_FED_URL=http://host:6750 maw herdr ls --federation`);
  }
  const rows = agentsOnly ? fleet.rows.filter(isAgent) : fleet.rows;

  if (json) {
    console.log(JSON.stringify({
      command: 'ls', mode: 'federation', scope: 'herdr', json: true,
      node: fleet.node, url: FED_URL,
      panes: rows.map(r => ({ node: r.node, via: r.via, pane: r.pane, handle: r.handle, kind: r.kind ?? null, status: r.status ?? null, where: r.where ?? null, workspace: r.workspace ?? null })),
    }));
    return;
  }

  console.log(`  ${C.blue}federation${C.off} · ${C.cyan}${fleet.node}${C.off}  ${C.dim}${FED_URL}${C.off}`);
  console.log();
  if (!rows.length) {
    console.log(`  ${C.dim}nothing to list — no agent panes on any reachable node${C.off}`);
    return;
  }
  // this node first, then direct peers, then anything behind a hub
  const order = fleet.nodes.slice().sort((a, b) => {
    const rank = n => (n === fleet.node ? 0 : fleet.relayed[n] ? 2 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  const wide = Math.max(...rows.map(r => (r.handle ?? r.pane).length), 8);
  for (const node of order) {
    const mine = rows.filter(r => r.node === node);
    const via = fleet.relayed[node]?.via;
    const h = fleet.health[node];
    const fails = h?.consecutive ?? 0;
    const tag = node === fleet.node ? `${C.dim}this node${C.off}` : via ? `${C.dim}via ${via}${C.off}` : `${C.dim}direct${C.off}`;
    const agents = mine.filter(isAgent).length;
    // A link that is failing is why a node shows no panes; say so instead of
    // leaving an empty node that looks idle.
    const note = fails > 0
      ? `${C.red}${fails} failed since ${ago(h?.lastOkAt)}${C.off}`
      : `${C.dim}${plural(agents, 'agent')} of ${plural(mine.length, 'pane')}${C.off}`;
    const dot = fails > 0 ? `${C.red}○${C.off}` : via ? `${C.dim}◌${C.off}` : `${C.green}●${C.off}`;
    console.log(`  ${dot} ${C.cyan}${node}${C.off}  ${tag} ${C.dim}·${C.off} ${note}`);
    if (!mine.length && fails === 0) console.log(`      ${C.dim}no panes${C.off}`);
    for (const r of mine) {
      const dot = isAgent(r) ? statusDot(r.status) : `${C.dim}·${C.off}`;
      const place = r.workspace ?? r.where ?? '';
      console.log(`      ${dot} ${(r.handle ?? r.pane).padEnd(wide)} ${C.dim}${r.pane.padEnd(8)} ${r.kind ?? 'shell'}${place ? ` · ${place}` : ''}${C.off}`);
    }
  }
  console.log();
  console.log(`  ${C.dim}${plural(rows.filter(isAgent).length, 'agent')} across ${plural(order.length, 'node')} · peek one: maw herdr peek <node>:<pane>${C.off}`);
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
  const path = args.includes('--path');
  const rest = args.filter(a => a !== '--json' && a !== '--path');
  // A state is a word, not a flag: --resumable read as an unknown argument with no way
  // forward (#90). Name the spelling that works.
  const flagged = rest.find(a => a.startsWith('--') && [...STATES, 'restorable'].includes(a.slice(2)));
  if (flagged) throw new UsageError(`${flagged} is a state, and states are words, not flags:\n  maw herdr ls ${flagged.slice(2)}${json ? ' --json' : ''}`);
  // restorable is not a state of a checkout on disk — its folder is gone — so the
  // listing comes from the transcripts' side (mod.restore.mjs)
  const at = rest.indexOf('--state');
  if (rest[0] === 'restorable' || (at !== -1 && rest[at + 1] === 'restorable')) {
    const extra = rest.filter((a, i) => a !== 'restorable' && !(a === '--state' && rest[i + 1] === 'restorable'));
    if (extra.length) throw new UsageError(`unknown argument: ${extra[0]}\n  maw herdr ls restorable${json ? ' --json' : ''}`);
    return cmdRestore(json ? ['--json'] : [], { UsageError });
  }
  let state = takeStateFlag(rest, UsageError);
  // only the workspace tree has a checkout; --agents --json already carries cwd.
  // Anything else left over is an unknown argument, reported as one below.
  if (path && ['--agents', '--sessions', '--federation', '--fed'].includes(rest[0])) throw new UsageError(`--path applies to the workspace listing, not ${rest[0]}\n  maw herdr ls --path`);
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
  if (rest[0] === '--federation' || rest[0] === '--fed') {
    rest.shift();
    const agentsOnly = rest[0] === '--agents' && (rest.shift(), true);
    if (rest.length) throw new UsageError(`unknown argument: ${rest[0]}`);
    return cmdLsFederation(json, agentsOnly);
  }
  if (!state && STATES.includes(rest[0])) state = rest.shift();
  if (rest.length) throw new UsageError(`unknown argument: ${rest[0]}`);

  const providers = configuredProviders();   // a bad provider name fails before herdr is asked
  const failed = [];
  const found = await worktreeStates({ spaces: await workspaceTree(failed), roots: ghqRoots(process.env, readOracleRegistry().ghqRoot), providers });
  if (await showWorktreeStates(found, { state, json, path, providers, failed, C })) return;
  const spaces = found.spaces;
  if (!spaces.length) {
    console.log(`${C.dim}no workspaces in any running herdr session${C.off}`);
    console.log(`  ${C.dim}servers, running or not: maw herdr ls --sessions${C.off}`);
    console.log(stateSummaryLine(found, providers, C));
    return;
  }

  const git = await gitInfo(spaces.map(w => w.checkout));

  // repo groups, mother first, its linked worktrees beneath — the sidebar's shape.
  // A workspace with no worktree metadata (a plain shell space) is its own group.
  const groups = repoGroups(spaces);

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
  for (const { heads, children } of groups) {
    for (const head of heads) {
      console.log(`    ${dot(head)} ${C.cyan}${head.label}${C.off}  ${meta(head)}`);
      if (path) console.log(checkoutLine(head.checkout, 'head', C));
    }
    children.forEach((w, i) => {
      const last = i === children.length - 1;
      console.log(`      ${C.dim}${last ? '└─' : '├─'}${C.off} ${dot(w)} ${w.label}  ${meta(w)}`);
      if (path) console.log(checkoutLine(w.checkout, last ? 'last' : 'child', C));
    });
  }

  const linked = spaces.filter(w => w.linked).length;
  console.log(`  ${C.dim}${plural(spaces.length, 'workspace')} · ${groups.length} repos · ${linked} worktrees · agents: maw herdr ls --agents${C.off}`);
  console.log(stateSummaryLine(found, providers, C));

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

function attachSession(match, target, print) {
  if (match.status !== 'active') throw new Error(`herdr session '${match.session}' is stopped; start it before attaching\n  herdr --session ${match.session}`);
  const argv = attachArgv(match);
  if (match.session !== target) console.log(`  resolved: ${target} → ${match.session}`);
  if (print) {
    console.log(argv.join(' '));
    return;
  }
  runAttach(argv);
}

/**
 * The interactive picker for an ambiguous `a <name>`. It runs only when stdin and
 * stderr are both terminals (pipes, agents and tests keep the plain error), and
 * never with --dry or --print. MAW_HERDR_PICK_ANSWER exists ONLY so a smoke can
 * drive the picker without a terminal: when set, it is the typed line.
 */
const pickerAnswerEnv = () => process.env.MAW_HERDR_PICK_ANSWER;
// The wake question has the same seam: MAW_HERDR_WAKE_ANSWER is the typed line (smoke only).
const wakeAnswerEnv = () => process.env.MAW_HERDR_WAKE_ANSWER;
const pickerAvailable = () => pickerAnswerEnv() !== undefined || wakeAnswerEnv() !== undefined || Boolean(process.stdin.isTTY && process.stderr.isTTY);

/** Ask one question on stderr; `seam` is the test answer, when one is set. → { line } | { eof } | { sigint } */
async function ask(question, seam) {
  if (seam !== undefined) { console.error(`${question}${seam}`); return { line: seam }; }
  return promptLine(question);
}

/**
 * `a` on a target with no pane (a closed worktree). Returns true when it was woken
 * and the caller should resolve again; false after saying nothing was done.
 * Waking is `maw herdr resume`: it opens the worktree's space and brings its newest
 * transcript back, in-process. Default answer is No (old maw-js `attach`, Tier 2).
 */
async function wakeForAttach(err, { target, scope, yes }) {
  const { label, path } = err.wake;
  if (!yes) {
    console.error(`  ○ '${label}' has no pane (not running)`);
    const got = await ask(`  Wake "${label}"? [y/N] `, wakeAnswerEnv());
    if (got.sigint) { console.error('\n  aborted — nothing was done.'); process.exitCode = 130; return false; }
    if (!/^(y|yes)$/i.test((got.line ?? '').trim())) { console.error('  aborted — nothing was done.'); process.exitCode = 1; return false; }
  }
  await cmdResume([path, ...(scope ? ['--session', scope] : [])], { UsageError });
  return true;
}

/**
 * `a <name>` where <name> is exactly a STOPPED herdr session and no worktree or
 * workspace has that exact name (#115). Attaching is starting: `herdr --session
 * <name>` launches its server, which restores its spaces and, with herdr's default
 * resume_agents_on_restore, resumes their agents. So it asks first, like a wake, and
 * never runs inside herdr, which does not launch within its own panes by default
 * (allow_nested = false): there it prints the command to run from outside.
 */
async function startStoppedSession(match, { dry, print, yes }) {
  const line = attachArgv(match).join(' ');
  if (dry) { console.log(`  session ${match.session} (stopped) — would start it and attach: ${line}`); return; }
  if (print) { console.log(line); return; }
  if (process.env.HERDR_ENV === '1') {
    throw new Error(`herdr session '${match.session}' is stopped, and herdr does not start inside its own panes (allow_nested) — start it from a terminal outside herdr:\n  ${line}`);
  }
  if (!yes) {
    if (!pickerAvailable()) throw new Error(`herdr session '${match.session}' is stopped; starting it may resume its agents\n  maw herdr a ${shq(match.session)} -y   (start it, then attach)`);
    const got = await ask(`  Start herdr session "${match.session}"? herdr may resume its agents. [y/N] `, wakeAnswerEnv());
    if (got.sigint) { console.error('\n  aborted — nothing was done.'); process.exitCode = 130; return; }
    if (!/^(y|yes)$/i.test((got.line ?? '').trim())) { console.error('  aborted — nothing was done.'); process.exitCode = 1; return; }
  }
  console.log(`  starting herdr session '${match.session}': ${line}`);
  runAttach(attachArgv(match));
}

/** Ask which candidate. Returns { args } to continue with, or null after saying nothing was done. */
async function askWhich(err) {
  const choices = err.choices;
  const [header, ...rest] = err.message.split('\n');
  const wide = Math.max(...choices.map(c => c.args.map(shq).join(' ').length));
  const list = choices.map((c, i) => `  ${i + 1}) ${c.args.map(shq).join(' ').padEnd(wide)}   # ${c.note}`);
  console.error([`maw herdr: ${header}`, ...list, ...(err.choicesMore ? [err.choicesMore] : [])].join('\n'));
  const question = `pick 1-${choices.length} (Enter cancels): `;
  const got = await ask(question, pickerAnswerEnv());
  if (got.sigint) { console.error('\n  nothing was done'); process.exitCode = 130; return null; }
  const result = pickCandidate(choices, got.line ?? null);
  if (result.index !== undefined) return choices[result.index];
  if (result.cancel) { console.error('  nothing was done'); process.exitCode = 1; return null; }
  throw new TargetError(
    `'${result.invalid}' is not 1-${choices.length} — nothing was done. Name one:\n${rest.join('\n')}`,
    'ambiguous', err.candidates,
  );
}

/**
 * `a <target>` brings a target to the front, like `maw tmux a` (#82). A session
 * name keeps its old meaning (attach that session). Anything else resolves through
 * the shared target grammar and its pane is focused over the session's socket —
 * herdr's switch-client — then the session is attached if the caller is not
 * already its client. A target the grammar cannot find falls back to the old
 * session prefix/substring match, so nothing that attached before stops working.
 * A stopped session named exactly is started (asked first, never inside herdr) when
 * no worktree or workspace has that exact name.
 */
async function cmdAttach(args, { picked = false, woke = false } = {}) {
  const dry = takeDry(args);
  const print = args.includes('--print');
  const yes = args.some(a => a === '-y' || a === '--yes');
  const rest = args.filter(a => a !== '--print' && a !== '-y' && a !== '--yes');
  const scope = takeSession(rest);   // the `--session <s> <pane>` lines an ambiguity prints
  const target = rest.shift();
  if (!target) throw new UsageError('a needs a target: a session, worktree, workspace or pane\n  maw herdr a self\n  maw herdr resolve --list');
  if (rest.length) throw new UsageError(`unknown argument: ${rest[0]}`);

  const known = sessionIndex();
  // A running session named exactly keeps the old meaning. A STOPPED one does not
  // shadow a live worktree or workspace of the same name (herdr keeps stopped
  // sessions listed, e.g. a 'neo-oracle' session beside the neo-oracle workspace).
  const exact = known.find(s => s.session === target && s.status === 'active');
  if (exact) {
    if (dry) { console.log(`  session ${exact.session} (${exact.status}) — would attach: ${attachArgv(exact).join(' ')}`); return; }
    return attachSession(exact, target, print);
  }
  // It does beat names that merely CONTAIN the target, so the grammar runs exact-only
  // (#115: `a homekeeper` listed three closed …-homekeeper-… worktrees and never
  // offered the stopped homekeeper session).
  const stopped = known.find(s => s.session === target && s.status !== 'active');

  let plan;
  try {
    plan = await planFocus(target, { caller: callerFromEnv(), session: scope, exact: Boolean(stopped) });
  } catch (err) {
    if (err instanceof TargetError && err.wake && !woke) {
      if (dry) { console.log(`  would wake '${err.wake.label}', then focus`); return; }
      if (!yes && (print || !pickerAvailable())) {
        err.message += `\n  maw herdr a ${scope ? `--session ${shq(scope)} ` : ''}${shq(target)} -y   (wake it, then bring it to the front)`;
        throw err;
      }
      if (!(await wakeForAttach(err, { target, scope, yes }))) return;
      return cmdAttach([target, ...(scope ? ['--session', scope] : []), ...(print ? ['--print'] : [])], { picked: true, woke: true });
    }
    if (stopped && err instanceof TargetError && (err.code === 'inexact' || (err.code === 'not-found' && !err.wake && !/prunable worktree/.test(err.message)))) {
      return startStoppedSession(stopped, { dry, print, yes });
    }
    if (!picked && !dry && !print && err instanceof TargetError && err.code === 'ambiguous' && err.choices?.length > 0 && pickerAvailable()) {
      const choice = await askWhich(err);
      if (choice) return cmdAttach(choice.args, { picked: true });
      return;
    }
    // Ambiguity or a target with no pane is a real answer; only "no such target"
    // falls back to the session match that `a` has always done.
    if (!(err instanceof TargetError) || err.code !== 'not-found' || /has no open herdr space|prunable worktree/.test(err.message)) throw err;
    const match = resolveSession(known, target);
    if (dry) { console.log(`  session ${match.session} (${match.status}) — would attach: ${attachArgv(match).join(' ')}`); return; }
    return attachSession(match, target, print);
  }

  const session = known.find(s => s.session === plan.session) ?? { session: plan.session, status: 'active' };
  const attachLine = attachArgv(session).join(' ');
  if (dry) { console.log(describeFocus(plan, attachLine).join('\n')); return; }
  // --print never acts, wherever it runs. Outside herdr it is the attach command; inside
  // herdr there is no herdr CLI for "focus this pane", so it is the maw command that
  // does it. (It used to fall through to focusPane inside herdr — seen live, 2026-10-02.)
  if (print) {
    console.log(plan.where === 'away' ? attachLine : `maw herdr a --session ${shq(plan.session)} ${plan.pane}`);
    return;
  }

  await focusPane(plan.session, plan.pane);
  const name = `${plan.r.label} (${plan.pane}${plan.r.agent ? ` · ${plan.r.agent}` : ''})`;
  if (plan.where === 'here') { console.log(`  focused ${name}`); return; }
  if (plan.where === 'other') {
    console.log(`  focused ${name} in session '${plan.session}'; this client shows another session. Switch with:\n  ${attachLine}`);
    return;
  }
  console.log(`  focused ${name} — attaching session '${plan.session}'`);
  runAttach(attachArgv(session));
}

// --- federation -------------------------------------------------------------

/**
 * The federation map.
 *
 * Everything here comes from a herdr-federation node over HTTP — the sibling
 * service, one per machine, whose only dependency is the herdr socket. It is the
 * only thing on a machine that knows about OTHER machines: herdr itself has no
 * remote RPC (`herdr --remote` is launch-only), so a plugin talking to the local
 * socket can never see past this host. The node already syncs every peer's pane
 * roster, which is what makes a map possible at all.
 *
 * Reciprocity is the point. "We joined them" and "they joined us" are separate
 * facts in this design — enforcement is local-only, so a kick binds one side —
 * and a map that drew a single undirected line between two nodes would hide
 * exactly the state a person needs to see.
 */
const FED_URL = process.env.HERDR_FED_URL || "http://127.0.0.1:6750";

async function fedPost(path, body, timeout = 20_000) {
  const res = await fetch(`${FED_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const out = await res.json();
  if (out?.error) throw new Error(out.error);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return out;
}

async function fedGet(path, timeout = 5000) {
  const res = await fetch(`${FED_URL}${path}`, { signal: AbortSignal.timeout(timeout) });
  const body = await res.json();
  if (body?.error) throw new Error(body.error);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return body;
}

/**
 * Every agent pane on every node this federation node can reach — its own, its
 * peers', and, since the hub model, whatever its peers relay. One shape whether
 * a pane is local, one hop away, or behind a hub; `via` says which.
 *
 * This is the only listing that does NOT go through the local herdr socket:
 * `ls --agents` asks herdr directly and can only ever see this machine.
 */
async function fleetRoster() {
  const status = await fedGet('/api/status');
  const relayed = status.relayed ?? {};
  const rows = [];
  for (const m of status.members ?? []) rows.push({ ...m, node: status.node, via: null, local: true });
  for (const [node, list] of Object.entries(status.peerMembers ?? {}))
    for (const m of list ?? []) rows.push({ ...m, node, via: relayed[node]?.via ?? null, local: false });
  // Nodes come from `peers`, NOT from the rows: a node with zero panes has no
  // rows, and deriving the list from rows made it vanish from the listing
  // entirely — which reads as "that machine is gone" when it is federated and
  // healthy and simply running no agents. Measured on black.
  const nodes = [status.node, ...(status.peers ?? []).map(p => p.name)];
  const health = Object.fromEntries((status.peers ?? []).map(p => [p.name, p]));
  return { node: status.node, rows, relayed, nodes: [...new Set(nodes)], health };
}

/**
 * `<node>:<target>` — an address on another machine, or null when it is not one.
 *
 * The colon is only a NODE address when the part before it names a node the
 * federation knows. Herdr pane ids are colon-shaped too (`w2V:p1`), so an
 * unconditional split would read `w2V` as a node and break every local call.
 *
 * Shared by peek and hey deliberately. They had separate answers to "is this a
 * node address" — peek had this branch and hey had none, so `peek m5:w4:p1`
 * crossed machines while `hey m5:w4:p1` silently resolved against the local
 * roster and reported "no agent". One resolver means that cannot recur.
 */
async function resolveFleetTarget(raw) {
  if (!raw || !raw.includes(':')) return null;
  const [maybeNode, ...rest] = raw.split(':');
  const target = rest.join(':');
  if (!target) return null;
  let fleet = null;
  try { fleet = await fleetRoster(); } catch { return null; }   // no node here — caller falls back to local
  if (maybeNode !== fleet.node && !fleet.rows.some(r => r.node === maybeNode)) return null;
  const known = fleet.rows.find(r => r.node === maybeNode && (r.pane === target || r.handle === target));
  return { fleet, node: maybeNode, target, pane: known?.pane ?? target, handle: known?.handle ?? null, via: fleet.relayed[maybeNode]?.via ?? null };
}

/** A pane is something to talk to only if herdr found an agent in it. */
const isAgent = m => m.kind && m.kind !== 'shell';

const AGO_UNITS = [[86400, "d"], [3600, "h"], [60, "m"]];
function ago(iso) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "never";
  for (const [size, tag] of AGO_UNITS) if (s >= size) return `${Math.round(s / size)}${tag} ago`;
  return `${Math.max(s, 0)}s ago`;
}

function healthOf(peer) {
  const fails = peer.consecutive ?? 0;
  if (fails === 0 && peer.ok) return { dot: `${C.green}●${C.off}`, note: `seen ${ago(peer.lastSeen)}` };
  if (fails === 0) return { dot: `${C.dim}○${C.off}`, note: "not contacted yet" };
  return { dot: `${C.red}○${C.off}`, note: `${fails} failed since ${ago(peer.lastOkAt)} · ${(peer.lastError || "unreachable").slice(0, 40)}` };
}

async function cmdFederation(args) {
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  if (rest.length) throw new UsageError(`unknown argument: ${rest[0]}`);

  let status, admin;
  try {
    [status, admin] = await Promise.all([fedGet("/api/status"), fedGet("/api/admin").catch(() => null)]);
  } catch (err) {
    throw new Error(`no federation node at ${FED_URL} — ${String(err).replace(/^Error:\s*/, "")}\n  start one: cd <herdr-federation> && just node start\n  or point at another: HERDR_FED_URL=http://host:6750 maw herdr federation`);
  }

  const self = status.node;
  const peers = status.peers ?? [];
  const peerMembers = status.peerMembers ?? {};
  const mesh = admin?.meshMembers ?? {};
  const weJoined = new Set((admin?.members ?? []).map((m) => m.node));
  const heardOnly = (status.known ?? []).filter((k) => !peers.some((p) => p.name === k.node));

  // An edge is two facts, not one: whether WE hold them as a member, and whether
  // THEY report holding us. Only both make it mutual.
  // A node we see only through a hub is not our edge: no reciprocity to judge,
  // nothing to hold or be held by. It is listed under its hub instead.
  const relayed = peers.filter((p) => p.via);
  const direct = peers.filter((p) => !p.via);

  const edges = direct.map((p) => {
    // What a peer reports about itself only arrived on the last SUCCESSFUL pull.
    // While the link is failing that cache keeps answering, and it will happily
    // claim a mutual edge to a node that has kicked us — measured: after m5
    // kicked white, white still drew "⇄ m5 · m5 federates with white" while every
    // pull returned 401. A map that asserts stale state as current is worse than
    // one that shows nothing, so staleness is carried on the edge.
    const stale = (p.consecutive ?? 0) > 0;
    const theyJoined = (mesh[p.name] ?? []).some((m) => m.node === self);
    const ours = weJoined.has(p.name);
    const mutual = ours && theyJoined && !stale;
    return {
      peer: p.name,
      url: p.url,
      ours,
      theirs: theyJoined,
      stale,
      arrow: stale ? "⇠⇢" : mutual ? "⇄" : ours ? "→" : theyJoined ? "←" : "··",
      mutual,
      panes: (peerMembers[p.name] ?? []).length,
      health: p,
    };
  });

  if (json) {
    console.log(JSON.stringify({
      command: "federation", scope: "herdr", json: true, node: self,
      url: FED_URL, identity: status.identity ?? null,
      panes: (status.members ?? []).length,
      edges: edges.map(({ health, ...e }) => ({ ...e, ok: health.ok ?? null, consecutive: health.consecutive ?? null, lastSeen: health.lastSeen ?? null })),
      heardOnly: heardOnly.map((k) => ({ node: k.node, url: k.url ?? null, lastHeard: k.lastHeard })),
      relayed: relayed.map((p) => ({ node: p.name, via: p.via, panes: (peerMembers[p.name] ?? []).length, ok: p.ok ?? null, consecutive: p.consecutive ?? null, lastOkAt: p.lastOkAt ?? null })),
      invites: (admin?.invites ?? []).filter((i) => i.status === "active").length,
      bans: (admin?.bans ?? []).length,
    }));
    return;
  }

  const key = status.identity?.fingerprint ? ` ${C.dim}key ${status.identity.fingerprint}${C.off}` : "";
  console.log(`  ${C.blue}federation${C.off} · ${C.cyan}${self}${C.off}${key}  ${C.dim}${FED_URL}${C.off}`);
  console.log();

  const mine = (status.members ?? []).length;
  console.log(`  ${C.green}●${C.off} ${C.cyan}${self}${C.off}  ${C.dim}${plural(mine, "pane")} · this node${C.off}`);

  // Only when there is genuinely nothing: a node we have heard from but never
  // joined is still something, and printing "no peers" above it contradicted
  // the very next line.
  if (!edges.length && !heardOnly.length) {
    console.log(`  ${C.dim}no peers — create an invite and send the link:${C.off}`);
    console.log(`  ${C.dim}  cd <herdr-federation> && just fed invite${C.off}`);
  }
  edges.forEach((e, i) => {
    const last = i === edges.length - 1 && !heardOnly.length;
    const { dot, note } = healthOf(e.health);
    console.log(`  ${C.dim}${last ? "└─" : "├─"}${C.off} ${e.arrow} ${dot} ${C.cyan}${e.peer}${C.off}  ${C.dim}${plural(e.panes, "pane")} · ${note}${C.off}`);
    const lead = last ? " " : `${C.dim}│${C.off}`;
    console.log(`  ${lead}    ${C.dim}${e.url}${C.off}`);
    // what this hub lets us see — one hop, no edge of ours
    const through = relayed.filter((r) => r.via === e.peer);
    through.forEach((r, j) => {
      const rl = j === through.length - 1;
      const fails = r.consecutive ?? 0;
      const rd = fails === 0 ? `${C.green}●${C.off}` : `${C.red}○${C.off}`;
      const rn = fails === 0 ? `hub reached it ${ago(r.lastOkAt)}` : `hub: ${fails} failed since ${ago(r.lastOkAt)}`;
      console.log(`  ${lead}    ${C.dim}${rl ? "└─" : "├─"}${C.off} ${C.dim}◌${C.off} ${rd} ${C.cyan}${r.name}${C.off}  ${C.dim}${plural((peerMembers[r.name] ?? []).length, "pane")} · via ${e.peer} · ${rn}${C.off}`);
    });
    // The asymmetry is the finding, so it is stated rather than implied by a glyph.
    if (e.stale) {
      console.log(`  ${lead}    ${C.warnTag}stale${C.off} ${C.dim}— everything below came from the last successful pull, ${ago(e.health.lastOkAt)}; ${e.peer} may have dropped us since${C.off}`);
    } else if (!e.mutual) {
      const why = e.ours
        ? `we hold ${e.peer} as a member; ${e.peer} does not report holding us`
        : e.theirs
          ? `${e.peer} reports holding us; we do not hold them — they can reach us, we cannot act on them`
          : `neither side reports the other as a member`;
      console.log(`  ${lead}    ${C.red}one-way${C.off} ${C.dim}— ${why}${C.off}`);
    }
  });

  heardOnly.forEach((k, i) => {
    const last = i === heardOnly.length - 1;
    console.log(`  ${C.dim}${last ? "└─" : "├─"}${C.off} ·· ${C.dim}○${C.off} ${k.node}  ${C.dim}heard ${ago(k.lastHeard)}, never joined${C.off}`);
    if (k.url) console.log(`  ${last ? " " : `${C.dim}│${C.off}`}    ${C.dim}${k.url}${C.off}`);
  });

  // What the mesh says about itself, kept apart from what WE federate with —
  // the service enforces locally, so merging the two would claim an authority
  // this node does not have.
  const reported = Object.entries(mesh).filter(([, v]) => (v ?? []).length);
  if (reported.length) {
    const stalePeers = new Set(edges.filter((e) => e.stale).map((e) => e.peer));
    console.log();
    console.log(`  ${C.dim}elsewhere in the mesh — what peers report, read-only${C.off}`);
    for (const [peer, list] of reported) {
      const mark = stalePeers.has(peer) ? ` ${C.warnTag}(stale)${C.off}` : "";
      console.log(`    ${peer}${mark} ${C.dim}federates with${C.off} ${list.map((m) => m.node).join(", ")}`);
    }
  }

  if (admin) {
    const live = (admin.invites ?? []).filter((i) => i.status === "active").length;
    console.log();
    console.log(`  ${C.dim}${plural(live, "live invite")} · ${plural((admin.bans ?? []).length, "ban")} · ${plural((admin.audit ?? []).length, "entry")} in the audit${C.off}`);
  }
  const mutual = edges.filter((e) => e.mutual).length;
  const stale = edges.filter((e) => e.stale).length;
  const staleNote = stale ? ` · ${C.warnTag}${stale} stale${C.off}` : "";
  console.log(`  ${C.dim}${mutual}/${edges.length} link${edges.length === 1 ? "" : "s"} mutual${C.off}${staleNote}${C.dim} · panes elsewhere: ${edges.reduce((n, e) => n + e.panes, 0)}${C.off}`);
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
  const dryRun = takeDry(args);
  // `<node>:<target>` — deliver on another machine, through the federation.
  // Same resolver peek uses, so the two can never disagree about what a colon
  // means. Routing is the node's job: a direct peer gets an authenticated
  // /api/fed/hey, a node behind a hub goes through that hub's /api/fed/relay.
  const fleetHit = await resolveFleetTarget(args[0]);
  if (fleetHit) {
    args.shift();
    const msg = args.join(' ').trim();
    if (!msg) throw new UsageError(`hey needs a message: maw herdr hey ${fleetHit.node}:${fleetHit.target} "<message>"`);
    const label = `${C.cyan}${fleetHit.node}${C.off}${fleetHit.via ? ` ${C.dim}via ${fleetHit.via}${C.off}` : ''} ${C.dim}${fleetHit.pane}${fleetHit.handle ? ` · ${fleetHit.handle}` : ''}${C.off}`;
    if (dryRun) {
      console.log(`  ${label}`);
      console.log(`  ${C.dim}would POST ${FED_URL}/api/fleet/hey ${JSON.stringify({ node: fleetHit.node, to: fleetHit.pane, text: msg })}${C.off}`);
      console.log(`  ${C.dim}nothing was sent${C.off}`);
      return;
    }
    const out = await fedPost('/api/fleet/hey', { node: fleetHit.node, to: fleetHit.pane, text: msg });
    console.log(`  ${label}`);
    console.log(`  sent ${C.dim}(delivered ${out.delivered}${out.to ? ` to ${out.to}` : ''})${C.off}`);
    console.log(`  read it back: maw herdr peek ${fleetHit.node}:${fleetHit.pane}`);
    return;
  }

  const { pool, verb } = await poolFor(args, 'hey');
  const target = args.shift();
  if (!target) throw new UsageError('hey needs a target and a message: maw herdr hey <target> <message>\n  across the federation: maw herdr hey <node>:<pane> "…"');
  // Everything after the target is the message, unquoted included — `maw hey`
  // behaves this way and retyping quotes for a sentence is friction nobody wants.
  const message = args.join(' ').trim();
  if (!message) throw new UsageError(`hey needs a message: maw herdr hey ${target} "<message>"`);

  const hit = resolveAgent(pool, target, verb, { message });
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
  const dry = takeDry(rest);
  let lines = 40;
  const at = rest.indexOf('--lines');
  if (at !== -1) {
    lines = Number(rest[at + 1]);
    if (!Number.isInteger(lines) || lines < 1) throw new UsageError('--lines needs a positive integer');
    rest.splice(at, 2);
  }
  const fleetHit = await resolveFleetTarget(rest[0]);
  if (fleetHit) {
    rest.shift();
    if (rest.length) throw new UsageError(`unknown argument: ${rest[0]}`);
    if (dry) {
      console.log(`  ${C.cyan}${fleetHit.node}${C.off}${fleetHit.via ? ` ${C.dim}via ${fleetHit.via}${C.off}` : ''} ${C.dim}${fleetHit.pane}${fleetHit.handle ? ` · ${fleetHit.handle}` : ''}${C.off}`);
      console.log(`  ${C.dim}would POST ${FED_URL}/api/fleet/pane ${JSON.stringify({ node: fleetHit.node, pane: fleetHit.pane, lines })}${C.off}`);
      console.log(`  ${C.dim}nothing was read${C.off}`);
      return;
    }
    const out = await fedPost('/api/fleet/pane', { node: fleetHit.node, pane: fleetHit.pane, lines });
    if (json) {
      console.log(JSON.stringify({ command: 'peek', node: out.node, pane: out.pane, via: fleetHit.via, source: 'visible', lines: out.lines, text: out.text }));
      return;
    }
    console.log(`  ${C.cyan}${out.node}${C.off}${fleetHit.via ? ` ${C.dim}via ${fleetHit.via}${C.off}` : ''} ${C.dim}${out.pane}${fleetHit.handle ? ` · ${fleetHit.handle}` : ''} · last ${out.lines} lines${C.off}`);
    console.log();
    console.log(out.text);
    return;
  }

  const { pool, verb } = await poolFor(rest, 'peek');
  const target = rest.shift();
  if (!target) throw new UsageError('peek needs a target: maw herdr peek <target> [--lines N]\n  across the federation: maw herdr peek <node>:<pane>');
  if (rest.length) throw new UsageError(`unknown argument: ${rest[0]}`);

  const hit = resolveAgent(pool, target, verb);
  if (dry) {
    if (json) {
      console.log(JSON.stringify({ command: 'peek', dry: true, pane: hit.pane, session: hit.session, workspace: hit.workspace, agent: hit.agent, status: hit.status, how: hit.how }));
      return;
    }
    console.log(`  ${statusDot(hit.status)} ${C.cyan}${label(hit)}${C.off} ${C.dim}${hit.pane} · ${hit.agent} · ${hit.status} · ${hit.session}${C.off}`);
    console.log(`  ${C.dim}would run:${C.off} herdr --session ${hit.session} pane read ${hit.pane} --source visible --lines ${lines} --format text`);
    console.log(`  ${C.dim}matched by ${hit.how} · nothing was read${C.off}`);
    return;
  }

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
    else if (arg === '--dry-run' || arg === '--dry') opts.dryRun = true;
    else if (arg === '--own-session') opts.ownSession = true;
    else if (arg.startsWith('-')) throw new UsageError(`unknown argument: ${arg}`);
    else if (target === undefined) target = arg;
    else throw new UsageError(`unexpected argument: ${arg}`);
  }
  if (!target) throw new UsageError('wake needs an oracle: maw herdr wake <oracle> [--engine <kind>] [--prompt <text>] [--attach] [--dry-run]');
  // an engine is a herdr agent kind; one that looks like a flag is a missing value
  if (!opts.engine || opts.engine.startsWith('-')) throw new UsageError('--engine needs a value (herdr agent kind, e.g. claude, codex, gemini)');

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
  else if (wantsHelp(command, args)) console.log(HELP);
  else if (command === 'serve') process.exitCode = await runServe(args);
  else if (command === 'ticket') process.exitCode = cmdTicket(args);
  else if (command === 'ls' || command === 'list') await cmdLs(args);
  else if (command === 'a' || command === 'attach') await cmdAttach(args);
  else if (command === 'wake') cmdWake(args);
  else if (command === 'work') await cmdWork(args, { UsageError, runAttach });
  else if (command === 'wt') await cmdWt(args, { UsageError });
  else if (command === 'handover') await cmdHandover(args, { UsageError });
  else if (command === 'hey') await cmdHey(args);
  else if (command === 'peek' || command === 'read') await cmdPeek(args);
  else if (command === 'federation' || command === 'fed') await cmdFederation(args);
  else if (command === 'resolve') await cmdResolve(args, { UsageError });
  else if (command === 'restart') await cmdRestart(args, { UsageError });
  else if (command === 'resume') await cmdResume(args, { UsageError });
  else if (command === 'restore') await cmdRestore(args, { UsageError });
  else if (command === 'kill') await cmdKill(args, { UsageError });
  else if (command === 'close') await cmdClose(args, { UsageError });
  else if (command === 'join' || command === 'here') await cmdJoin(args, { UsageError, roster });
  else if (command === 'break' || command === 'back') await cmdBreak(args, { UsageError, roster });
  else if (command === 'layout') await cmdLayout(args, { UsageError });
  else if (command === 'whoami') await cmdWhoami(args, { UsageError });
  else if (command === 'watch') await cmdWatch(args, { UsageError, entry: fileURLToPath(import.meta.url) });
  else if (command === 'inbox') await cmdInbox(args, { UsageError });
  else if (command === 'reply') await cmdReply(args, { UsageError });
  else if (command === '__watch-run') process.exit(await runWatcher(args[0]));   // spawned by watch, detached; exits when the watch ends
  else if (command === 'audit') process.exitCode = await cmdAudit(args, { UsageError, registryRoot: readOracleRegistry().ghqRoot });
  else if (command === 'clean') process.exitCode = await cmdClean(args, { UsageError, registryRoot: readOracleRegistry().ghqRoot });
  else if (command === 'sync') process.exitCode = await cmdSync(args, { UsageError, registryRoot: readOracleRegistry().ghqRoot });
  else throw new UsageError(`unknown command: ${command}\n  maw herdr help`);
} catch (err) {
  // A usage error with no fix line of its own gets the one that now always works.
  const fix = err instanceof UsageError && !err.message.includes('\n') ? `\n  maw herdr ${command} --help` : '';
  console.error(`maw herdr: ${err.message}${fix}`);
  process.exitCode = err instanceof UsageError ? 2 : 1;
}
