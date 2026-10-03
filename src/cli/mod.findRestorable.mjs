/**
 * Every worktree whose FOLDER is gone while its branch and transcripts survive
 * (#90), newest first, each with the branch it would come back on and whether it can.
 *
 * resolve, ls and resume start from checkouts that exist, so such a worktree is
 * invisible to them. This starts from the transcripts instead, through the resume
 * providers' optional all({ contains }): every session whose start directory lies
 * under a /wt/ folder. A folder that exists is resume's business; a repo that is gone
 * has nowhere to add a worktree. Then one `git for-each-ref` and one `git worktree
 * list --porcelain` per repo with a candidate — never one per candidate.
 *
 * The branch is the one the newest transcript recorded, else the folder name (Codex
 * records none; the fleet names a worktree's folder after its branch). Read-only:
 * `exists` and `gitFn` are injectable for the smoke.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { configuredProviders } from './mod.resumeProviders.mjs';
import { WT, worktreeOf } from './mod.worktreeOf.mjs';
import { parseWorktrees } from './mod.parseWorktrees.mjs';
import { git } from './mod.git.mjs';
import { filesUnder } from './mod.husk.mjs';

function candidates(providers, exists) {
  const byPath = new Map();
  for (const p of providers) {
    if (!p.all) continue;
    for (const [cwd, list] of p.all({ contains: WT })) {
      const w = worktreeOf(cwd);
      if (!w || !exists(join(w.repo, '.git'))) continue;
      // a folder WITH .git is a checkout: resume's business. One without is a husk
      // (mod.husk.mjs) — something wrote into the path after the worktree went.
      if (exists(w.path) && exists(join(w.path, '.git'))) continue;
      const e = byPath.get(w.path) ?? { ...w, husk: exists(w.path) ? filesUnder(w.path).length : null, sessions: [], hints: [] };
      for (const s of list) {
        if (!e.sessions.some(x => x.provider === s.provider && x.id === s.id)) e.sessions.push(s);
        if (s.branch && !e.hints.includes(s.branch)) e.hints.push(s.branch);
      }
      byPath.set(w.path, e);
    }
  }
  return [...byPath.values()];
}

async function repoFacts(repos, gitFn) {
  const facts = new Map();
  await Promise.all(repos.map(async repo => {
    try {
      const [refs, trees] = await Promise.all([
        gitFn(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']),
        gitFn(repo, ['worktree', 'list', '--porcelain']),
      ]);
      facts.set(repo, { refs: new Set(refs.split('\n').filter(Boolean)), ...parseWorktrees(trees) });
    } catch (err) {
      facts.set(repo, { error: err.detail || err.message });
    }
  }));
  return facts;
}

// refs/remotes/<remote>/<branch>, where the branch itself may hold slashes
const remoteOf = (refs, b) => [...refs].find(r => r.startsWith('refs/remotes/') && r.slice(13).split('/').slice(1).join('/') === b);

function judge(e, f, exists) {
  e.sessions.sort((a, b) => b.at - a.at);
  const row = {
    name: e.name, path: e.path, repo: e.repo, husk: e.husk, branch: null, local: false, remote: null, registered: false, heldBy: null,
    sessions: e.sessions.length, bytes: e.sessions.reduce((n, s) => n + (s.bytes ?? 0), 0), newest: e.sessions[0], restorable: false, why: null,
  };
  if (f.error) return { ...row, why: `git cannot read ${e.repo}: ${f.error}` };
  for (const b of [...e.hints, e.name]) {
    if (f.refs.has(`refs/heads/${b}`)) { row.branch = b; row.local = true; break; }
    const remote = remoteOf(f.refs, b);
    if (remote) { row.branch = b; row.remote = remote.slice('refs/remotes/'.length); break; }
  }
  row.registered = f.byPath.has(e.path);
  const holder = row.branch ? f.byBranch.get(row.branch) : null;
  row.heldBy = holder && holder !== e.path && exists(holder) ? holder : null;
  if (!row.branch) row.why = `its branch is gone (tried ${[...new Set([...e.hints, e.name])].join(', ')})`;
  else if (row.heldBy) row.why = `${row.branch} is checked out at ${row.heldBy}`;
  else row.restorable = true;
  return row;
}

export async function findRestorable({ providers = configuredProviders(), exists = existsSync, gitFn = git } = {}) {
  const found = candidates(providers, exists);
  const facts = await repoFacts([...new Set(found.map(e => e.repo))], gitFn);
  return found.map(e => judge(e, facts.get(e.repo), exists))
    .sort((a, b) => (b.restorable - a.restorable) || (b.newest.at - a.newest.at));
}
