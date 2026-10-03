/**
 * A husk: a worktree's folder that is back on disk WITHOUT its checkout — no .git.
 * Measured: a launchd job kept writing its logs to <worktree>/ψ/memory/logs/… after
 * the worktree was removed, and so recreated the folder around two log files. git
 * will not add a worktree into a folder that is not empty, so restore moves the husk
 * aside, adds the worktree, then copies each leftover file back where the checkout
 * has none. The moved-aside folder stays as the backup: nothing is deleted.
 */
import { copyFileSync, constants, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** Every file under dir, as absolute paths. */
export function filesUnder(dir) {
  const out = [];
  const walk = d => {
    let list = [];
    try { list = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// local time, as the release tags read it: 20261003-0850
const two = n => String(n).padStart(2, '0');
export const huskStamp = (d = new Date()) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;

/** Rename the husk to <path>.husk-<stamp>; returns the new path. */
export function moveAside(path, stamp = huskStamp()) {
  const to = `${path}.husk-${stamp}`;
  renameSync(path, to);
  return to;
}

/** Copy each file from the backup into the checkout where the checkout has none. */
export function copyBack(backup, path) {
  let copied = 0;
  let kept = 0;
  for (const src of filesUnder(backup)) {
    const dst = join(path, relative(backup, src));
    if (existsSync(dst)) { kept++; continue; }
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst, constants.COPYFILE_EXCL);
    copied++;
  }
  return { copied, kept };
}
