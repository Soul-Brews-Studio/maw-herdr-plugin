import { sh } from './mod.syncCall.mjs';

/** This process and its ancestors: their pids and their process groups, from one `ps`. */
export function ancestry(pid = process.pid, psOut = null) {
  const table = new Map();
  for (const line of (psOut ?? sh('ps', ['-A', '-o', 'pid=,ppid=,pgid='])).split('\n')) {
    const [p, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(p) && p > 0) table.set(p, { ppid, pgid });
  }
  const pids = new Set();
  const groups = new Set();
  for (let p = pid; p > 1 && table.has(p) && !pids.has(p); p = table.get(p).ppid) {
    pids.add(p);
    groups.add(table.get(p).pgid);
  }
  return { pids, groups };
}
