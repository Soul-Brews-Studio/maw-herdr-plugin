/**
 * `maw herdr audit` (#64): where herdr's sidebar and git have drifted apart, and
 * what `clean` and `sync` would do about it. Report only — it never changes
 * anything, so it is the verb to run first and the one that is always safe.
 *
 *   finding   meaning                                           who fixes it
 *   ───────   ───────────────────────────────────────────────   ─────────────────────────
 *   gone      git lists a worktree whose folder is gone         clean, sync
 *   orphan    a herdr space points at a folder that is gone     sync
 *   idle      an idle agent whose transcript is older than      sync --idle-agents
 *             --idle (default 24h), so it can be resumed later
 *   behind    a checkout only behind its upstream: nothing      sync
 *             ahead, so a fast-forward loses nothing
 *   merged    a linked worktree whose HEAD is in the default    clean
 *             branch — or is KEPT, with the reason and the
 *             command that shows why (see keepReasons)
 *
 * Built on #59's target loader (every herdr space in every running session, plus
 * every git worktree of their repos) and #60's state model (a worktree is running,
 * open, resumable or cold; "resumable" and "how long idle" both come from the
 * resume providers, never from a vendor path here).
 *
 * Read-only means read-only: herdr is asked `session list` and `api snapshot`
 * and nothing else; every git call runs with GIT_OPTIONAL_LOCKS=0 (so even
 * `git status` does not rewrite the index), hooks off, and no fetch — "behind"
 * is as of the last fetch, and the report says so.
 */
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { writeJson } from './mod.lsStateView.mjs';
import { configuredProviders, findSessions } from './mod.resumeProviders.mjs';
import { ghqRoots, reposWithWorktrees } from './mod.worktreeStates.mjs';
import { callerFromEnv, loadTargets, resolveTarget, shq, takeDry } from './mod.target.mjs';

export const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', off: '\x1b[0m' }
  : { dim: '', cyan: '', green: '', red: '', yellow: '', off: '' };

// herdr's agent statuses that mean "waiting for a person", not "working".
export const IDLE = new Set(['idle', 'done']);

export const DEFAULT_IDLE_MS = 24 * 3_600_000;
export const DEFAULT_MIN_AGE_DAYS = 3;

// --- git, read-only by default ------------------------------------------------

// A caller's GIT_DIR / GIT_WORK_TREE never redirects a call, repo hooks never run
// (a post-merge hook is arbitrary code), and GIT_OPTIONAL_LOCKS=0 stops `status`
// from refreshing the index as a side effect.
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
};
const GIT_SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotepath=off'];

/** Run a program; never rejects. { ok, code, out, err } */
export function run(file, args, { timeout = 15_000, env } = {}) {
  return new Promise(done => {
    execFile(file, args, { encoding: 'utf8', timeout, maxBuffer: 32 << 20, env }, (e, out, err) => {
      done({ ok: !e, code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, out: out ?? '', err: String(err || e?.message || '').trim() });
    });
  });
}

export const git = (dir, args, opts = {}) => run('git', [...GIT_SAFE, '-C', dir, ...args], { env: GIT_ENV, ...opts });
export const firstLine = s => String(s ?? '').split('\n').map(l => l.trim()).filter(Boolean).pop() ?? '';

/** fn over items, n at a time: a machine with hundreds of worktrees must not start hundreds of gits. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const real = p => { try { return realpathSync(p); } catch { return p; } };
export const within = (parent, child) => !!parent && !!child && (child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep));

// --- durations ------------------------------------------------------------------

/** "90m", "24h", "3d"; a bare number is hours. null when it is none of those. */
export function parseDuration(raw) {
  const m = String(raw ?? '').trim().match(/^(\d+(?:\.\d+)?)([mhd]?)$/);
  if (!m) return null;
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000, '': 3_600_000 }[m[2]];
}

export function fmtAge(ms) {
  if (ms == null) return '?';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  if (min < 48 * 60) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / 1440)}d`;
}

export function fmtBytes(b) {
  if (b >= 1 << 30) return `${(b / 2 ** 30).toFixed(1)} GB`;
  if (b >= 1 << 20) return `${(b / 2 ** 20).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

// --- what a worktree holds that git cannot give back ----------------------------

// Gitignored but rebuildable: removing these with a worktree loses nothing a
// build or an install will not make again.
const REBUILDABLE = /(^|\/)(node_modules|\.venv|venv|__pycache__|target|dist|build|\.next|\.turbo|\.cache|\.parcel-cache|\.gradle|\.pytest_cache|\.mypy_cache|\.ruff_cache|coverage)(\/|$)/;
// OS litter and the per-checkout direnv file: never a reason to keep a worktree.
const JUNK = /(^|\/)(\._[^/]*|\.DS_Store|\.envrc)$/;

/** Bytes under a path, without following symlinks; stops counting after `cap` entries. */
function du(path, budget = { left: 20_000 }) {
  let st;
  try { st = lstatSync(path); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let names = [];
  try { names = readdirSync(path); } catch { return 0; }
  for (const n of names) {
    if (--budget.left < 0) break;
    total += du(join(path, n), budget);
  }
  return total;
}

/**
 * Gitignored content that is not rebuildable. `git worktree remove` deletes
 * ignored files along with the checkout, no status ever shows them, and no
 * commit can bring them back — so ANY such content keeps the worktree.
 * { entries: [{ path, bytes }], bytes } or { error } when git could not say.
 */
export async function ignoredData(path) {
  const r = await git(path, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
  if (!r.ok) return { error: firstLine(r.err) || 'git ls-files failed' };
  const entries = r.out.split('\0').filter(Boolean).map(e => e.replace(/\/$/, ''))
    .filter(e => !REBUILDABLE.test(e) && !JUNK.test(e))
    .map(e => ({ path: e, bytes: du(join(path, e)) }))
    .sort((a, b) => b.bytes - a.bytes);
  return { entries, bytes: entries.reduce((n, e) => n + e.bytes, 0) };
}

/**
 * Uncommitted paths (untracked included), split into real changes and junk.
 * null when git could not say.
 */
export async function uncommitted(path) {
  const r = await git(path, ['status', '--porcelain', '-z', '-uall']);
  if (!r.ok) return null;
  const recs = r.out.split('\0');
  const out = { dirty: [], junk: [] };
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (rec.length < 4) continue;
    if (rec[0] === 'R' || rec[0] === 'C') i++;   // a rename carries its old path next
    const p = rec.slice(3);
    (JUNK.test(p) ? out.junk : out.dirty).push(p);
  }
  return out;
}

// --- loading the world ------------------------------------------------------------

/**
 * herdr sessions whose snapshot does not come back. #59's loader skips such a
 * session quietly, which is right for resolving a name and wrong for cleanup: a
 * worktree whose only space lives in that session would look like it has none.
 * So cleanup asks again and refuses to act when this is not empty.
 */
async function unreadableSessions() {
  const list = await run('herdr', ['session', 'list', '--json']);
  let sessions;
  try { sessions = JSON.parse(list.out).sessions; } catch { return []; }   // loadTargets already threw on this
  if (!Array.isArray(sessions)) return [];
  const out = [];
  await Promise.all(sessions.filter(s => s.running).map(async s => {
    const r = await run('herdr', ['--session', s.name, 'api', 'snapshot']);
    let snap = null;
    try { const raw = JSON.parse(r.out); snap = raw?.result?.snapshot ?? raw?.snapshot ?? raw?.result ?? raw; } catch { /* reported below */ }
    if (!r.ok || !Array.isArray(snap?.workspaces) || !Array.isArray(snap?.panes)) {
      out.push({ session: s.name, reason: r.ok ? 'snapshot has no workspaces/panes arrays' : firstLine(r.err) || 'snapshot failed' });
    }
  }));
  return out.sort((a, b) => a.session.localeCompare(b.session));
}

/**
 * Everything cleanup reasons about, read once:
 *   targets     #59's rows — one per herdr space, one per closed git worktree
 *   trees       one per checkout path: its spaces (in any session), git's view of it
 *   plain       herdr spaces bound to no git worktree
 *   sessions    newest resumable transcript per path (#60 providers)
 *   incomplete  herdr sessions whose snapshot failed
 */
export async function loadWorld({ env = process.env, registryRoot, cwd = process.cwd() } = {}) {
  const providers = configuredProviders(env);   // a bad provider name fails before anything is read
  const repos = reposWithWorktrees(ghqRoots(env, registryRoot));
  const targets = await loadTargets({ cwd, paths: repos, ghq: false });
  const incomplete = await unreadableSessions();

  const trees = new Map();
  const plain = [];
  for (const t of targets) {
    if (t.kind === 'space') { plain.push(t); continue; }
    let w = trees.get(t.path);
    if (!w) {
      w = { path: t.path, label: t.name, repo: t.repo, repoRoot: t.repoRoot, linked: t.linked, branch: t.branch, prunable: t.prunable, spaces: [] };
      trees.set(t.path, w);
    }
    w.repoRoot ??= t.repoRoot;
    w.branch ??= t.branch;
    w.prunable ||= t.prunable;
    w.linked ||= t.linked;
    if (t.state !== 'closed') {
      w.spaces.push(t);
      if (t.label && w.label === t.name) w.label = t.label;
    }
  }

  const aliases = new Map();
  for (const w of trees.values()) aliases.set(w.path, w.path);
  for (const t of targets) for (const p of t.panes) if (p.cwd) aliases.set(p.cwd, real(p.cwd));
  const sessions = findSessions(providers, aliases);
  return { targets, trees: [...trees.values()].sort((a, b) => a.path.localeCompare(b.path)), plain, sessions, providers, incomplete, repos };
}

/** #60's four states, for one tree. */
export function stateOf(w, sessions) {
  if (w.spaces.some(s => s.panes.some(p => p.agent))) return 'running';
  if (w.spaces.length) return 'open';
  return sessions.get(w.path) ? 'resumable' : 'cold';
}

// --- git facts per checkout ---------------------------------------------------------

async function defaultRef(repoRoot) {
  const head = await git(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.out.trim()) return head.out.trim();
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if ((await git(repoRoot, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])).ok) return ref;
  }
  return null;
}

/** Locked worktree paths of one repo, from git's own porcelain. */
async function lockedPaths(repoRoot) {
  const r = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  const out = new Set();
  for (const block of r.out.split(/\n\n+/)) {
    const path = block.match(/^worktree (.*)$/m)?.[1];
    if (path && /^locked( |$)/m.test(block)) { out.add(path); out.add(real(path)); }
  }
  return out;
}

async function facts(w, defaults, sessions) {
  const [up, head, ct, rl] = await Promise.all([
    git(w.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    git(w.path, ['rev-parse', 'HEAD']),
    git(w.path, ['log', '-1', '--format=%ct']),
    // %gd with --date=unix is the reflog ENTRY's time (HEAD@{1790310966}); %ct
    // would be the commit's, which for a branch cut from an old main is old
    git(w.path, ['reflog', '-1', '--date=unix', '--format=%gd', 'HEAD']),
  ]);
  const f = { upstream: up.ok ? up.out.trim() : null, head: head.ok ? head.out.trim() : null, ahead: 0, behind: 0, merged: false, defaultRef: null };
  if (f.upstream) {
    const lr = await git(w.path, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
    if (lr.ok) [f.ahead, f.behind] = lr.out.trim().split(/\s+/).map(Number);
  }
  const tx = sessions.get(w.path);
  const touched = Number(rl.out.match(/@\{(\d+)\}/)?.[1]) || 0;
  f.last = Math.max(Number(ct.out.trim()) || 0, touched, tx ? Math.floor(tx.at / 1000) : 0) * 1000;
  if (w.linked && f.head && w.repoRoot) {
    f.defaultRef = await defaults(w.repoRoot);
    const own = f.defaultRef && w.branch && f.defaultRef.replace(/^origin\//, '') === w.branch;
    if (f.defaultRef && !own) f.merged = (await git(w.path, ['merge-base', '--is-ancestor', 'HEAD', f.defaultRef])).code === 0;
  }
  return f;
}

// --- findings -----------------------------------------------------------------------

// Always with --session: pane and workspace ids are unique only within one session.
export const closeCmd = s => `herdr --session ${shq(s.session)} workspace close ${shq(s.workspace)}`;
const spaceRef = s => ({ session: s.session, workspace: s.workspace, label: s.label });

/**
 * Why a worktree clean would otherwise remove must stay, each reason with a
 * code, and the command that shows it. An empty list means it may go.
 *
 *   agent  caller  locked     someone is using it — checked first, and enough on
 *                             their own: the disk checks below are skipped
 *   local-only  uncommitted  status  ignored     it holds something git cannot give back
 *   young                     touched under --min-age days ago (a new branch looks merged)
 */
export const IN_USE = new Set(['agent', 'caller', 'locked']);

async function keepReasons(w, f, { named, minAgeDays, now, caller, cwd, locked }) {
  const why = [];
  const add = (code, reason, fix) => why.push({ code, reason, fix });
  for (const s of w.spaces) {
    for (const p of s.panes.filter(p => p.agent)) add('agent', `agent ${p.pane} (${p.agent}, ${p.status}) is in it`, `maw herdr peek --session ${shq(s.session)} ${p.pane}`);
  }
  const mine = caller && w.spaces.some(s => s.panes.some(p => p.pane === caller.pane && (!caller.session || s.session === caller.session)));
  if (mine || within(w.path, real(cwd))) add('caller', 'this command is running inside it', `cd ${shq(w.repoRoot)}`);
  if (locked.has(w.path)) add('locked', 'git has it locked', `git -C ${shq(w.repoRoot)} worktree unlock ${shq(w.path)}`);
  if (why.length || (!f.merged && !named)) return why;
  if (!f.merged) {
    const lo = await git(w.path, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
    const n = lo.ok ? Number(lo.out.trim()) : NaN;
    if (!(n === 0)) add('local-only', Number.isNaN(n) ? 'git could not count its local-only commits' : `${n} local-only commit${n === 1 ? '' : 's'}, on no remote and not in ${f.defaultRef ?? 'a default branch'}`, `git -C ${shq(w.path)} log --oneline HEAD --not --remotes`);
  }
  const status = await uncommitted(w.path);
  const dirty = status?.dirty ?? [];
  // junk is untracked too, and git refuses to remove a worktree with any
  // untracked file unless forced; clean forces only when junk is all there is
  why.junk = status?.junk.length ?? 0;
  if (status === null) add('status', 'git status failed in it', `git -C ${shq(w.path)} status`);
  else if (dirty.length) add('uncommitted', `${dirty.length} uncommitted: ${dirty.slice(0, 3).join(' ')}${dirty.length > 3 ? ` +${dirty.length - 3}` : ''}`, `git -C ${shq(w.path)} status`);
  const ig = await ignoredData(w.path);
  if (ig.error) add('ignored', `cannot list its gitignored files (${ig.error})`, `git -C ${shq(w.path)} status --ignored`);
  else if (ig.entries.length) {
    const top = ig.entries[0];
    add('ignored', `holds ${fmtBytes(ig.bytes)} of gitignored data (${ig.entries.slice(0, 3).map(e => e.path).join(', ')}${ig.entries.length > 3 ? ` +${ig.entries.length - 3}` : ''}) that no commit can bring back`,
      `du -sh ${shq(join(w.path, top.path))}`);
  }
  const ageDays = Math.floor((now - f.last) / 86_400_000);
  if (!named && ageDays < minAgeDays) add('young', `active ${ageDays}d ago (under --min-age ${minAgeDays}; a new branch looks merged too)`, `maw herdr clean ${shq(w.path)}`);
  return why;
}

/**
 * Everything audit reports, in one pass over the world.
 *
 * scope: null for everything, else { paths:Set, spaces:Set("session\0ws") } from
 * named targets. Named worktrees also become clean candidates when they are
 * pushed but not merged (a squash-merged PR looks like that), and skip --min-age:
 * a person picked them.
 */
export async function audit(world, { idleMs = DEFAULT_IDLE_MS, minAgeDays = DEFAULT_MIN_AGE_DAYS, scope = null, now = Date.now(), caller = callerFromEnv(), cwd = process.cwd() } = {}) {
  const inScope = w => !scope || scope.paths.has(w.path) || w.spaces?.some(s => scope.spaces.has(`${s.session}\0${s.workspace}`));
  const spaceInScope = s => !scope || scope.spaces.has(`${s.session}\0${s.workspace}`) || scope.paths.has(s.path);
  const named = w => !!scope?.paths.has(w.path);
  const findings = [];
  const defaultsMemo = new Map();
  const defaults = root => { if (!defaultsMemo.has(root)) defaultsMemo.set(root, defaultRef(root)); return defaultsMemo.get(root); };
  const lockedMemo = new Map();
  const locks = root => { if (!lockedMemo.has(root)) lockedMemo.set(root, lockedPaths(root)); return lockedMemo.get(root); };

  const trees = world.trees.filter(inScope);
  for (const w of trees) {
    const base = { label: w.label, path: w.path, repo: w.repo, repoRoot: w.repoRoot, branch: w.branch, linked: w.linked, state: stateOf(w, world.sessions), spaces: w.spaces.map(spaceRef) };
    if (w.prunable) {
      const agents = w.spaces.flatMap(s => s.panes.filter(p => p.agent).map(p => ({ session: s.session, pane: p.pane, agent: p.agent, status: p.status })));
      findings.push({ kind: 'gone', ...base, agents, locked: w.repoRoot ? (await locks(w.repoRoot)).has(w.path) : false, detail: `folder gone; git still lists it${w.spaces.length ? ` and ${w.spaces.length} herdr space${w.spaces.length === 1 ? '' : 's'} still point${w.spaces.length === 1 ? 's' : ''} at it` : ''}` });
    } else if (w.spaces.length && !existsSync(w.path)) {
      for (const s of w.spaces) {
        const agents = s.panes.filter(p => p.agent);
        findings.push({ kind: 'orphan', ...base, session: s.session, workspace: s.workspace, label: s.label, agents: agents.map(p => p.pane), detail: `herdr space ${s.workspace} in ${s.session} points at a folder that is gone${agents.length ? `, with agent ${agents.map(p => p.pane).join(', ')} in it` : ''}` });
      }
    }
  }
  for (const s of world.plain.filter(spaceInScope)) {
    const dirs = s.panes.map(p => p.cwd).filter(Boolean);
    if (!dirs.length || dirs.some(d => existsSync(d))) continue;
    const agents = s.panes.filter(p => p.agent);
    findings.push({ kind: 'orphan', label: s.label, path: s.path, repo: null, repoRoot: null, branch: null, linked: false, state: agents.length ? 'running' : 'open', spaces: [spaceRef(s)], session: s.session, workspace: s.workspace, agents: agents.map(p => p.pane), detail: `herdr space ${s.workspace} in ${s.session}: every pane sits in a folder that is gone${agents.length ? `, with agent ${agents.map(p => p.pane).join(', ')} in it` : ''}` });
  }

  // idle agents: herdr says idle, and the newest transcript the providers find
  // for its directory is older than the threshold. No transcript, no finding —
  // its idle time is unknown, and closing it could not be undone by resume.
  for (const s of world.targets.filter(t => t.state !== 'closed' && spaceInScope(t))) {
    for (const p of s.panes.filter(p => p.agent && IDLE.has(p.status))) {
      const tx = world.sessions.get(real(p.cwd ?? '')) ?? world.sessions.get(s.path);
      if (!tx || now - tx.at < idleMs) continue;
      findings.push({
        kind: 'idle', label: s.label, path: s.path, repo: s.repo, repoRoot: s.repoRoot, branch: s.branch, linked: s.linked, state: 'running',
        spaces: [spaceRef(s)], session: s.session, workspace: s.workspace, pane: p.pane, agent: p.agent, status: p.status,
        idleMs: now - tx.at, resume: { provider: tx.provider, id: tx.id, command: tx.command },
        detail: `${p.agent} in ${p.pane} is ${p.status}; last transcript write ${fmtAge(now - tx.at)} ago`,
      });
    }
  }

  // git facts for every checkout that exists: behind, merged, keep reasons
  const live = trees.filter(w => !w.prunable && existsSync(w.path));
  const factList = await pool(live, 8, w => facts(w, defaults, world.sessions));
  for (let i = 0; i < live.length; i++) {
    const w = live[i];
    const f = factList[i];
    const base = { label: w.label, path: w.path, repo: w.repo, repoRoot: w.repoRoot, branch: w.branch, linked: w.linked, state: stateOf(w, world.sessions), spaces: w.spaces.map(spaceRef) };
    if (f.upstream && f.behind > 0 && f.ahead === 0) {
      findings.push({ kind: 'behind', ...base, upstream: f.upstream, behind: f.behind, detail: `${w.branch ?? 'HEAD'} is ${f.behind} behind ${f.upstream} and 0 ahead (as of the last fetch)` });
    }
    if (named(w) && !w.linked) {
      findings.push({ kind: 'merged', ...base, named: true, merged: false, defaultRef: f.defaultRef, ageMs: now - f.last,
        keep: [{ code: 'main', reason: "it is the repo's main checkout; clean removes linked worktrees only", fix: `git -C ${shq(w.path)} worktree list` }],
        detail: 'named by you' });
    } else if (w.linked && (f.merged || named(w))) {
      const keep = await keepReasons(w, f, { named: named(w), minAgeDays, now, caller, cwd, locked: w.repoRoot ? await locks(w.repoRoot) : new Set() });
      findings.push({
        kind: 'merged', ...base, named: named(w), merged: f.merged, defaultRef: f.defaultRef, ageMs: now - f.last, keep: [...keep], junk: keep.junk ?? 0,
        detail: f.merged ? `HEAD is in ${f.defaultRef}` : `named by you; its commits are on a remote`,
      });
    }
  }
  const order = ['gone', 'orphan', 'merged', 'idle', 'behind'];
  findings.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || String(a.path).localeCompare(String(b.path)));
  return { findings, scanned: { trees: trees.length, spaces: world.targets.filter(t => t.state !== 'closed').length, repos: world.repos.length }, incomplete: world.incomplete };
}

// --- arguments ----------------------------------------------------------------------

const FLAGS = {
  audit: { bool: ['--json'], value: ['--idle', '--min-age', '--session'] },
  clean: { bool: ['--json', '--go', '--pick'], value: ['--min-age', '--session'] },
  sync: { bool: ['--json', '--go', '--pick', '--idle-agents'], value: ['--idle', '--session'] },
};

/** The three verbs' shared argv: targets, flags, and the usage errors (exit 2) that end in a command. */
export function parseArgs(verb, argv, UsageError) {
  const rest = [...argv];
  const dry = takeDry(rest);
  const spec = FLAGS[verb];
  const o = { json: false, go: false, pick: false, idleAgents: false, idleMs: DEFAULT_IDLE_MS, idleRaw: null, minAgeDays: DEFAULT_MIN_AGE_DAYS, session: null, targets: [], dry };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (spec.value.includes(a)) {
      const v = rest[++i];
      if (v === undefined || v.startsWith('-')) throw new UsageError(`${a} needs a value\n  maw herdr ${verb} ${a} ${a === '--idle' ? '24h' : a === '--min-age' ? '3' : 'default'}`);
      if (a === '--idle') {
        const ms = parseDuration(v);
        if (ms === null) throw new UsageError(`--idle takes a duration like 90m, 24h or 3d, not '${v}'\n  maw herdr ${verb} --idle 24h`);
        o.idleMs = ms;
        o.idleRaw = v;
      } else if (a === '--min-age') {
        if (!/^\d+$/.test(v)) throw new UsageError(`--min-age takes whole days, not '${v}'\n  maw herdr ${verb} --min-age 3`);
        o.minAgeDays = Number(v);
      } else o.session = v;
    } else if (spec.bool.includes(a)) {
      o[{ '--json': 'json', '--go': 'go', '--pick': 'pick', '--idle-agents': 'idleAgents' }[a]] = true;
    } else if (a.startsWith('-')) {
      const takes = [...spec.bool, ...spec.value].join(', ');
      throw new UsageError(`unknown argument for ${verb}: ${a} (takes ${takes}, and targets)\n  maw herdr ${verb} --help`);
    } else o.targets.push(a);
  }
  if (o.go && o.pick) throw new UsageError(`--go runs every action and --pick asks before each one; choose one:\n  maw herdr ${verb} --pick\n  maw herdr ${verb} --go`);
  if (dry && (o.go || o.pick)) throw new UsageError(`--dry prints the plan only, which is already the default; drop it to act:\n  maw herdr ${verb} ${o.go ? '--go' : '--pick'}`);
  return o;
}

/**
 * Targets named on the command line, as a scope for `audit`. Each goes through
 * #59's worktree grammar (self, path, pane id, name); an ambiguous one throws the
 * TargetError that lists its candidates as runnable commands.
 */
export function scopeOf(world, raws, { verb, session }) {
  if (!raws.length) return null;
  const pool = session ? world.targets.filter(t => !t.session || t.session === session) : world.targets;
  const scope = { paths: new Set(), spaces: new Set() };
  for (const raw of raws) {
    const r = resolveTarget(pool, raw, { verb });
    if (r.kind === 'worktree') scope.paths.add(r.path);
    else scope.spaces.add(`${r.session}\0${r.workspace}`);
  }
  return scope;
}

// --- the verb ---------------------------------------------------------------------------

export function warnIncomplete(incomplete, acting) {
  for (const s of incomplete) {
    process.stderr.write(`maw herdr: herdr session ${s.session} did not answer its snapshot (${s.reason}); its spaces are missing from this ${acting ? 'plan, so nothing will be done' : 'report'}\n  herdr --session ${shq(s.session)} api snapshot\n`);
  }
}

const KEPT_WORDS = { agent: 'an agent in it', caller: 'you are in it', locked: 'locked', main: 'main checkout', 'local-only': 'local-only commits', uncommitted: 'uncommitted changes', status: 'git status failed', ignored: 'gitignored data', young: 'touched under --min-age', 'orphan-agent': 'an agent in a space on nothing', 'needs-flag': 'idle, needs --idle-agents' };

/** "4 an agent in it · 2 touched under --min-age" — each kept worktree counted once, by its first reason. */
export function keptSummary(reasonLists) {
  const n = new Map();
  for (const rs of reasonLists) n.set(rs[0].code, (n.get(rs[0].code) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([code, k]) => `${k} ${KEPT_WORDS[code] ?? code}`).join(' · ');
}

const TAG = { gone: C.red, orphan: C.red, idle: C.yellow, behind: C.cyan, merged: C.green };

function printFinding(f) {
  const where = f.kind === 'orphan' || f.kind === 'idle' ? `${f.session} ${f.pane ?? f.workspace}` : f.path;
  const tag = f.kind === 'merged' && f.keep.length ? `${C.dim}kept  ${C.off}` : `${TAG[f.kind]}${f.kind.padEnd(6)}${C.off}`;
  console.log(`  ${tag} ${C.cyan}${String(f.label).padEnd(24)}${C.off} ${C.dim}${where}${C.off}`);
  console.log(`         ${f.detail}`);
  if (f.kind === 'merged') for (const k of f.keep) console.log(`         ${C.dim}kept: ${k.reason}${C.off}\n           ${k.fix}`);
  if (f.kind === 'idle') console.log(`         ${C.dim}resume later: ${f.resume.command}${C.off}`);
}

/** `maw herdr audit [<target>...]` — report only. */
export async function cmdAudit(argv, { UsageError = Error, registryRoot } = {}) {
  const o = parseArgs('audit', argv, UsageError);
  const world = await loadWorld({ registryRoot });
  const scope = scopeOf(world, o.targets, { verb: 'audit', session: o.session });
  const report = await audit(world, { idleMs: o.idleMs, minAgeDays: o.minAgeDays, scope });
  warnIncomplete(report.incomplete, false);
  if (o.json) {
    await writeJson({ command: 'audit', json: true, readOnly: true, idleMs: o.idleMs, minAgeDays: o.minAgeDays, ...report });
    return 0;
  }
  const { findings, scanned } = report;
  const count = k => findings.filter(f => f.kind === k && !(f.kind === 'merged' && f.keep.length)).length;
  const kept = findings.filter(f => f.kind === 'merged' && f.keep.length).length;
  console.log(`  ${C.dim}audit · ${scanned.trees} checkouts, ${scanned.spaces} herdr spaces · read-only: nothing was changed${C.off}`);
  if (!findings.length) {
    console.log(`  nothing to clean or sync`);
    return 0;
  }
  const keptMerged = findings.filter(f => f.kind === 'merged' && f.keep.length);
  for (const f of findings) if (!keptMerged.includes(f)) printFinding(f);
  if (keptMerged.length) console.log(`  ${C.dim}kept  ${C.off} ${keptMerged.length} merged worktree${keptMerged.length === 1 ? '' : 's'}: ${keptSummary(keptMerged.map(f => f.keep))}\n         see each one and why: maw herdr clean${o.minAgeDays === DEFAULT_MIN_AGE_DAYS ? '' : ` --min-age ${o.minAgeDays}`}`);
  console.log('');
  console.log(`  ${C.dim}gone ${count('gone')} · orphan ${count('orphan')} · merged ${count('merged')} (kept ${kept}) · idle ${count('idle')} (over ${o.idleRaw ?? '24h'}) · behind ${count('behind')}${C.off}`);
  if (count('gone') || count('merged')) console.log(`  plan the removals: maw herdr clean`);
  if (count('gone') || count('orphan') || count('behind')) console.log(`  plan the sync:     maw herdr sync`);
  if (count('idle')) console.log(`  close idle agents: maw herdr sync --idle-agents${o.idleRaw ? ` --idle ${shq(o.idleRaw)}` : ''}`);
  return 0;
}
