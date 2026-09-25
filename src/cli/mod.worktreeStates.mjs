// The four states of a worktree, for `maw herdr ls [running|open|resumable|cold]`.
//
//   running    an agent is live in a pane of a space on this checkout
//   open       a herdr space is open on it, no agent in it
//   resumable  no space, but a resume provider found a transcript to resume
//   cold       nothing
//
// Running and open are herdr's own knowledge (the workspace snapshot). Only
// "resumable" asks anything else, and it asks the providers in
// mod.resumeProviders.mjs, never a hardcoded agent path.
//
// Why the worktrees and not just the spaces: closing a herdr space destroys
// nothing — the checkout stays on disk and so does the transcript — so a
// listing built from open spaces hides most of the work. Measured on m5 when
// this was written: 24 spaces open, several hundred worktrees on disk.
//
// Which worktrees: every linked worktree git knows about, of every repo under
// the ghq root that has at least one (`<repo>/.git/worktrees/` is not empty),
// plus the main checkout of each such repo, plus the repo of every open space.
// A repo that has never used a worktree and has no space open is not listed —
// it is a clone, not a workspace. The ghq root comes from $GHQ_ROOT, then
// `ghq root --all`, then ~/.maw/oracles.json's ghq_root; with none of them only
// the repos of open spaces are scanned. Layout is ghq's: <root>/<host>/<org>/<repo>,
// with <host> a hostname (it contains a dot), so unrelated directories that
// share the root (datasets, archives) are never walked.

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { findSessions } from './mod.resumeProviders.mjs';

const execFileP = promisify(execFile);

export const STATES = ['running', 'open', 'resumable', 'cold'];

const real = p => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const dirs = dir => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
  } catch {
    return [];
  }
};

/** Where repos live. First source that answers wins. */
export function ghqRoots(env = process.env, registryRoot) {
  if (env.GHQ_ROOT) return env.GHQ_ROOT.split(delimiter).filter(Boolean);
  try {
    const out = execFileSync('ghq', ['root', '--all'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const roots = out.split('\n').map(s => s.trim()).filter(Boolean);
    if (roots.length) return roots;
  } catch {
    // no ghq on this machine
  }
  return registryRoot ? [registryRoot] : [];
}

/** Repos under the ghq roots that have at least one linked worktree. */
export function reposWithWorktrees(roots) {
  const out = [];
  for (const root of roots) {
    for (const host of dirs(root)) {
      if (!host.includes('.') || host.startsWith('_')) continue;
      for (const org of dirs(join(root, host))) {
        for (const repo of dirs(join(root, host, org))) {
          const path = join(root, host, org, repo);
          try {
            // `.git` a directory (a file means this is itself a worktree or a submodule)
            if (!statSync(join(path, '.git')).isDirectory()) continue;
            if (readdirSync(join(path, '.git', 'worktrees')).length) out.push(path);
          } catch {
            // no .git, or no worktrees dir
          }
        }
      }
    }
  }
  return out;
}

/** `git worktree list --porcelain`, parsed. Bare and prunable (directory gone) entries are dropped. */
export function parsePorcelain(text) {
  return text.split(/\n\n+/).map(block => {
    const line = key => block.split('\n').find(l => l === key || l.startsWith(`${key} `));
    const path = line('worktree')?.slice('worktree '.length);
    if (!path || line('bare') || line('prunable')) return null;
    const branch = line('branch')?.slice('branch '.length).replace(/^refs\/heads\//, '') ?? null;
    return { path, branch };
  }).filter(Boolean);
}

/** A repo's worktrees. Throws when git cannot list them; the caller reports it. */
async function gitWorktrees(repo) {
  const { stdout } = await execFileP('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 10_000 });
  // the main worktree comes first; its path, as git spells it, names the repo
  const all = parsePorcelain(stdout);
  const main = stdout.match(/^worktree (.*)$/m)?.[1] ?? repo;
  return all.map(w => ({ ...w, repoRoot: main, linked: w.path !== main }));
}

// How many `git worktree list` run at once. Unbounded, a machine with ~70
// worktree repos started ~70 gits together, and under load some hit the 10 s
// timeout — a repo lost that way would have dropped out of the counts.
export const GIT_CONCURRENCY = 8;

/** Every repo's worktrees, a few gits at a time; repos git could not list come back in `unreadable`. */
async function listAll(repos) {
  const queue = [...repos];
  const listed = [];
  const unreadable = [];
  const worker = async () => {
    for (let repo = queue.shift(); repo !== undefined; repo = queue.shift()) {
      try {
        listed.push(...await gitWorktrees(repo));
      } catch {
        unreadable.push(repo);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(GIT_CONCURRENCY, queue.length) }, worker));
  return { listed, unreadable: unreadable.sort() };
}

// herdr's repo_key is the shared git dir (/code/x/.git); the repo is its parent.
const repoRootOf = w => (w.repoKey ? (basename(w.repoKey) === '.git' ? dirname(w.repoKey) : w.repoKey) : null);

/**
 * Every worktree with its state, plus each open space's state, plus the repos
 * git could not list (`unreadable`) — their closed worktrees are missing from
 * `rows`, and the caller has to say so.
 *
 * spaces:    rows from the workspace tree, each with `checkout` and `agents`
 *            (the number of agent panes in it).
 * roots:     ghq roots to scan.
 * providers: resume providers; an empty list means nothing is ever resumable.
 */
export async function worktreeStates({ spaces, roots, providers }) {
  const repos = new Map();
  for (const r of [...reposWithWorktrees(roots), ...spaces.map(repoRootOf).filter(Boolean)]) {
    const key = real(r);
    if (!repos.has(key)) repos.set(key, r);
  }
  const { listed, unreadable } = await listAll(repos.values());

  // one row per checkout on disk, however many repos (ghq alias symlinks) or
  // nested checkouts list it
  const byCanon = new Map();
  for (const w of listed) {
    const canon = real(w.path);
    if (byCanon.has(canon) || !existsSync(canon)) continue;
    byCanon.set(canon, { ...w, canon });
  }

  const spaceState = w => (w.agents > 0 ? 'running' : 'open');
  const spacesAt = new Map();
  const unclaimed = [];
  for (const w of spaces) {
    const canon = w.checkout ? real(w.checkout) : null;
    if (canon && byCanon.has(canon)) {
      if (!spacesAt.has(canon)) spacesAt.set(canon, []);
      spacesAt.get(canon).push(w);
    } else {
      unclaimed.push({ w, canon });
    }
  }

  // every spelling of every path, so a provider keyed by either the registered
  // or the resolved path finds it
  const aliases = new Map();
  for (const [canon, w] of byCanon) {
    aliases.set(canon, canon);
    aliases.set(w.path, canon);
  }
  for (const { w, canon } of unclaimed) {
    if (!canon) continue;
    aliases.set(canon, canon);
    aliases.set(w.checkout, canon);
  }
  const sessions = findSessions(providers, aliases);

  const brief = w => ({ session: w.session, id: w.id, label: w.label });
  const rows = [];
  for (const [canon, w] of byCanon) {
    const here = spacesAt.get(canon) ?? [];
    const agents = here.reduce((n, s) => n + (s.agents ?? 0), 0);
    const resume = sessions.get(canon) ?? null;
    const state = agents > 0 ? 'running' : here.length ? 'open' : resume ? 'resumable' : 'cold';
    rows.push({
      path: w.path,
      repo: basename(w.repoRoot),
      repoRoot: w.repoRoot,
      label: here[0]?.label ?? basename(w.path),
      branch: w.branch,
      linked: w.linked,
      state,
      agents,
      workspaces: here.map(brief),
      resume,
    });
  }
  // A space need not sit on a worktree this scan found (a plain shell space,
  // a repo outside the ghq root). It is still running or open, so it is still
  // listed, keyed off its own checkout.
  for (const { w, canon } of unclaimed) {
    rows.push({
      path: w.checkout ?? null,
      repo: w.repo ?? null,
      repoRoot: repoRootOf(w) && real(repoRootOf(w)),
      label: w.label,
      branch: null,
      linked: !!w.linked,
      state: spaceState(w),
      agents: w.agents ?? 0,
      workspaces: [brief(w)],
      resume: canon ? sessions.get(canon) ?? null : null,
    });
  }

  const counts = Object.fromEntries(STATES.map(s => [s, rows.filter(r => r.state === s).length]));
  return {
    rows,
    counts,
    spaces: spaces.map(w => ({ ...w, state: spaceState(w) })),
    scanned: { roots, repos: repos.size },
    unreadable,
  };
}
