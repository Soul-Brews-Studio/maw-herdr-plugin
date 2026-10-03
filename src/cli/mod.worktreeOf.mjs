// The worktree a working directory sits in, by the fleet's <repo>/wt/<folder>
// layout: { repo, name, path } or null. A transcript records the directory a
// session started in, which may be deeper inside the worktree (ψ/writing/…).
import { sep } from 'node:path';

export const WT = `${sep}wt${sep}`;

export function worktreeOf(cwd) {
  const i = cwd.indexOf(WT);
  if (i <= 0) return null;
  const name = cwd.slice(i + WT.length).split(sep)[0];
  if (!name) return null;
  const repo = cwd.slice(0, i);
  return { repo, name, path: `${repo}${WT}${name}` };
}
