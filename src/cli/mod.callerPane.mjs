/**
 * Which herdr pane is this process REALLY in? (#88)
 *
 * herdr exports HERDR_PANE_ID into a pane when the pane's process starts and never
 * updates it. `herdr pane move` to another workspace gives the pane a new id, so
 * after a move the environment names a pane that is gone — or, once herdr hands
 * that id out again, a different pane. Measured: after five moves an agent's
 * environment still said w7N:p1 while it sat in w7D:pC. `herdr pane current` has
 * the same blind spot: it echoes the environment.
 *
 * The truth is in the process tree. A pane's foreground process group is either
 * this process's own group (a command typed at the pane's shell) or an ancestor's
 * (a command an agent runs: the agent is the foreground job, its tool commands
 * are its descendants). And the pane's shell (`shell_pid`) is an ancestor of
 * anything started from it. Either one is a POSITIVE match.
 *
 * Only a positive match on ANOTHER pane overrides the environment. A detached
 * worker (watch's __watch-run) sits in no pane's foreground group and keeps the
 * environment's value, exactly as before; so does every failure to ask herdr or
 * ps. The common case costs one `ps` and one `pane process-info`; the scan of
 * every pane in the session happens only when the environment's pane is not ours.
 *
 * Inbox ADDRESSES are not this module's business: mod.inbox.mjs keeps using the
 * environment's id on purpose (the agent keeps reading the id it was born with).
 * This decides what `self` resolves to when a verb acts on a pane.
 */
import { execFileSync } from 'node:child_process';

const sh = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
const withSession = (args, session) => (session ? ['--session', session, ...args] : args);
const herdrJson = (args, session) => JSON.parse(sh('herdr', withSession(args, session)));

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

/** A pane's foreground process group and shell pid, or null when herdr says neither. */
export function paneProcess(pane, session) {
  const info = herdrJson(['pane', 'process-info', '--pane', pane], session)?.result?.process_info;
  const fg = info?.foreground_process_group_id;
  const shell = info?.shell_pid;
  return Number.isInteger(fg) || Number.isInteger(shell) ? { fg, shell } : null;
}

/** Every pane id in the session — from `api snapshot`, the read the smokes already allow. */
export function sessionPanes(session) {
  const raw = herdrJson(['api', 'snapshot'], session);
  const snap = raw?.result?.snapshot ?? raw?.result ?? raw;
  return (snap?.panes ?? []).map(p => p.pane_id).filter(Boolean);
}

const ours = (proc, me) => !!proc && (
  (Number.isInteger(proc.fg) && me.groups.has(proc.fg)) ||
  (Number.isInteger(proc.shell) && me.pids.has(proc.shell))
);

/**
 * The caller, checked: `{ ...caller, confirmed: true }` when its pane is ours,
 * `{ ...caller, pane: <live id>, stale: <env id>, confirmed: true }` when another
 * pane is, and the caller unchanged (no `confirmed`) when nothing could be told.
 * `me`, `info` and `panes` are injectable so this can be checked without herdr.
 */
export function verifyCaller(caller, { me = null, info = paneProcess, panes = sessionPanes } = {}) {
  if (!caller?.pane) return caller;
  try {
    const self = me ?? ancestry();
    let own = null;
    try { own = info(caller.pane, caller.session); } catch { /* gone, or herdr cannot say */ }
    if (ours(own, self)) return { ...caller, confirmed: true };
    for (const id of panes(caller.session)) {
      if (id === caller.pane) continue;
      let proc = null;
      try { proc = info(id, caller.session); } catch { continue; }
      if (ours(proc, self)) return { ...caller, pane: id, stale: caller.pane, confirmed: true };
    }
  } catch { /* no ps, no herdr, no snapshot: today's behaviour */ }
  return caller;
}
