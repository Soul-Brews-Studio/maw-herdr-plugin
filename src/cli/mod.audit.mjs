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
import { dirname, join, sep } from 'node:path';
import { writeJson } from './mod.lsStateView.mjs';
import { configuredProviders, findAllSessions } from './mod.resumeProviders.mjs';
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
// build or an install will not make again. The unambiguous names count at any
// depth, whatever git lists inside them (.pytest_cache ignores itself, so git
// lists its files one by one). The generic ones — build, dist, target, coverage —
// count only as a directory at the worktree root or beside a package manifest:
// data/target/labels.db and data/build/results.db are data.
const REBUILDABLE_ANYWHERE = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.next', '.turbo', '.cache', '.parcel-cache', '.gradle', '.pytest_cache', '.mypy_cache', '.ruff_cache']);
const REBUILDABLE_AT_PACKAGE = new Set(['target', 'dist', 'build', 'coverage']);
const MANIFESTS = ['package.json', 'Cargo.toml', 'pyproject.toml', 'setup.py', 'go.mod', 'build.gradle', 'build.gradle.kts', 'pom.xml', 'mix.exs', 'composer.json'];
// OS litter: never a reason to keep a worktree. (.envrc is NOT litter: in this
// fleet it holds the operator token `maw token use` writes, so it is data.)
const JUNK = /(^|\/)(\._[^/]*|\.DS_Store)$/;

/** Is one `ls-files --ignored --directory` entry rebuildable? `entry` as git printed it. */
export function rebuildable(worktree, entry) {
  const segs = entry.replace(/\/$/, '').split('/');
  if (segs.some(s => REBUILDABLE_ANYWHERE.has(s))) return true;
  // a generic name counts as a directory: not the entry's own last segment
  // unless git printed it as a directory
  const dirs = entry.endsWith('/') ? segs.length : segs.length - 1;
  for (let i = 0; i < dirs; i++) {
    if (!REBUILDABLE_AT_PACKAGE.has(segs[i])) continue;
    const parent = segs.slice(0, i).join('/');
    if (!parent || MANIFESTS.some(m => existsSync(join(worktree, parent, m)))) return true;
  }
  return false;
}

/**
 * Does the ignored directory `rel` hold nothing but rebuildable files and litter?
 * Walks it without following symlinks; a directory too big to walk within the
 * budget is data — the safe answer when the question cannot be settled.
 */
function onlyRebuildable(worktree, rel, budget = { left: 5_000 }) {
  let list;
  try { list = readdirSync(join(worktree, rel), { withFileTypes: true }); } catch { return false; }
  for (const e of list) {
    if (--budget.left < 0) return false;
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (rebuildable(worktree, `${child}/`)) continue;
      if (!onlyRebuildable(worktree, child, budget)) return false;
    } else if (!rebuildable(worktree, child) && !JUNK.test(child)) return false;
  }
  return true;
}

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
  const entries = r.out.split('\0').filter(Boolean)
    .filter(e => !rebuildable(path, e) && !JUNK.test(e.replace(/\/$/, '')))
    // git lists a directory whose whole content is ignored (app/ holding only a
    // self-ignoring .pytest_cache): look inside before calling it data
    .filter(e => !e.endsWith('/') || !onlyRebuildable(path, e.slice(0, -1)))
    .map(e => e.replace(/\/$/, ''))
    // git lists an ignored dir AND files inside it at times (data/ and
    // data/target/labels.db); count each byte once, under the outermost entry
    .filter((e, _, all) => !all.some(o => o !== e && e.startsWith(`${o}/`)))
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
 * Everything cleanup reasons about, read once:
 *   targets     #59's rows — one per herdr space, one per closed git worktree
 *   trees       one per checkout path: the spaces bound to it (in any session),
 *               plain spaces that sit wholly inside it, every pane whose cwd is
 *               inside it (whatever space holds that pane), git's view of it
 *   plain       herdr spaces bound to no git worktree
 *   sessions    newest resumable transcript per path (#60 providers)
 *   transcripts every resumable transcript per path, newest first
 *   incomplete  herdr sessions whose snapshot failed IN THIS SAME LOAD — a
 *               session left out of `targets` is always listed here, so a
 *               worktree whose space lives there can never look unused
 */
export async function loadWorld({ env = process.env, registryRoot, cwd = process.cwd() } = {}) {
  const providers = configuredProviders(env);   // a bad provider name fails before anything is read
  const repos = reposWithWorktrees(ghqRoots(env, registryRoot));
  const skipped = [];
  const targets = await loadTargets({ cwd, paths: repos, ghq: false, skipped });
  const incomplete = skipped.sort((a, b) => a.session.localeCompare(b.session));

  const trees = new Map();
  const plain = [];
  for (const t of targets) {
    if (t.kind === 'space') { plain.push(t); continue; }
    let w = trees.get(t.path);
    if (!w) {
      w = { path: t.path, label: t.name, repo: t.repo, repoRoot: t.repoRoot, linked: t.linked, branch: t.branch, prunable: t.prunable, spaces: [], plainSpaces: [], panes: [] };
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

  // A pane belongs to the innermost checkout its cwd is in (a linked worktree
  // under <repo>/wt/ is inside the main checkout's folder too), whatever space
  // holds it: `herdr workspace create --cwd` binds no repo, and a pane can `cd`
  // into a worktree from a space bound to another checkout. Binding alone would
  // miss both, and clean would remove a folder an agent is sitting in.
  const treeList = [...trees.values()];
  const home = dir => {
    let best = null;
    for (const w of treeList) if (within(w.path, dir) && (!best || w.path.length > best.path.length)) best = w;
    return best;
  };
  const homeOf = p => { const raw = p.foregroundCwd || p.cwd; return raw ? home(real(raw)) ?? home(raw) : null; };
  for (const t of targets.filter(t => t.state !== 'closed')) {
    for (const p of t.panes) homeOf(p)?.panes.push({ ...p, session: t.session, workspace: t.workspace });
  }
  // a plain space whose every pane sits inside one checkout is that checkout's:
  // removing the checkout closes it, or it would be left on a deleted folder
  for (const t of plain.filter(t => t.state !== 'closed')) {
    const homes = t.panes.filter(p => p.foregroundCwd || p.cwd).map(homeOf);
    if (homes.length && homes.every(h => h && h === homes[0])) homes[0].plainSpaces.push(t);
  }

  const aliases = new Map();
  for (const w of trees.values()) aliases.set(w.path, w.path);
  for (const t of targets) for (const p of t.panes) for (const d of [p.cwd, p.foregroundCwd]) if (d) aliases.set(d, real(d));
  const transcripts = findAllSessions(providers, aliases);
  const sessions = new Map([...transcripts].map(([k, list]) => [k, list[0]]));
  return { targets, trees: treeList.sort((a, b) => a.path.localeCompare(b.path)), plain, sessions, transcripts, providers, incomplete, repos };
}

/**
 * Every pane a removal of `w` would touch, each once: the panes of every space
 * it would close (bound to w, or plain and wholly inside it) and every pane whose
 * cwd is inside w, wherever it lives. `closable` says whether its space is one
 * the removal closes; a pane in some other space never is.
 */
export function occupants(w) {
  const closing = [...(w.spaces ?? []), ...(w.plainSpaces ?? [])];
  const keys = new Set(closing.map(s => `${s.session}\0${s.workspace}`));
  const out = new Map();
  for (const s of closing) for (const p of s.panes) out.set(`${s.session}\0${p.pane}`, { ...p, session: s.session, workspace: s.workspace, closable: true });
  for (const p of w.panes ?? []) {
    const k = `${p.session}\0${p.pane}`;
    if (!out.has(k)) out.set(k, { ...p, closable: keys.has(`${p.session}\0${p.workspace}`) });
  }
  return [...out.values()];
}

/** #60's four states, for one tree. */
export function stateOf(w, sessions) {
  if (occupants(w).some(p => p.agent)) return 'running';
  if (w.spaces.length || w.plainSpaces?.length) return 'open';
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
 *   agent  shell  caller  locked
 *                             someone is using it — checked first, and enough on
 *                             their own: the disk checks below are skipped. An
 *                             agent or a shell counts wherever its space is, by
 *                             the pane's cwd; a bare shell may be running a dev
 *                             server or an editor, so it keeps the worktree
 *                             unless --idle-shells says close it (and only when
 *                             its space is one the removal closes)
 *   local-only  uncommitted  status  ignored     it holds something git cannot give back
 *   young                     touched under --min-age days ago (a new branch looks merged)
 */
export const IN_USE = new Set(['agent', 'shell', 'caller', 'locked']);

const peekCmd = p => `maw herdr peek --session ${shq(p.session)} ${p.pane}`;

/** The 'agent' and 'shell' keep reasons for the panes a removal of `w` would touch. */
export function paneReasons(w, { idleShells = false } = {}) {
  const out = [];
  for (const p of occupants(w)) {
    const where = p.closable ? '' : ` (from space ${p.workspace} in ${p.session}, which clean will not close)`;
    if (p.agent) out.push({ code: 'agent', reason: `agent ${p.pane} (${p.agent}, ${p.status}) is in it${where}`, fix: peekCmd(p) });
    else if (!idleShells || !p.closable) out.push({ code: 'shell', reason: `shell ${p.pane} is in it${where || ' — it may be running something; --idle-shells closes it'}`, fix: peekCmd(p) });
  }
  return out;
}

async function keepReasons(w, f, { named, minAgeDays, now, caller, cwd, locked, idleShells }) {
  const why = [];
  const add = (code, reason, fix) => why.push({ code, reason, fix });
  why.push(...paneReasons(w, { idleShells }));
  const mine = caller && occupants(w).some(p => p.pane === caller.pane && (!caller.session || p.session === caller.session));
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
  // untracked file; clean deletes exactly these files first and then removes
  // WITHOUT --force, so git's own refusal still guards anything new
  why.junk = status?.junk ?? [];
  if (status === null) add('status', 'git status failed in it', `git -C ${shq(w.path)} status`);
  else if (dirty.length) add('uncommitted', `${dirty.length} uncommitted: ${dirty.slice(0, 3).join(' ')}${dirty.length > 3 ? ` +${dirty.length - 3}` : ''}`, `git -C ${shq(w.path)} status`);
  const ig = await ignoredData(w.path);
  if (ig.error) add('ignored', `cannot list its gitignored files (${ig.error})`, `git -C ${shq(w.path)} status --ignored`);
  else if (ig.entries.length) {
    const top = ig.entries[0];
    const envrc = ig.entries.some(e => e.path === '.envrc' || e.path.endsWith('/.envrc'));
    add('ignored', `holds ${fmtBytes(ig.bytes)} of gitignored data (${ig.entries.slice(0, 3).map(e => e.path).join(', ')}${ig.entries.length > 3 ? ` +${ig.entries.length - 3}` : ''}) that no commit can bring back${envrc ? '; an .envrc may hold a token' : ''}`,
      // line count only: an .envrc may hold a token, and this line is printed
      ig.entries.length === 1 && top.path === '.envrc' ? `wc -l ${shq(join(w.path, '.envrc'))}` : `du -sh ${shq(join(w.path, top.path))}`);
  }
  const ageDays = Math.floor((now - f.last) / 86_400_000);
  if (!named && ageDays < minAgeDays) add('young', `active ${ageDays}d ago (under --min-age ${minAgeDays}; a new branch looks merged too)`, `maw herdr clean ${shq(w.path)}`);
  return why;
}

/** The transcript of the agent in pane `p` (in space `s`), or null when none can be told. */
export function ownTranscript(world, s, p) {
  const at = [p.foregroundCwd, p.cwd].filter(Boolean).map(d => world.transcripts.get(real(d)) ?? world.transcripts.get(d)).find(Boolean)
    ?? world.transcripts.get(s.path) ?? [];
  const own = at.filter(t => t.provider === p.agent);
  if (p.agentSession?.id) return own.find(t => t.id === p.agentSession.id) ?? null;
  return own[0] ?? null;
}

/**
 * Everything audit reports, in one pass over the world.
 *
 * scope: null for everything, else { paths:Set, spaces:Set("session\0ws") } from
 * named targets. Named worktrees also become clean candidates when they are
 * pushed but not merged (a squash-merged PR looks like that), and skip --min-age:
 * a person picked them.
 */
export async function audit(world, { idleMs = DEFAULT_IDLE_MS, minAgeDays = DEFAULT_MIN_AGE_DAYS, scope = null, now = Date.now(), caller = callerFromEnv(), cwd = process.cwd(), idleShells = false } = {}) {
  const inScope = w => !scope || scope.paths.has(w.path) || w.spaces?.some(s => scope.spaces.has(`${s.session}\0${s.workspace}`));
  const spaceInScope = s => !scope || scope.spaces.has(`${s.session}\0${s.workspace}`) || scope.paths.has(s.path);
  const named = w => !!scope?.paths.has(w.path);
  const findings = [];
  const defaultsMemo = new Map();
  const defaults = root => { if (!defaultsMemo.has(root)) defaultsMemo.set(root, defaultRef(root)); return defaultsMemo.get(root); };
  const lockedMemo = new Map();
  const locks = root => { if (!lockedMemo.has(root)) lockedMemo.set(root, lockedPaths(root)); return lockedMemo.get(root); };

  const trees = world.trees.filter(inScope);
  const baseOf = w => ({ label: w.label, path: w.path, repo: w.repo, repoRoot: w.repoRoot, branch: w.branch, linked: w.linked, state: stateOf(w, world.sessions), spaces: w.spaces.map(spaceRef), plainSpaces: (w.plainSpaces ?? []).map(spaceRef) });
  for (const w of trees) {
    const base = baseOf(w);
    if (w.prunable) {
      const agents = occupants(w).filter(p => p.agent).map(p => ({ session: p.session, pane: p.pane, agent: p.agent, status: p.status }));
      findings.push({ kind: 'gone', ...base, agents, locked: w.repoRoot ? (await locks(w.repoRoot)).has(w.path) : false, detail: `folder gone; git still lists it${w.spaces.length ? ` and ${w.spaces.length} herdr space${w.spaces.length === 1 ? '' : 's'} still point${w.spaces.length === 1 ? 's' : ''} at it` : ''}` });
    } else if (w.spaces.length && !existsSync(w.path)) {
      for (const s of w.spaces) {
        const agents = s.panes.filter(p => p.agent);
        findings.push({ kind: 'orphan', ...base, session: s.session, workspace: s.workspace, label: s.label, agents: agents.map(p => p.pane), detail: `herdr space ${s.workspace} in ${s.session} points at a folder that is gone${agents.length ? `, with agent ${agents.map(p => p.pane).join(', ')} in it` : ''}` });
      }
    }
  }
  // a plain space wholly inside a gone worktree is closed by that worktree's removal
  const claimed = new Set(world.trees.filter(w => w.prunable).flatMap(w => (w.plainSpaces ?? []).map(s => `${s.session}\0${s.workspace}`)));
  for (const s of world.plain.filter(spaceInScope)) {
    if (claimed.has(`${s.session}\0${s.workspace}`)) continue;
    const dirs = s.panes.map(p => p.cwd).filter(Boolean);
    if (!dirs.length || dirs.some(d => existsSync(d))) continue;
    const agents = s.panes.filter(p => p.agent);
    findings.push({ kind: 'orphan', label: s.label, path: s.path, repo: null, repoRoot: null, branch: null, linked: false, state: agents.length ? 'running' : 'open', spaces: [spaceRef(s)], session: s.session, workspace: s.workspace, agents: agents.map(p => p.pane), detail: `herdr space ${s.workspace} in ${s.session}: every pane sits in a folder that is gone${agents.length ? `, with agent ${agents.map(p => p.pane).join(', ')} in it` : ''}` });
  }

  // idle agents: herdr says idle, and THAT agent's own transcript is older than
  // the threshold. Its own: the provider must be the agent's kind (a stale claude
  // transcript says nothing about a codex beside it), and when herdr knows the
  // agent's session id (agent_session) it must be that very transcript — else the
  // printed resume would open another conversation. No transcript, no finding:
  // its idle time is unknown, and closing it could not be undone by resume.
  for (const s of world.targets.filter(t => t.state !== 'closed' && spaceInScope(t))) {
    for (const p of s.panes.filter(p => p.agent && IDLE.has(p.status))) {
      const tx = ownTranscript(world, s, p);
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
    const base = baseOf(w);
    if (f.upstream && f.behind > 0 && f.ahead === 0) {
      findings.push({ kind: 'behind', ...base, upstream: f.upstream, behind: f.behind, detail: `${w.branch ?? 'HEAD'} is ${f.behind} behind ${f.upstream} and 0 ahead (as of the last fetch)` });
    }
    if (named(w) && !w.linked) {
      findings.push({ kind: 'merged', ...base, named: true, merged: false, defaultRef: f.defaultRef, ageMs: now - f.last,
        keep: [{ code: 'main', reason: "it is the repo's main checkout; clean removes linked worktrees only", fix: `git -C ${shq(w.path)} worktree list` }],
        detail: 'named by you' });
    } else if (w.linked && (f.merged || named(w))) {
      const keep = await keepReasons(w, f, { named: named(w), minAgeDays, now, caller, cwd, idleShells, locked: w.repoRoot ? await locks(w.repoRoot) : new Set() });
      findings.push({
        kind: 'merged', ...base, named: named(w), merged: f.merged, defaultRef: f.defaultRef, ageMs: now - f.last, keep: [...keep], junk: keep.junk ?? [],
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
  clean: { bool: ['--json', '--go', '--pick', '--idle-shells'], value: ['--min-age', '--session'] },
  sync: { bool: ['--json', '--go', '--pick', '--idle-agents', '--idle-shells'], value: ['--idle', '--session'] },
};

/** The three verbs' shared argv: targets, flags, and the usage errors (exit 2) that end in a command. */
export function parseArgs(verb, argv, UsageError) {
  const rest = [...argv];
  const dry = takeDry(rest);
  const spec = FLAGS[verb];
  const o = { json: false, go: false, pick: false, idleAgents: false, idleShells: false, idleMs: DEFAULT_IDLE_MS, idleRaw: null, minAgeDays: DEFAULT_MIN_AGE_DAYS, session: null, targets: [], dry };
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
      o[{ '--json': 'json', '--go': 'go', '--pick': 'pick', '--idle-agents': 'idleAgents', '--idle-shells': 'idleShells' }[a]] = true;
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
export function scopeOf(world, raws, { verb, session, UsageError = Error }) {
  if (!raws.length && session) {
    // --session picks where a NAMED target resolves; every session is always
    // read. Without a target it would narrow nothing while looking like it did.
    const here = world.targets.filter(t => t.session === session && t.state !== 'closed');
    const names = here.map(t => (t.kind === 'worktree' ? shq(t.path) : t.panes[0]?.pane)).filter(Boolean).slice(0, 3);
    throw new UsageError(`--session narrows which session a named target resolves in, and no target was named${names.length ? `; name one:\n${names.map(n => `  maw herdr ${verb} --session ${shq(session)} ${n}`).join('\n')}` : ` (session ${session} has no open space)\n  maw herdr ls --sessions`}\n  or drop it to ${verb} every session:\n  maw herdr ${verb}`);
  }
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

const KEPT_WORDS = { agent: 'an agent in it', shell: 'a shell in it', caller: 'you are in it', locked: 'locked', main: 'main checkout', 'local-only': 'local-only commits', uncommitted: 'uncommitted changes', status: 'git status failed', ignored: 'gitignored data', young: 'touched under --min-age', 'orphan-agent': 'an agent in a space on nothing', 'needs-flag': 'idle, needs --idle-agents' };

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
  const scope = scopeOf(world, o.targets, { verb: 'audit', session: o.session, UsageError });
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
