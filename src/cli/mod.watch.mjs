/**
 * `maw herdr watch <target>` — be told when that agent finishes.
 *
 *   watch [<target>] [--every] [--session S] [--dry]   start watching (target defaults to self)
 *   watch --list [--all] [--json]                      what this pane watches (--all: everyone's)
 *   watch [<target>] --stop                            stop watching it from this pane
 *
 * ── How it learns: herdr's pushed status events, never a scan ────────────────
 * herdr streams `pane.agent_status_changed` over `events.subscribe`. The fleet
 * tool this is ported from first read status off a 5 s scan and missed a 4 s job
 * outright, then moved to the event stream; this starts where that ended. There
 * is no loop that re-reads anything: the process sleeps on one open socket until
 * herdr writes a line.
 *
 * ── What "finished" means ─────────────────────────────────────────────────────
 * A completion is the agent going from busy (working, or blocked on a question
 * mid-task) to idle or done. herdr also re-sends the SAME status when only the
 * pane's title or labels change, and follows idle with done, so a raw event is
 * not a completion: working→working, working→blocked→working, idle→done and
 * idle→idle never fire. One completion fires exactly once; a watch is one-shot
 * unless --every, which fires once per completion until stopped.
 *
 * ── Who holds the subscription (the design question) ─────────────────────────
 * A CLI verb exits; a subscription has to outlive it. The options were:
 *   1. the `serve` process owns every watch — but serve is optional, needs the
 *      operator token, and would make a plain CLI verb fail whenever no server
 *      runs, then lose every watch when it restarts;
 *   2. herdr's own facility — `herdr agent wait` blocks until a status is
 *      reached, but it matches the CURRENT status (an idle agent returns at once),
 *      so "working, then not" needs two calls with a race between them, and it
 *      still needs a process to sit in; herdr has no persistent watch of its own;
 *   3. one small detached watcher process per watch, with a record file.
 * This is (3): the smallest thing that is honest about lifetime. `watch` spawns
 * `<runtime> <entry> __watch-run <record>` detached (setsid, no terminal), waits
 * for it to say it has subscribed, and exits. The watcher holds ONE subscription
 * connection (a second when the watching pane lives in another herdr session),
 * files a note into the watching pane's inbox (src/cli/mod.inbox.mjs) and — for a
 * one-shot watch — exits. Cost per watch: one idle process and one socket, the
 * same one open subscription per watched pane the fleet server kept.
 *
 * ── Stale watches clean themselves up ─────────────────────────────────────────
 * The watcher also subscribes to pane.closed / pane.exited / pane.moved /
 * tab.closed / workspace.closed. herdr REPLAYS up to 512 past events on those, so
 * an event naming our pane is a cue to CHECK (one pane.get), never proof: only
 * `pane_not_found` ends the watch. When the watched pane is gone the watcher
 * files a "vanished" note (not a completion) and removes its record; when the
 * WATCHING pane is gone it just removes its record — nobody is left to read it.
 * A dropped connection (herdr restarting) is retried three times, then treated
 * as the session being gone. A watcher that was killed outright leaves a record
 * whose pid no longer runs it; `watch --list` removes those as it reads.
 *
 * Records: <config>/maw-herdr/watches/<id>.json (see stateRoot in mod.inbox.mjs).
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request, subscribe } from './mod.herdrSocket.mjs';
import { fileNote, selfAddress, stateRoot } from './mod.inbox.mjs';
import { describeResolved, requirePane, resolveLive, shq, takeDry } from './mod.target.mjs';

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', off: '\x1b[0m' }
  : { dim: '', cyan: '', green: '', red: '', off: '' };

// --- the completion rule (pure; utils/smoke-watch-inbox.mjs drives it directly) ---

const BUSY = new Set(['working', 'blocked']);
const FINISHED = new Set(['idle', 'done']);

/**
 * Turns a stream of agent statuses into completions. Two inputs:
 *   event(status)  a pushed pane.agent_status_changed
 *   probe(status)  a pane.get taken right after (re)subscribing
 * and one output, onFinish({ status, from, via }), called exactly once per
 * busy→finished transition.
 *
 * `hint` is the status `watch` saw when it resolved the target. It closes the one
 * gap events cannot: an agent that was working when you typed `watch` and
 * finished before the subscription started produces no event at all. So when the
 * probe finds a finished agent that the hint says was busy, the watcher waits
 * `graceMs` for the event that may still be in flight (herdr streams on its own
 * poll interval); if none arrives, the probe itself is the completion. Either
 * path fires once — whichever comes first disarms the other.
 */
export function createCompletionTracker({ hint = null, every = false, graceMs = 1500, onFinish = () => {}, timers = { set: setTimeout, clear: clearTimeout } } = {}) {
  let armed = BUSY.has(hint);
  let from = armed ? hint : null;
  let stopped = false;
  let fired = 0;
  let grace = null;
  let seenSinceProbe = 0;
  const clearGrace = () => { if (grace) timers.clear(grace); grace = null; };
  const fire = (status, via) => {
    clearGrace();
    armed = false;
    fired++;
    if (!every) stopped = true;
    onFinish({ status, from: from ?? 'working', via });
    from = null;
  };
  return {
    event(status) {
      if (stopped) return;
      if (BUSY.has(status)) { seenSinceProbe++; armed = true; from = status === 'working' || !from ? status : from; return; }
      if (FINISHED.has(status)) { seenSinceProbe++; if (armed) fire(status, 'event'); }
      // unknown: a detection gap, neither busy nor finished — changes nothing
    },
    probe(status) {
      if (stopped) return;
      seenSinceProbe = 0;
      clearGrace();
      if (BUSY.has(status)) { armed = true; from = from ?? status; return; }
      if (FINISHED.has(status) && armed) {
        grace = timers.set(() => { grace = null; if (!stopped && armed && seenSinceProbe === 0) fire(status, 'probe'); }, graceMs);
      }
    },
    stop() { stopped = true; clearGrace(); },
    get fired() { return fired; },
    get armed() { return armed; },
    get stopped() { return stopped; },
  };
}

// --- records ------------------------------------------------------------------

const watchDir = (root = stateRoot()) => join(root, 'watches');

function writeRecord(path, record) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function readRecord(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function removeRecord(path, id) {
  const r = readRecord(path);
  if (r && r.id !== id) return;
  rmSync(path, { force: true });
}

/** Is `pid` still THIS watcher? A live pid alone is not enough: pids are reused. */
function watcherAlive(record, path) {
  if (!record.pid) return null;             // still starting
  try { process.kill(record.pid, 0); } catch (err) { if (err?.code === 'ESRCH') return false; }
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(record.pid)], { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return cmd.includes('__watch-run') && cmd.includes(path);
  } catch {
    return false;
  }
}

/** Every live watch record; records whose watcher is gone are removed as they are read. */
export function listWatches(root = stateRoot()) {
  let names;
  try { names = readdirSync(watchDir(root)).filter(n => n.endsWith('.json')); } catch { return { live: [], removed: [] }; }
  const live = [];
  const removed = [];
  for (const name of names) {
    const path = join(watchDir(root), name);
    const r = readRecord(path);
    if (!r?.id) continue;
    const alive = watcherAlive(r, path);
    const starting = alive === null && Date.now() - Date.parse(r.since ?? 0) < 30_000;
    if (alive || starting) live.push({ ...r, path });
    else { rmSync(path, { force: true }); removed.push(r); }
  }
  live.sort((a, b) => String(a.since).localeCompare(String(b.since)));
  return { live, removed };
}

// --- the CLI verb -------------------------------------------------------------

const TICK = () => Math.max(1, Number(process.env.MAW_HERDR_WATCH_TICK_MS) || 1000);

function run(file, args) {
  return new Promise((ok, fail) => {
    execFile(file, args, { encoding: 'utf8', timeout: 10_000 }, (err, stdout) => (err ? fail(err) : ok(stdout)));
  });
}

/** The socket a session listens on, as herdr itself reports it. */
async function sessionSocket(session) {
  let sessions;
  try { sessions = JSON.parse(await run('herdr', ['session', 'list', '--json'])).sessions ?? []; } catch (err) {
    throw new Error(`cannot list herdr sessions to find the socket of '${session}' — ${String(err?.stderr || err?.message || err).trim().split('\n')[0]}\n  herdr session list --json`);
  }
  const s = sessions.find(x => x?.name === session);
  const socket = s?.socket_path ?? (s?.session_dir ? join(s.session_dir, 'herdr.sock') : null);
  if (!s?.running || !socket) {
    throw new Error(`herdr session '${session}' ${s ? 'is not running' : 'is not listed'}, so there is nothing to subscribe to\n  herdr session list --json`);
  }
  return socket;
}

const sameAddr = (a, b) => a?.pane === b?.pane && a?.session === b?.session;
const who = r => `${r.target.label ?? r.target.pane} (${r.target.pane}${r.target.session !== r.watcher.session ? ` · ${r.target.session}` : ''})`;
const stopCmd = r => `maw herdr watch ${r.target.session !== r.watcher.session ? `--session ${shq(r.target.session)} ` : ''}${r.target.pane} --stop`;

function printList(rows, me, all) {
  if (!rows.length) {
    console.log(`  ${C.dim}${all || !me ? 'no watches on this machine' : `pane ${me.pane} watches nothing`} — start one: maw herdr watch <target>${C.off}`);
    return;
  }
  for (const r of rows) {
    const mine = me && sameAddr(r.watcher, me);
    const mode = r.every ? 'every finish' : 'once';
    const by = mine ? '' : `  ${C.dim}← ${r.watcher.pane} · ${r.watcher.session}${C.off}`;
    console.log(`  ${C.green}●${C.off} ${C.cyan}${who(r)}${C.off}  ${C.dim}${mode} · since ${String(r.since).slice(11, 19)} · pid ${r.pid ?? 'starting'}${C.off}${by}`);
  }
  const first = rows.find(r => me && sameAddr(r.watcher, me));
  console.log(`  ${C.dim}${rows.length} watch${rows.length === 1 ? '' : 'es'}${first ? ` · stop one: ${stopCmd(first)}` : ''}${C.off}`);
}

/**
 * `watch` — see the header. `entry` is the script index.mjs is running as (the
 * source file or the bundle), so the watcher re-enters the same build.
 */
export async function cmdWatch(args, { UsageError = Error, entry } = {}) {
  const rest = [...args];
  const dry = takeDry(rest);
  const take = flag => { const at = rest.indexOf(flag); if (at === -1) return false; rest.splice(at, 1); return true; };
  const list = take('--list');
  const stop = take('--stop');
  const every = take('--every');
  const all = take('--all');
  const json = take('--json');
  let session = null;
  const at = rest.indexOf('--session');
  if (at !== -1) {
    session = rest[at + 1];
    if (!session || session.startsWith('-')) throw new UsageError('--session needs a session name; list them:\n  maw herdr ls --sessions');
    rest.splice(at, 2);
  }
  const unknown = rest.find(a => a.startsWith('-'));
  if (unknown) throw new UsageError(`unknown argument: ${unknown} (watch takes one target and --every, --stop, --list, --all, --session, --dry, --json)\n  maw herdr watch --list`);
  if (rest.length > 1) throw new UsageError(`watch takes one target, got ${rest.length}; watch each on its own:\n${rest.map(a => `  maw herdr watch ${shq(a)}`).join('\n')}`);
  if (list && stop) throw new UsageError('--list and --stop are separate; see first, then stop:\n  maw herdr watch --list');
  const raw = rest[0];

  if (list) {
    if (raw) throw new UsageError('--list takes no target\n  maw herdr watch --list');
    let me = null;
    try { me = await selfAddress('watch --list'); } catch {}
    const { live, removed } = listWatches();
    const rows = all || !me ? live : live.filter(r => sameAddr(r.watcher, me));
    if (json) {
      console.log(JSON.stringify({ command: 'watch', mode: 'list', json: true, me, watches: rows.map(({ path, ...r }) => r), removedStale: removed.length }));
      return;
    }
    if (removed.length) console.log(`  ${C.dim}removed ${removed.length} stale watch${removed.length === 1 ? '' : 'es'} whose watcher was no longer running${C.off}`);
    printList(rows, me, all);
    return;
  }

  const me = await selfAddress(stop ? 'watch --stop' : 'watch');

  if (stop) {
    const { live } = listWatches();
    const mine = live.filter(r => sameAddr(r.watcher, me));
    // A pane id or label stops a watch even when the pane is already gone and
    // would no longer resolve; anything else goes through the grammar.
    let hits = raw ? mine.filter(r => r.target.pane === raw || r.target.label === raw) : [];
    if (!hits.length) {
      const r = await resolveLive(raw, { session, verb: 'watch', after: ' --stop' });
      const pane = requirePane(r, 'watch');
      hits = mine.filter(w => w.target.pane === pane && w.target.session === r.session);
    }
    if (!hits.length) {
      throw new Error(`pane ${me.pane} is not watching ${raw ?? 'self'} — nothing was stopped\n  maw herdr watch --list`);
    }
    for (const r of hits) {
      if (!dry) {
        try { process.kill(r.pid, 'SIGTERM'); } catch {}
        rmSync(r.path, { force: true });
      }
      console.log(`  ${dry ? 'would stop' : 'stopped'} watching ${C.cyan}${who(r)}${C.off}${dry ? `  ${C.dim}(pid ${r.pid ?? 'starting'}) · nothing was done${C.off}` : ''}`);
    }
    return;
  }

  const r = await resolveLive(raw, { session, verb: 'watch', after: every ? ' --every' : '' });
  const pane = requirePane(r, 'watch');
  const chosen = r.panes.find(p => p.pane === pane);
  if (!chosen?.agent) {
    throw new Error(`pane ${pane} in '${r.label}' holds no agent (a bare shell), so it never works and never finishes\n  see the agent panes: maw herdr ls --agents`);
  }
  const target = { session: r.session, pane, workspace: r.workspace, label: r.label, agent: chosen.agent };
  const existing = listWatches().live.find(w => sameAddr(w.watcher, me) && sameAddr(w.target, target) && !!w.every === every);
  if (dry) {
    for (const line of describeResolved(r)) console.log(line);
    console.log(`  ${C.dim}would subscribe to herdr's status events for ${pane} and file a note in the inbox of ${me.pane} (${me.session}) ${every ? 'on every finish' : 'when it next finishes'}${existing ? ` — already watching (pid ${existing.pid})` : ''} · nothing was done${C.off}`);
    return;
  }
  if (existing) {
    console.log(`  already watching ${C.cyan}${who(existing)}${C.off} ${C.dim}(${existing.every ? 'every finish' : 'once'}, pid ${existing.pid ?? 'starting'})${C.off}`);
    console.log(`  ${C.dim}read notes: maw herdr inbox · stop: ${stopCmd(existing)}${C.off}`);
    return;
  }

  target.socket = await sessionSocket(target.session);
  const watcher = { session: me.session, pane: me.pane, workspace: me.pane.split(':')[0] };
  watcher.socket = watcher.session === target.session ? target.socket : await sessionSocket(watcher.session);
  const id = randomBytes(6).toString('hex');
  const path = join(watchDir(), `${id}.json`);
  const record = { id, since: new Date().toISOString(), every, hint: r.status ?? null, target, watcher, pid: null };
  writeRecord(path, record);

  const self = entry ?? process.argv[1];
  const child = spawn(process.execPath, [self, '__watch-run', path], {
    detached: true,
    cwd: '/',                     // never pin a worktree directory someone may remove
    stdio: ['ignore', 'pipe', 'ignore'],
    env: process.env,
  });
  const line = await new Promise(resolve => {
    let buf = '';
    const timer = setTimeout(() => resolve('error timeout the watcher did not report within 15 s'), 15_000);
    child.stdout.on('data', d => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) { clearTimeout(timer); resolve(buf.slice(0, nl)); }
    });
    child.on('exit', code => { clearTimeout(timer); resolve(buf.split('\n')[0] || `error exited the watcher exited with code ${code} before subscribing`); });
    child.on('error', err => { clearTimeout(timer); resolve(`error spawn ${err.message}`); });
  });
  child.stdout.destroy();
  child.unref();
  if (!line.startsWith('ready')) {
    try { process.kill(child.pid, 'SIGTERM'); } catch {}
    rmSync(path, { force: true });
    const [, code = 'error', ...msg] = line.split(' ');
    const why = msg.join(' ');
    if (code === 'pane_not_found') {
      throw new Error(`pane ${pane} is gone from herdr session ${target.session} — nothing to watch\n  see the agent panes: maw herdr ls --agents`);
    }
    throw new Error(`could not start watching ${pane}: ${why || code}\n  check herdr answers on ${target.socket}: herdr --session ${shq(target.session)} pane get ${pane}`);
  }
  console.log(`  ${C.green}●${C.off} ${C.cyan}${r.label}${C.off} ${C.dim}${pane} · ${chosen.agent} · ${r.status ?? 'unknown'} · ${r.session}${C.off}`);
  console.log(`  watching — a note lands in the inbox of this pane (${me.pane}) ${every ? 'every time it finishes' : 'when it next finishes'} ${C.dim}(busy → idle/done)${C.off}`);
  console.log(`  ${C.dim}read it: maw herdr inbox · stop: ${stopCmd(record)}${C.off}`);
}

// --- the watcher process ------------------------------------------------------

const CLOSURES = ['pane.closed', 'pane.exited', 'pane.moved', 'tab.closed', 'workspace.closed'].map(type => ({ type }));

/**
 * The detached process behind one watch. Prints exactly one line on stdout —
 * `ready`, or `error <code> <message>` — then never writes to stdout again (the
 * CLI that read it has exited). Returns the exit code.
 */
export async function runWatcher(path) {
  const record = readRecord(path);
  if (!record?.id) { process.stdout.write('error no-record the watch record is missing\n'); return 1; }
  const { target, watcher } = record;
  const tick = TICK();
  let reported = false;
  const report = line => { if (reported) return; reported = true; try { process.stdout.write(`${line}\n`); } catch {} };
  const subs = new Set();
  let exiting = false;
  let resolveExit;
  const exited = new Promise(r => { resolveExit = r; });
  const finish = (code = 0) => {
    if (exiting) return;
    exiting = true;
    tracker.stop();
    for (const s of subs) s.close();
    removeRecord(path, record.id);
    resolveExit(code);
  };
  const readTail = async () => {
    try {
      const out = await request(target.socket, 'pane.read', { pane_id: target.pane, source: 'visible', lines: 15, format: 'text' }, { timeout: 5_000 });
      return (out?.read?.text ?? out?.text ?? '').replace(/\s+$/, '').split('\n').slice(-15).join('\n');
    } catch {
      return '';
    }
  };
  const note = (kind, text, extra = {}) => {
    try {
      fileNote(watcher, { kind, from: { session: target.session, pane: target.pane, label: target.label ?? null, agent: target.agent ?? null }, watch: record.id, text, ...extra });
    } catch {}
  };

  const tracker = createCompletionTracker({
    hint: record.hint,
    every: !!record.every,
    graceMs: Math.round(tick * 1.5),
    onFinish: async ({ status, from, via }) => {
      const tail = await readTail();
      note('finished', `${from} → ${status}`, { status, previous: from, via, tail });
      if (!record.every) finish(0);
    },
  });

  process.on('SIGTERM', () => finish(0));
  process.on('SIGINT', () => finish(0));
  process.on('SIGHUP', () => {});

  // Is this pane still there? Only pane_not_found says no; any other failure is
  // not evidence of anything and is left for the next cue.
  const gone = async (addr) => {
    try { await request(addr.socket, 'pane.get', { pane_id: addr.pane }, { timeout: 5_000 }); return false; } catch (err) { return err?.code === 'pane_not_found'; }
  };
  let checking = false;
  let again = false;
  const check = async () => {
    if (checking) { again = true; return; }
    checking = true;
    try {
      do {
        again = false;
        if (await gone(watcher)) return finish(0);   // nobody left to read a note
        if (await gone(target)) {
          note('vanished', `pane ${target.pane} closed or moved — the watch on it was removed; it did not report finishing`);
          return finish(0);
        }
      } while (again && !exiting);
    } finally {
      checking = false;
    }
  };
  const names = addr => new Set([addr.pane, addr.workspace ?? addr.pane.split(':')[0]]);
  const watchedIds = new Set([...names(target), ...names(watcher)]);
  const onEvent = msg => {
    if (exiting) return;
    const d = msg.data ?? {};
    if (msg.event === 'pane.agent_status_changed') {
      if (d.pane_id === target.pane && typeof d.agent_status === 'string') tracker.event(d.agent_status);
      return;
    }
    const ids = [d.pane_id, d.previous_pane_id, d.workspace_id, d.previous_workspace_id];
    if (ids.some(x => x && watchedIds.has(x))) void check();
  };

  // One subscription per herdr session involved. The target's carries its status
  // events; subscribing to them probes the pane, so a vanished pane is an error here.
  const open = async (addr, withStatus) => {
    const subscriptions = [...(withStatus ? [{ type: 'pane.agent_status_changed', pane_id: target.pane }] : []), ...CLOSURES];
    const sub = subscribe(addr.socket, subscriptions, { onEvent, onClose: () => { subs.delete(sub); void reconnect(addr, withStatus); } });
    subs.add(sub);
    try { await sub.ready; } catch (err) { subs.delete(sub); throw err; }
    return sub;
  };
  const probe = async () => {
    try {
      const out = await request(target.socket, 'pane.get', { pane_id: target.pane }, { timeout: 5_000 });
      const status = out?.pane?.agent_status ?? out?.agent_status;
      if (typeof status === 'string') tracker.probe(status);
    } catch (err) {
      if (err?.code === 'pane_not_found') await check();
    }
  };
  // herdr restarting drops the stream. Retry three times (1, 2, 4 ticks), then
  // take the session as gone rather than keep a watch that can never fire.
  const reconnect = async (addr, withStatus) => {
    for (let attempt = 0; attempt < 3 && !exiting; attempt++) {
      await new Promise(r => setTimeout(r, tick * 2 ** attempt));
      if (exiting) return;
      try {
        await open(addr, withStatus);
        if (withStatus) await probe();
        await check();
        return;
      } catch (err) {
        if (err?.code === 'pane_not_found') { await check(); return; }
      }
    }
    if (exiting) return;
    if (withStatus) note('vanished', `herdr session ${addr === target ? target.session : watcher.session} stopped answering on ${addr.socket} — the watch on ${target.pane} was removed`);
    finish(0);
  };

  try {
    await open(target, true);
    if (watcher.socket !== target.socket) await open(watcher, false);
    else watchedIds.add(watcher.pane);
    if (await gone(watcher)) throw Object.assign(new Error(`the watching pane ${watcher.pane} is gone`), { code: 'watcher_not_found' });
    record.pid = process.pid;
    if (!exiting) writeRecord(path, record);
    await probe();
  } catch (err) {
    report(`error ${err?.code ?? 'error'} ${String(err?.message ?? err).replace(/\n/g, ' ')}`);
    finish(1);
    return exited;
  }
  report('ready');
  return exited;
}
