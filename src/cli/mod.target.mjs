/**
 * The target grammar: one resolver for every `maw herdr` verb that takes a <target>.
 *
 *   form            example                  meaning
 *   ─────────────   ──────────────────────   ─────────────────────────────────────────────
 *   self (default)  self                     the herdr pane this command runs in
 *   path            /abs/path  .  ../x  ~/x  a worktree path (or a directory inside one)
 *   pane            w5D:p1                   a herdr pane id
 *   name            digger-oracle            exact label → a repo's main worktree → unique substring
 *
 * An ambiguous target LISTS its candidates and throws; nothing is ever picked
 * for the caller. A verb given `--dry` prints the resolution and does nothing.
 *
 * "self" comes from the environment herdr gives every pane it hosts:
 * HERDR_PANE_ID (w4B:p1) names the pane, HERDR_SOCKET_PATH names the server —
 * ~/.config/herdr/herdr.sock is the `default` session, and
 * ~/.config/herdr/sessions/<name>/herdr.sock is session <name>. Pane ids are only
 * unique within one session, so the socket is what makes "self" exact.
 *
 * ── API (what #62 lifecycle, #63 watch/inbox and #64 audit/clean/sync build on) ──
 *
 *   classifyTarget(raw)                    → { form: 'self'|'path'|'pane'|'name', value }
 *   callerFromEnv(env = process.env)       → { pane, session|null } | null
 *   takeDry(args)                          → boolean; strips every --dry / --dry-run from args
 *   loadTargets({ session, cwd, paths, roots, ghq }) → Promise<Target[]>   (read-only)
 *   resolveTarget(targets, raw, { verb, caller, cwd, after }) → Resolved   (worktree grammar)
 *   resolveLive(raw, { session, verb, caller, cwd, after }) → Promise<Resolved>
 *                                          = loadTargets + resolveTarget in one call
 *   requirePane(resolved, verb)            → pane id, or throws a TargetError that lists choices
 *   describeResolved(resolved)             → string[]  the lines a `--dry` prints
 *   resolveAgent(pool, target, verb, opts) → roster row + { how }   (hey/peek grammar, legacy text)
 *   pickTier(items, tiers, { narrow, ambiguous }) → { hit, how } | null   the shared tier engine
 *   narrow(hits)                           → { pick, why } | null   focused pane, then active tab
 *   label(agentRow)                        → "workspace" or "workspace/tab"
 *   TargetError                            → Error with .code 'ambiguous'|'not-found'|'no-self'|'empty'
 *                                            and .candidates (the rows it could not choose between)
 *   cmdResolve(args, { UsageError })       → the `maw herdr resolve` verb
 *
 *   Target = {
 *     kind: 'worktree' | 'space',   // 'space' = a herdr workspace with no git worktree of its own
 *     label,                        // the workspace label when open, else the directory name
 *     name,                         // the directory name (basename of path); a space's label
 *     path,                         // realpath of the checkout; a plain space uses its first pane's cwd
 *     repo, repoRoot, linked, branch, prunable,
 *     state: 'running' | 'open' | 'closed',   // running = at least one agent pane
 *     session, workspace, spaceNumber, spaceStatus, activeTab,   // null when closed
 *     panes: [{ pane, agent, name, status, focused, tab, cwd }],  // [] when closed
 *   }
 *   Resolved = Target & {
 *     form, how,                    // which grammar form, and which tier matched
 *     pane,                         // the chosen pane id, or null (closed, or several agents)
 *     agent, status,                // of the chosen pane (status falls back to the space's)
 *     paneChoices,                  // agent pane ids when several and none could be chosen
 *   }
 *
 * The herdr binary is always `herdr` from PATH, exactly like index.mjs, and never
 * HERDR_BIN_PATH: herdr exports that variable into every pane with the path to the
 * REAL binary, so honouring it would let a test run inside a pane walk straight past
 * the fake herdr it put first on PATH and act on the live machine.
 */
import { execFile } from 'node:child_process';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', off: '\x1b[0m' }
  : { dim: '', cyan: '', green: '', red: '', off: '' };

export class TargetError extends Error {
  constructor(message, code, candidates = []) {
    super(message);
    this.code = code;
    this.candidates = candidates;
  }
}

// herdr allocates pane ids past nine with letters (wD:pS), never only digits.
const PANE_ID = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/;

// --- grammar ------------------------------------------------------------------

/** Which form a raw target is. No target at all means `self`. */
export function classifyTarget(raw) {
  const t = (raw ?? '').trim();
  if (t === '' || t === 'self') return { form: 'self', value: 'self' };
  if (t === '.' || t === '..' || t === '~' || /^(\/|\.\.?\/|~\/)/.test(t)) return { form: 'path', value: t };
  if (PANE_ID.test(t)) return { form: 'pane', value: t };
  return { form: 'name', value: t };
}

/** The herdr session a pane's socket belongs to, or null when it cannot be told. */
export function sessionFromSocket(socket) {
  if (!socket) return null;
  const named = socket.match(/\/sessions\/([^/]+)\/herdr\.sock$/);
  if (named) return named[1];
  if (/\/herdr\/herdr\.sock$/.test(socket)) return 'default';
  return null;
}

/** Who is asking: the pane this process runs in, from the env herdr sets there. */
export function callerFromEnv(env = process.env) {
  const pane = env.HERDR_PANE_ID;
  if (!pane) return null;
  return { pane, session: sessionFromSocket(env.HERDR_SOCKET_PATH) };
}

/**
 * Strip `--dry` and its long-standing spelling `--dry-run` (hey, wake) from args.
 * Every occurrence goes, so a verb never mistakes one for a positional.
 */
export function takeDry(args) {
  let dry = false;
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === '--dry' || args[i] === '--dry-run') {
      args.splice(i, 1);
      dry = true;
    }
  }
  return dry;
}

const real = p => { try { return realpathSync(p); } catch { return p; } };
const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };
const expandPath = (raw, cwd) => real(resolve(cwd, raw.replace(/^~(?=\/|$)/, homedir())));
const within = (parent, child) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

// --- the tier engine ----------------------------------------------------------

/**
 * The first tier with any hit decides. One hit wins; several are narrowed if the
 * caller can (narrow), otherwise `ambiguous(hits, how)` builds the error that is
 * thrown. No hit in any tier returns null so each grammar words its own miss.
 */
export function pickTier(items, tiers, { narrow: narrowFn, ambiguous } = {}) {
  for (const [how, test] of tiers) {
    const hits = items.filter(test);
    if (hits.length === 1) return { hit: hits[0], how };
    if (hits.length > 1) {
      const narrowed = narrowFn?.(hits);
      if (narrowed) return { hit: narrowed.pick, how: `${how}, ${narrowed.why}` };
      throw ambiguous(hits, how);
    }
  }
  return null;
}

// A workspace commonly holds several agent panes (a split tab, or several tabs),
// so an exact label match is routinely plural. Prefer the pane the operator is
// looking at, then the workspace's own active tab. Anything left is genuinely
// ambiguous and is reported rather than guessed.
export function narrow(hits) {
  const focused = hits.filter(a => a.focused);
  if (focused.length === 1) return { pick: focused[0], why: 'focused pane' };
  const active = hits.filter(a => a.tab && a.tab === a.activeTab);
  if (active.length === 1) return { pick: active[0], why: 'active tab' };
  return null;
}

// A tab keeps its number as its label until someone renames it, and "digger-oracle/1"
// says less than "digger-oracle". Only a real name earns the suffix.
const named = t => t && t !== '' && !/^\d+$/.test(t);
export const label = a => `${a.workspace}${named(a.tabLabel) && a.tabLabel !== a.workspace ? `/${a.tabLabel}` : ''}`;

// --- hey / peek: the agent-pane grammar ----------------------------------------

/**
 * hey and peek address AGENT panes (roster rows from index.mjs), with the tiers
 * they have always had: pane, agent name, workspace, tab, prefix, substring. The
 * error text and exit codes below are relied on and are kept byte-for-byte.
 *
 * The shared grammar adds two forms in front, both of which previously could only
 * ever miss: `self` (this pane) and a path (the agent whose cwd is that worktree).
 */
export function resolveAgent(all, target, verb, { caller = callerFromEnv(), cwd = process.cwd() } = {}) {
  if (!all.length) throw new TargetError('no agent panes in any running herdr session', 'empty');
  const form = classifyTarget(target);
  const tiers = [];
  if (form.form === 'self') {
    const me = selfPane(caller, cwd);
    tiers.push(['self', a => a.pane === me.pane && (!me.session || a.session === me.session)]);
  } else if (form.form === 'path') {
    const p = expandPath(form.value, cwd);
    tiers.push(['path', a => !!a.cwd && real(a.cwd) === p]);
    tiers.push(['path, inside', a => !!a.cwd && within(p, real(a.cwd))]);
  }
  // Pane ids are colon-shaped too (wD:p4), so scoping is a flag, never a prefix.
  tiers.push(
    ['pane', a => a.pane === target],
    ['agent name', a => a.name === target],
    ['workspace', a => a.workspace === target],
    ['tab', a => a.tabLabel === target],
    ['prefix', a => a.workspace.startsWith(target)],
    ['substring', a => a.workspace.includes(target) || (a.name ?? '').includes(target)],
  );
  const picked = pickTier(all, tiers, {
    narrow,
    ambiguous: hits => {
      const lines = hits.map(a => `    ${a.pane.padEnd(8)} ${label(a).padEnd(22)} ${a.agent} (${a.status})`);
      return new TargetError(
        `'${target}' matches ${hits.length} agent panes and none is focused:\n${lines.join('\n')}\n  target one by pane id: maw herdr ${verb} ${hits[0].pane}${verb === 'hey' ? ' "…"' : ''}`,
        'ambiguous', hits,
      );
    },
  });
  if (picked) return { ...picked.hit, how: picked.how };
  if (form.form === 'self') {
    const me = selfPane(caller);
    throw new TargetError(
      `"self" is herdr pane ${me.pane}${me.session ? ` in session ${me.session}` : ''}, and it holds no agent — ${verb} talks to agent panes\n  see the agent panes: maw herdr ls --agents`,
      'not-found',
    );
  }
  const known = [...new Set(all.map(a => a.workspace))].sort();
  throw new TargetError(`no agent '${target}'. workspaces: ${known.join(', ') || '(none)'}\n  see them all: maw herdr ls --agents`, 'not-found');
}

function selfPane(caller, cwd = process.cwd()) {
  if (caller?.pane) return caller;
  throw new TargetError(
    `"self" means the herdr pane this command runs in, and HERDR_PANE_ID is not set here — not inside a herdr pane\n  name the target by path instead: maw herdr resolve ${cwd}`,
    'no-self',
  );
}

// --- worktree targets: loading --------------------------------------------------

function run(file, args, { timeout = 10_000, env } = {}) {
  return new Promise((ok, fail) => {
    execFile(file, args, { encoding: 'utf8', timeout, maxBuffer: 32 << 20, env }, (err, stdout) => (err ? fail(err) : ok(stdout)));
  });
}

const herdrJson = async (args, session) => JSON.parse(await run('herdr', session ? ['--session', session, ...args] : args));
const unwrapSnapshot = raw => raw?.result?.snapshot ?? raw?.snapshot ?? raw?.result ?? raw;

// Repo hooks never run and a caller's GIT_DIR/GIT_WORK_TREE never redirects the
// scan — the same hygiene the server's worktree routes use.
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};

/** Every worktree of the repo `dir` belongs to, main first. [] when dir is no repo. */
async function gitWorktrees(dir) {
  let raw;
  try {
    raw = await run('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', dir, 'worktree', 'list', '--porcelain', '-z'], { timeout: 5_000, env: GIT_ENV });
  } catch {
    return [];
  }
  const records = raw.split('\0\0').map(r => r.split('\0').filter(Boolean)).filter(r => r[0]?.startsWith('worktree '));
  if (!records.length) return [];
  const main = real(records[0][0].slice(9));
  return records
    .filter(r => !r.includes('bare'))
    .map((r, i) => ({
      path: real(r[0].slice(9)),
      branch: r.find(l => l.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? null,
      linked: i > 0,
      prunable: r.some(l => l === 'prunable' || l.startsWith('prunable ')),
      repoRoot: main,
    }));
}

/**
 * Repos that keep worktrees under the fleet's `<repo>/wt/` convention, found by a
 * three-level readdir of the ghq root (host/org/repo) — ~0.3 s for 28 hits on the
 * busiest machine, against 17 s for `ghq list`. Silent when ghq is absent.
 */
async function ghqWorktreeRepos() {
  let root;
  try { root = (await run('ghq', ['root'], { timeout: 3_000 })).trim(); } catch { return []; }
  if (!root || !isDir(root)) return [];
  const ls = d => { try { return readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name); } catch { return []; } };
  const out = [];
  for (const host of ls(root).filter(h => h.includes('.'))) {
    for (const org of ls(join(root, host))) {
      for (const repo of ls(join(root, host, org))) {
        if (isDir(join(root, host, org, repo, 'wt'))) out.push(join(root, host, org, repo));
      }
    }
  }
  return out;
}

/**
 * Everything a target can name, open or not: every workspace in every running
 * herdr session (one Target each), plus every git worktree of the repos those
 * workspaces sit in, the repo of `cwd`, the repos of `paths`, and — unless
 * `ghq: false` — every ghq repo with a `wt/` directory. A worktree with no open
 * space appears once, as state 'closed'. `roots` replaces all repo discovery.
 *
 * Read-only: session list, api snapshot, git worktree list. Nothing else.
 */
export async function loadTargets({ session = null, cwd = process.cwd(), paths = [], roots = null, ghq = true } = {}) {
  let index;
  try {
    index = (await herdrJson(['session', 'list', '--json'])).sessions ?? [];
  } catch (err) {
    const why = String(err?.stderr || err?.message || err).trim().split('\n')[0];
    throw new TargetError(`cannot list herdr sessions — ${why}\n  check herdr answers: herdr session list --json`, 'not-found');
  }
  const running = index.filter(s => s.running).map(s => s.name);
  if (session && !running.includes(session)) {
    const known = index.map(s => `${s.name}${s.running ? '' : ' (stopped)'}`).join(', ') || '(none)';
    throw new TargetError(`no running herdr session '${session}'. known: ${known}\n  see them: maw herdr ls --sessions`, 'not-found');
  }
  const scope = session ? [session] : running;

  const targets = [];
  await Promise.all(scope.map(async s => {
    let snap;
    try { snap = unwrapSnapshot(await herdrJson(['api', 'snapshot'], s)); } catch { return; }
    // The agent's name lives on the AGENT record, not on the pane (see roster()).
    const names = new Map((snap.agents ?? []).filter(a => a.name).map(a => [a.pane_id, a.name]));
    for (const w of snap.workspaces ?? []) {
      const panes = (snap.panes ?? []).filter(p => p.workspace_id === w.workspace_id).map(p => ({
        pane: p.pane_id, agent: p.agent ?? null, name: names.get(p.pane_id) ?? null,
        status: p.agent_status ?? 'unknown', focused: !!p.focused, tab: p.tab_id ?? null, cwd: p.cwd ?? null,
      }));
      const wt = w.worktree;
      const where = wt?.checkout_path ?? panes.find(p => p.cwd)?.cwd ?? null;
      const path = where ? real(where) : `herdr:${s}/${w.workspace_id}`;
      targets.push({
        kind: wt ? 'worktree' : 'space',
        label: w.label ?? w.workspace_id,
        // a plain space's cwd is borrowed from whatever its first pane sits in —
        // often another repo's checkout — so its only honest name is its label
        name: wt && where ? basename(path) : w.label ?? w.workspace_id,
        path,
        repo: wt?.repo_name ?? null,
        repoRoot: wt?.repo_root ? real(wt.repo_root) : null,
        linked: !!wt?.is_linked_worktree,
        branch: null,
        prunable: false,
        state: panes.some(p => p.agent) ? 'running' : 'open',
        session: s,
        workspace: w.workspace_id,
        spaceNumber: w.number ?? null,
        spaceStatus: w.agent_status ?? 'unknown',
        activeTab: w.active_tab_id ?? null,
        panes,
      });
    }
  }));

  let dirs = roots;
  if (!dirs) {
    dirs = [...targets.filter(t => t.kind === 'worktree').map(t => t.repoRoot ?? t.path), cwd, ...paths.map(p => (isDir(p) ? p : dirname(p)))];
    if (ghq) dirs.push(...await ghqWorktreeRepos());
  }
  const unique = [...new Set(dirs.filter(Boolean).map(real))];
  const lists = await Promise.all(unique.map(gitWorktrees));
  const seen = new Map();
  for (const w of lists.flat()) if (!seen.has(w.path)) seen.set(w.path, w);

  for (const w of seen.values()) {
    const open = targets.filter(t => t.kind === 'worktree' && t.path === w.path);
    for (const t of open) Object.assign(t, { branch: w.branch, prunable: w.prunable, repoRoot: t.repoRoot ?? w.repoRoot });
    if (open.length) continue;
    targets.push({
      kind: 'worktree', label: basename(w.path), name: basename(w.path), path: w.path,
      repo: basename(w.repoRoot), repoRoot: w.repoRoot, linked: w.linked, branch: w.branch, prunable: w.prunable,
      state: 'closed', session: null, workspace: null, spaceNumber: null, spaceStatus: null, activeTab: null, panes: [],
    });
  }
  return targets;
}

// --- worktree targets: resolving ------------------------------------------------

/**
 * Resolve a raw target against loaded targets with the worktree grammar. Throws a
 * TargetError when it is ambiguous (listing every candidate as a runnable line) or
 * matches nothing. `verb` and `after` shape the commands printed in those errors:
 * `maw herdr <verb> <candidate><after>`.
 */
export function resolveTarget(targets, raw, { verb = 'resolve', caller = callerFromEnv(), cwd = process.cwd(), after = '' } = {}) {
  const form = classifyTarget(raw);
  const shown = form.value;
  const ambiguous = (hits, how) => new TargetError(
    `'${shown}' matches ${hits.length} worktrees (${how}) — nothing was done. Name one:\n${candidateLines(hits, verb, after, form.form === 'pane' ? form.value : null)}`,
    'ambiguous', hits,
  );
  let tiers;
  if (form.form === 'self') {
    const me = selfPane(caller, cwd);
    tiers = [['self', t => t.panes.some(p => p.pane === me.pane) && (!me.session || t.session === me.session)]];
    const picked = pickTier(targets, tiers, { ambiguous });
    if (!picked) {
      throw new TargetError(
        `"self" is herdr pane ${me.pane}${me.session ? ` in session ${me.session}` : ''}, and no running herdr workspace holds it\n  see what does: maw herdr ls --agents`,
        'not-found',
      );
    }
    return finish(picked.hit, form, picked.how, me.pane);
  }
  if (form.form === 'pane') {
    tiers = [['pane id', t => t.panes.some(p => p.pane === form.value)]];
    const picked = pickTier(targets, tiers, { ambiguous });
    if (!picked) throw new TargetError(`no herdr workspace holds pane ${form.value}\n  see every pane: maw herdr ls --agents`, 'not-found');
    return finish(picked.hit, form, picked.how, form.value);
  }
  if (form.form === 'path') {
    const p = expandPath(form.value, cwd);
    // Deepest first: a linked worktree lives under its repo's main checkout, and
    // `.` from inside it means the linked one. A worktree beats a plain space
    // whose pane merely sits in the same directory, and a plain space matches
    // only its exact directory — its cwd is borrowed, so it claims nothing below.
    const inside = targets.filter(t => t.kind === 'worktree' && within(t.path, p));
    const depth = Math.max(0, ...inside.map(t => t.path.length));
    tiers = [
      ['path', t => t.kind === 'worktree' && t.path === p],
      ['path', t => t.kind === 'space' && t.path === p],
      ['path, inside', t => t.kind === 'worktree' && within(t.path, p) && t.path.length === depth],
    ];
    const picked = pickTier(targets, tiers, { ambiguous });
    if (!picked) {
      throw new TargetError(
        `no worktree at ${p}, nor one containing it\n  see every worktree it knows: maw herdr resolve --list`,
        'not-found',
      );
    }
    return finish(picked.hit, form, picked.how, null);
  }
  const q = form.value.toLowerCase();
  const lc = s => (s ?? '').toLowerCase();
  tiers = [
    ['exact label', t => lc(t.label) === q || lc(t.name) === q],
    ['repo main worktree', t => t.kind === 'worktree' && !t.linked && lc(t.repo) === q],
    ['substring', t => lc(t.label).includes(q) || lc(t.name).includes(q)],
  ];
  const picked = pickTier(targets, tiers, { ambiguous });
  if (!picked) {
    throw new TargetError(
      `no worktree matches '${form.value}' (searched ${targets.length})\n  see every worktree it knows: maw herdr resolve --list`,
      'not-found',
    );
  }
  return finish(picked.hit, form, picked.how, null);
}

/** loadTargets + resolveTarget, with the target's own path added to discovery. */
export async function resolveLive(raw, { session = null, cwd = process.cwd(), ...opts } = {}) {
  const form = classifyTarget(raw);
  const paths = form.form === 'path' ? [expandPath(form.value, cwd)] : [];
  const targets = await loadTargets({ session, cwd, paths });
  return resolveTarget(targets, raw, { cwd, ...opts });
}

// Which pane a verb acts on. An explicit pane (self, a pane id) is honoured as
// given; otherwise the sole agent pane, else the focused / active-tab one, else —
// with no agent at all — the first shell pane. Several agents that none of that
// separates leave `pane` null with `paneChoices` set, for requirePane to report.
function finish(t, form, how, explicitPane) {
  let chosen = explicitPane ? t.panes.find(p => p.pane === explicitPane) : null;
  let paneChoices = null;
  if (!chosen) {
    const agents = t.panes.filter(p => p.agent);
    if (agents.length === 1) chosen = agents[0];
    else if (agents.length > 1) {
      const n = narrow(agents.map(p => ({ ...p, activeTab: t.activeTab })));
      if (n) chosen = n.pick;
      else paneChoices = agents.map(p => p.pane);
    } else chosen = t.panes[0] ?? null;
  }
  return {
    ...t, form: form.form, how,
    pane: chosen?.pane ?? null,
    agent: chosen?.agent ?? null,
    status: chosen?.agent ? chosen.status : t.spaceStatus,
    paneChoices,
  };
}

/** The pane to act on, or a TargetError saying why there is none and what to type. */
export function requirePane(r, verb) {
  if (r.pane) return r.pane;
  if (r.paneChoices?.length) {
    const scope = r.session ? `--session ${r.session} ` : '';
    throw new TargetError(
      `'${r.label}' has ${r.paneChoices.length} agent panes and none is focused — nothing was done. Name one:\n${r.paneChoices.map(p => `  maw herdr ${verb} ${scope}${p}`).join('\n')}`,
      'ambiguous', r.paneChoices,
    );
  }
  throw new TargetError(
    `'${r.label}' has no open herdr space, so there is no pane to act on\n  open one: herdr workspace create --cwd ${r.path} --label ${r.label} --no-focus`,
    'not-found',
  );
}

// Each candidate as its own runnable line, addressed by the most specific handle
// that is unique among them: its path, or — when one worktree is open in two
// sessions, or the target was a pane id held in two sessions — its pane scoped
// by session.
function candidateLines(hits, verb, after, paneId = null) {
  const pathCount = new Map();
  for (const h of hits) pathCount.set(h.path, (pathCount.get(h.path) ?? 0) + 1);
  const rows = hits.slice(0, 15).map(h => {
    const firstPane = paneId ?? h.panes.find(p => p.agent)?.pane ?? h.panes[0]?.pane;
    const handle = !paneId && (pathCount.get(h.path) === 1 || !firstPane) ? h.path : `--session ${h.session} ${firstPane}`;
    const note = [h.state, h.session, firstPane].filter(Boolean).join(' · ');
    return { cmd: `  maw herdr ${verb} ${handle}${after}`, note };
  });
  const wide = Math.max(...rows.map(r => r.cmd.length));
  const lines = rows.map(r => `${r.cmd.padEnd(wide)}   # ${r.note}`);
  if (hits.length > 15) lines.push(`  … and ${hits.length - 15} more; see them all: maw herdr resolve --list`);
  return lines.join('\n');
}

const dot = status => (status === 'working' ? `${C.green}●${C.off}` : status === 'blocked' ? `${C.red}●${C.off}` : `${C.dim}○${C.off}`);

/** What a `--dry` prints: what the target resolved to, and how. */
export function describeResolved(r) {
  const where = r.pane ? `${r.pane}${r.agent ? ` · ${r.agent}` : ' · shell'} · ${r.status ?? 'unknown'} · ${r.session}` : r.paneChoices ? `${r.paneChoices.length} agent panes · ${r.session}` : 'no open space';
  const repo = r.kind === 'space' ? 'no git worktree (a plain herdr space)' : `${r.repo ?? '?'} · ${r.linked ? 'linked worktree' : 'main worktree'}${r.branch ? ` · branch ${r.branch}` : ''}${r.prunable ? ' · prunable (directory gone)' : ''}`;
  return [
    `  ${dot(r.status)} ${C.cyan}${r.label}${C.off}  ${C.dim}${where}${C.off}`,
    `    ${C.dim}path${C.off}   ${r.path}`,
    `    ${C.dim}repo${C.off}   ${repo}`,
    `    ${C.dim}state${C.off}  ${r.state} · matched by ${r.how}`,
  ];
}

// --- the `resolve` verb ---------------------------------------------------------

const RESOLVE_USAGE = 'maw herdr resolve [<target>] [--session <name>] [--json]\n  every target it knows: maw herdr resolve --list';

/** `maw herdr resolve [<target>]` — print what a target resolves to. Never acts. */
export async function cmdResolve(args, { UsageError = Error } = {}) {
  const rest = [...args];
  takeDry(rest);                        // resolve never acts, so --dry changes nothing
  const json = rest.includes('--json');
  const list = rest.includes('--list');
  let session = null;
  const at = rest.indexOf('--session');
  if (at !== -1) {
    session = rest[at + 1];
    if (!session || session.startsWith('-')) throw new UsageError(`--session needs a name\n  ${RESOLVE_USAGE}`);
    rest.splice(at, 2);
  }
  const positional = rest.filter(a => a !== '--json' && a !== '--list');
  const unknown = positional.find(a => a.startsWith('-'));
  if (unknown) throw new UsageError(`unknown argument: ${unknown}\n  ${RESOLVE_USAGE}`);
  if (positional.length > 1) throw new UsageError(`resolve takes one target, got ${positional.length}\n  ${RESOLVE_USAGE}`);

  if (list) {
    if (positional.length) throw new UsageError(`--list takes no target\n  maw herdr resolve --list`);
    const targets = await loadTargets({ session });
    if (json) {
      console.log(JSON.stringify({ command: 'resolve', mode: 'list', json: true, targets }));
      return;
    }
    const wide = Math.max(8, ...targets.map(t => t.label.length));
    for (const t of targets) {
      const pane = t.panes.find(p => p.agent)?.pane ?? t.panes[0]?.pane ?? '';
      console.log(`  ${t.state.padEnd(8)} ${t.label.padEnd(wide)} ${pane.padEnd(8)} ${C.dim}${t.path}${C.off}`);
    }
    console.log(`  ${C.dim}${targets.length} targets · resolve one: maw herdr resolve <name|path|pane>${C.off}`);
    return;
  }

  const raw = positional[0];
  const r = await resolveLive(raw, { session, verb: 'resolve' });
  if (json) {
    console.log(JSON.stringify({ command: 'resolve', json: true, target: classifyTarget(raw).value, resolved: r }));
    return;
  }
  for (const line of describeResolved(r)) console.log(line);
}
