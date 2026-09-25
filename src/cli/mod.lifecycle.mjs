/**
 * Lifecycle verbs (#62): restart, resume, kill, close. `wake` starts an agent;
 * these stop and revive one. Every target goes through the #59 grammar
 * (mod.target.mjs) and every verb honours --dry, which prints what the target
 * resolved to and the exact commands it would run, then does nothing.
 *
 *   restart <target> [--channel <entry> | --no-channel]
 *       quit the agent and relaunch it in the SAME pane with the SAME herdr name.
 *       argv is read from the RUNNING process (decided in #57): the pane's
 *       foreground pid comes from `herdr pane process-info`; its argv from
 *       /proc/<pid>/cmdline on Linux, or from `ps -p <pid>` on macOS (split as
 *       herdr reports it, and only when the two agree). The session is pinned to
 *       the one herdr reports for the pane (mod.agentArgv.mjs). A target with no
 *       live agent has no argv to read, so restart refuses and names `resume`.
 *   resume <target>
 *       start the agent on the newest transcript for the target's worktree, found
 *       by a resume provider (mod.resumeLookup.mjs); opens a herdr space first when
 *       the worktree has none. Refuses a target that already runs an agent.
 *   kill <target>
 *       Ctrl-C the agent until its process is gone. The pane (and the space) stay.
 *   close <target> [--force]
 *       close the target's herdr space. The worktree and its transcript stay. A
 *       space with a live agent is refused without --force, listing the kills.
 *
 * `restart self` and `kill self` run from an agent's own `!` prompt: the command is
 * then a descendant of the process it stops, and dies with it. Whenever the target
 * is the caller's own pane, or the target process is one of this process's
 * ancestors, the work is handed to a detached copy of this CLI (new session, stdin
 * carries the plan, output appended to <maw state>/herdr/lifecycle.log) and the
 * command returns at once. Otherwise it runs in the foreground and reports.
 *
 * Every herdr call names the target's session with --session, and the binary is
 * always `herdr` from PATH, never HERDR_BIN_PATH (see mod.target.mjs for why).
 */
import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TargetError, callerFromEnv, describeResolved, requirePane, resolveLive, shq, takeDry } from './mod.target.mjs';
import { agentName, dedupeArgs, hasDevChannel, knowsResume, redactArgs, sessionInArgs, withChannel, withSession } from './mod.agentArgv.mjs';
import { SAFE_ID, configuredProviders, encodeClaudeDir, findSessions } from './mod.resumeLookup.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Ctrl-C until the process is gone, not a fixed two: an agent mid-turn spends the
// first cancelling the turn and the second arming "press again to exit".
const QUIT_TRIES = 8;
const QUIT_EVERY_MS = 600;
const START_TIMEOUT_MS = 120_000;
// The development-channel warning is drawn only after the agent has started its
// MCP servers; with ~30 configured that took longer than 20 s on a real pane.
const CHANNEL_WATCH_MS = 90_000;

/** How each resume provider's session is started: the herdr agent kind and its args. */
export const RESUME_LAUNCH = {
  claude: id => ({ kind: 'claude', args: ['--resume', id] }),
  codex: id => ({ kind: 'codex', args: ['resume', id] }),
};

// --- herdr and process plumbing --------------------------------------------------------

function run(file, args, { timeout = 15_000 } = {}) {
  return new Promise((ok, fail) => {
    execFile(file, args, { encoding: 'utf8', timeout, maxBuffer: 32 << 20 }, (err, stdout, stderr) => {
      if (err) {
        err.detail = String(stderr || err.message || '').trim().split('\n')[0];
        err.text = `${stdout ?? ''}\n${stderr ?? ''}`;
        fail(err);
      } else ok(stdout);
    });
  });
}

const withSessionFlag = (args, session) => (session ? ['--session', session, ...args] : args);
const herdrLine = (args, session) => ['herdr', ...withSessionFlag(args, session)].map(shq).join(' ');

async function herdr(args, session, opts) {
  try {
    return await run('herdr', withSessionFlag(args, session), opts);
  } catch (err) {
    if (err?.code === 'ENOENT') throw new TargetError('herdr is not on PATH\n  command -v herdr || echo "herdr not on PATH: $PATH"', 'not-found');
    const e = new TargetError(`herdr ${args.slice(0, 2).join(' ')} failed — ${err.detail || err.message}\n  ${herdrLine(args, session)}`, 'herdr');
    e.text = err.text ?? '';
    throw e;
  }
}
const herdrJson = async (args, session, opts) => JSON.parse(await herdr(args, session, opts));

/** The pid is alive (EPERM means it exists but belongs to someone else). */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

const base = s => basename(String(s ?? ''));

/**
 * What runs in the foreground of a pane, from `herdr pane process-info`. A pane whose
 * foreground process group is its shell's runs nothing. Otherwise the process that
 * is the agent kind herdr detected is preferred (the group also holds the agent's
 * MCP children), else the group leader.
 */
export async function paneProcess(pane, session, kind = null) {
  const raw = await herdrJson(['pane', 'process-info', '--pane', pane], session);
  const pi = raw?.result?.process_info ?? raw?.process_info ?? {};
  const shell = pi.shell_pid ?? null;
  const pg = pi.foreground_process_group_id ?? null;
  const procs = Array.isArray(pi.foreground_processes) ? pi.foreground_processes : [];
  if (!pg || pg === shell) return { running: false, shell };
  const isKind = p => kind && (base(p.argv0) === kind || base(p.argv?.[0]) === kind || p.name === kind);
  const proc = procs.find(isKind) ?? procs.find(p => p.pid === pg) ?? { pid: pg };
  const text = `${proc.argv0 ?? ''} ${proc.name ?? ''} ${proc.cmdline ?? (proc.argv ?? []).join(' ')}`;
  return {
    running: true,
    shell,
    pid: proc.pid,
    name: proc.name || base(proc.argv0 ?? proc.argv?.[0]) || '?',
    herdrArgv: Array.isArray(proc.argv) && proc.argv.length ? proc.argv.map(String) : null,
    isAgent: !kind || isKind(proc) || text.includes(kind),
  };
}

/**
 * argv of a live pid, read from the process itself. Linux: /proc/<pid>/cmdline, exact.
 * Elsewhere (macOS): `ps -ww -o args= -p <pid>`, which joins argv with spaces, so the
 * boundaries are taken from herdr's own argv for that pid — and only when ps agrees
 * with it, which also proves the pid is still the process herdr described.
 * Returns null when the process is gone.
 */
export async function readArgv(pid, herdrArgv = null) {
  if (process.platform === 'linux') {
    try {
      const parts = readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0');
      if (parts.at(-1) === '') parts.pop();
      if (parts.length) return { argv: parts, source: `/proc/${pid}/cmdline` };
    } catch {}
  }
  let line;
  try { line = (await run('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { timeout: 5_000 })).replace(/\s+$/, ''); } catch { return null; }
  if (!line) return null;
  if (herdrArgv) {
    if (line === herdrArgv.join(' ') || line.startsWith(`${herdrArgv.join(' ')} `)) return { argv: herdrArgv, source: `ps -p ${pid}, split as herdr reports it` };
    return { argv: null, source: `ps -p ${pid}`, mismatch: true };
  }
  return { argv: line.split(/\s+/), source: `ps -p ${pid} (split on spaces: herdr gave no argv)` };
}

async function parentOf(pid) {
  try { return Number((await run('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 5_000 })).trim()) || null; } catch { return null; }
}

/** pid is this process or one of its ancestors — stopping it would stop us too. */
export async function isOurAncestor(pid) {
  if (pid === process.pid) return true;
  let cur = process.ppid;
  for (let i = 0; i < 64 && cur && cur > 1; i++) {
    if (cur === pid) return true;
    cur = await parentOf(cur);
  }
  return false;
}

/** The session herdr reports for the agent in a pane (agent-agnostic: herdr tracks it). */
async function paneSessionId(pane, session) {
  try {
    const raw = await herdrJson(['pane', 'get', pane], session);
    const s = (raw?.result?.pane ?? raw?.pane)?.agent_session;
    // it is typed into the pane's shell on relaunch: only an id that looks like one
    return typeof s?.value === 'string' && SAFE_ID.test(s.value) ? s.value : null;
  } catch {
    return null;
  }
}

async function quitPid(pane, session, pid, log) {
  for (let i = 0; i < QUIT_TRIES && alive(pid); i++) {
    await herdr(['pane', 'send-keys', pane, 'ctrl+c'], session);
    log?.(`sent ctrl+c to ${pane} (${i + 1})`);
    await sleep(QUIT_EVERY_MS);
  }
  return !alive(pid);
}

/** `herdr agent start` needs the pane back at its shell prompt. */
async function waitForShell(pane, session, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const p = await paneProcess(pane, session).catch(() => null);
    if (p && !p.running) return true;
    await sleep(200);
  }
  return false;
}

/**
 * A claude loading a development channel stops on a warning at startup with
 * "I am using this for local development" preselected; accept it, or the relaunch
 * sits unattended. herdr 0.9 answers `agent start` for an agent blocked at startup
 * with `agent_not_ready` at once; older versions waited for readiness, which an agent
 * parked on the warning never reaches. So this watches WHILE the start runs, stops
 * if the start comes back ready, and keeps watching if it comes back blocked.
 */
async function acceptChannelWarning(pane, session, ready) {
  const end = Date.now() + CHANNEL_WATCH_MS;
  while (Date.now() < end && !ready()) {
    await sleep(500);
    const screen = await herdr(['pane', 'read', pane, '--source', 'visible', '--lines', '40'], session).catch(() => '');
    if (/Loading development channels/i.test(screen) && /I am using this for local development/i.test(screen)) {
      await herdr(['pane', 'send-keys', pane, 'enter'], session);
      return true;
    }
  }
  return false;
}

const startArgs = plan => ['agent', 'start', plan.name, '--kind', plan.kind, '--pane', plan.pane, '--timeout', String(START_TIMEOUT_MS), ...(plan.args.length ? ['--', ...plan.args] : [])];

async function startAgent(plan, log) {
  let outcome = 'pending';
  const started = herdr(startArgs(plan), plan.session, { timeout: START_TIMEOUT_MS + 30_000 }).then(
    () => { outcome = 'ready'; },
    err => {
      if (/agent_not_ready/.test(err?.text ?? '') || /agent_not_ready/.test(err?.message ?? '')) { outcome = 'blocked'; return; }
      outcome = 'failed';
      throw err;
    },
  );
  const accept = hasDevChannel(plan.args) ? acceptChannelWarning(plan.pane, plan.session, () => outcome === 'ready' || outcome === 'failed') : Promise.resolve(false);
  const [ok, accepted] = await Promise.allSettled([started, accept]);
  if (ok.status === 'rejected') throw ok.reason;
  const took = accepted.status === 'fulfilled' && accepted.value === true;
  if (took) log?.(`accepted the development-channel warning in ${plan.pane}`);
  if (outcome === 'blocked' && !took) {
    throw new TargetError(`${plan.kind} started in ${plan.pane} as "${plan.name}" but is blocked on a startup screen (herdr: agent_not_ready) — it needs an answer before it takes input; look at it:\n  ${herdrLine(['pane', 'read', plan.pane, '--source', 'visible', '--lines', '30'], plan.session)}`, 'blocked');
  }
}

// --- plans: what each mutating verb does, runnable in the foreground or detached -------

async function performRestart(plan, log) {
  log(`restart ${plan.pane}: quitting ${plan.kind} pid ${plan.pid}`);
  if (!(await quitPid(plan.pane, plan.session, plan.pid, log))) {
    throw new TargetError(`${plan.kind} pid ${plan.pid} in ${plan.pane} did not exit after ${QUIT_TRIES} ctrl+c — it was not relaunched; look at it, then stop it by hand:\n  ${herdrLine(['pane', 'read', plan.pane, '--source', 'visible', '--lines', '20'], plan.session)}\n  kill ${plan.pid}`, 'stuck');
  }
  if (!(await waitForShell(plan.pane, plan.session))) {
    throw new TargetError(`${plan.pane} did not return to its shell prompt after ${plan.kind} exited — not relaunching into it; see what holds it:\n  ${herdrLine(['pane', 'process-info', '--pane', plan.pane], plan.session)}`, 'stuck');
  }
  // the prompt being drawn is when direnv reloads .envrc, the point of most restarts
  await sleep(500);
  log(`restart ${plan.pane}: relaunching as "${plan.name}"`);
  await startAgent(plan, log);
  const now = await paneProcess(plan.pane, plan.session, plan.kind).catch(() => null);
  log(`restart ${plan.pane}: ${plan.kind} is back${now?.running ? ` as pid ${now.pid}` : ''}, agent "${plan.name}"`);
  return now;
}

async function performKill(plan, log) {
  if (!(await quitPid(plan.pane, plan.session, plan.pid, log))) {
    throw new TargetError(`${plan.kind ?? 'process'} pid ${plan.pid} in ${plan.pane} did not exit after ${QUIT_TRIES} ctrl+c; look at it, then stop it by hand:\n  ${herdrLine(['pane', 'read', plan.pane, '--source', 'visible', '--lines', '20'], plan.session)}\n  kill ${plan.pid}`, 'stuck');
  }
  log(`kill ${plan.pane}: pid ${plan.pid} is gone; the pane stays`);
}

const PERFORM = { restart: performRestart, kill: performKill };

/** Where detached work reports: maw's state dir (same rule as the server), herdr/lifecycle.log. */
export function lifecycleLogPath(env = process.env) {
  const home = env.HOME || homedir();
  const xdg = ['1', 'true', 'yes', 'on'].includes((env.MAW_XDG || '').toLowerCase());
  const state = env.MAW_HOME || env.MAW_STATE_DIR || (xdg ? join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'maw') : join(home, '.maw'));
  return join(state, 'herdr', 'lifecycle.log');
}

// The entry to re-run for the detached worker: index.mjs from source, or the bundle
// itself (bun build inlines this module, so import.meta.url is then the bundle).
function entryFile() {
  const here = fileURLToPath(import.meta.url);
  return basename(here) === 'mod.lifecycle.mjs' ? resolve(dirname(here), '../../index.mjs') : here;
}
const runtimeBin = () => (/^(bun|node)(\.exe)?$/.test(basename(process.execPath)) ? process.execPath : process.versions.bun ? 'bun' : 'node');

/** Hand a plan to a detached copy of this CLI; it outlives the agent it stops. */
function spawnWorker(plan) {
  const log = lifecycleLogPath();
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, 'a', 0o600);
  try {
    // the plan goes over stdin: not argv (ps shows it) and not a file left behind
    const child = spawn(runtimeBin(), [entryFile(), plan.verb, '--worker'], { detached: true, stdio: ['pipe', fd, fd], cwd: homedir(), env: process.env });
    child.stdin.end(JSON.stringify(plan));
    child.unref();
    return { pid: child.pid, log };
  } finally {
    closeSync(fd);
  }
}

async function runWorker(verb) {
  const chunks = [];
  const timer = setTimeout(() => { process.stderr.write(`maw herdr ${verb} --worker: no plan on stdin\n`); process.exit(2); }, 10_000);
  for await (const c of process.stdin) chunks.push(c);
  clearTimeout(timer);
  const plan = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const log = line => console.log(`${new Date().toISOString()} ${line}`);
  if (plan.verb !== verb || !PERFORM[verb]) throw new Error(`worker plan is for '${plan.verb}', not '${verb}'`);
  // let the command that scheduled this print and return to its agent first
  await sleep(300);
  try {
    await PERFORM[verb](plan, log);
  } catch (err) {
    log(`${verb} ${plan.pane} FAILED: ${err.message}`);
    process.exitCode = 1;
  }
}

// --- argument parsing --------------------------------------------------------------------

const HELP = {
  restart: `maw herdr restart [<target>] [--channel <entry> | --no-channel] [--session <name>] [--dry]
  Quit the agent and relaunch it in the same pane, keeping its herdr name, with the
  argv read from its running process (session pinned to the one herdr reports).
  Needs a live agent; a stopped one comes back with 'maw herdr resume <target>'.
  --channel server:fleet   also load that development channel (claude); the startup
                           warning is accepted for you
  --no-channel             drop every development channel
  From an agent's own ! prompt, 'maw herdr restart self' hands off to a detached
  worker and returns; follow it in ${lifecycleLogPath()}.`,
  resume: `maw herdr resume [<target>] [--session <name>] [--dry]
  Start the agent on the newest transcript for the target's worktree (resume
  providers: MAW_HERDR_RESUME_PROVIDERS, MAW_HERDR_CLAUDE_ROOTS, MAW_HERDR_CODEX_ROOTS),
  opening a herdr space for it when there is none. Refuses a running agent.`,
  kill: `maw herdr kill [<target>] [--session <name>] [--dry]
  Ctrl-C the agent until its process exits. The pane and the space stay open.`,
  close: `maw herdr close [<target>] [--force] [--session <name>] [--dry]
  Close the target's herdr space. The worktree and its transcript stay on disk.
  A space holding a live agent needs --force.`,
};

function parse(args, verb, UsageError) {
  const rest = [...args];
  const o = { dry: takeDry(rest), session: null, force: false, channel: undefined, worker: false, help: false, target: undefined };
  const pos = [];
  const value = (i, flag) => {
    const a = rest[i];
    const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : rest[i + 1];
    return { v, skip: a.includes('=') ? 0 : 1, flag };
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--session' || a.startsWith('--session=')) {
      const { v, skip } = value(i, '--session');
      if (!v || v.startsWith('-')) throw new UsageError('--session needs a session name; list them:\n  maw herdr ls --sessions');
      o.session = v; i += skip;
    } else if (verb === 'close' && a === '--force') o.force = true;
    else if (verb === 'restart' && (a === '--channel' || a.startsWith('--channel='))) {
      const { v, skip } = value(i, '--channel');
      if (!v || v.startsWith('-')) throw new UsageError('--channel needs the development channel to load:\n  maw herdr restart self --channel server:fleet');
      o.channel = v; i += skip;
    } else if (verb === 'restart' && a === '--no-channel') o.channel = false;
    else if (a === '--worker' && PERFORM[verb]) o.worker = true;
    else if (a.startsWith('-')) throw new UsageError(`unknown argument: ${a}\n  maw herdr ${verb} --help`);
    else pos.push(a);
  }
  if (pos.length > 1) throw new UsageError(`${verb} takes one target, got ${pos.length}; name each on its own:\n${pos.map(p => `  maw herdr ${verb} ${shq(p)}`).join('\n')}`);
  o.target = pos[0];
  return o;
}

// --- shared helpers for the verbs ------------------------------------------------------

const paneHandle = (r, pane) => `--session ${shq(r.session)} ${pane}`;
// how to name a target again in a printed command: a worktree by its path; a plain
// space by its pane, because its path is borrowed from whatever its pane sits in
const targetHandle = (r, pane = r.pane) => (r.kind === 'worktree' ? shq(r.path) : pane ? paneHandle(r, pane) : shq(r.label));
const resumeHint = (r, pane) => `  maw herdr resume ${targetHandle(r, pane)}`;

function printResolved(r) {
  for (const line of describeResolved(r)) console.log(line);
}

const isCaller = (caller, r, pane) => !!caller?.pane && caller.pane === pane && (!caller.session || !r.session || caller.session === r.session);

// --- restart ---------------------------------------------------------------------------

export async function cmdRestart(args, { UsageError = Error } = {}) {
  const o = parse(args, 'restart', UsageError);
  if (o.help) return void console.log(HELP.restart);
  if (o.worker) return runWorker('restart');
  const caller = callerFromEnv();
  const r = await resolveLive(o.target, { session: o.session, verb: 'restart', caller });

  const notRunning = (why, pane) => new TargetError(
    `'${r.label}' ${why} — restart reads the agent's argv from its live process, so there is nothing to restart. Bring it back from its transcript instead:\n${resumeHint(r, pane)}`,
    'not-running',
  );
  if (!r.workspace) throw notRunning(r.prunable ? 'is a prunable worktree with no open herdr space' : 'has no open herdr space and no running agent');
  const pane = requirePane(r, 'restart');
  if (!r.agent) throw notRunning(`has no agent running in pane ${pane}`, pane);
  const proc = await paneProcess(pane, r.session, r.agent);
  if (!proc.running) throw notRunning(`has no ${r.agent} running in pane ${pane} (herdr still lists it, but the pane is at its shell prompt)`, pane);
  if (!proc.isAgent) {
    throw new TargetError(`the foreground process in pane ${pane} (${proc.name}, pid ${proc.pid}) is not the ${r.agent} herdr detected there — nothing was done; see what is in front of it:\n  ${herdrLine(['pane', 'read', pane, '--source', 'visible', '--lines', '20'], r.session)}`, 'busy');
  }
  const read = await readArgv(proc.pid, proc.herdrArgv);
  if (!read) throw notRunning(`has no live process behind pane ${pane} (pid ${proc.pid} is gone)`, pane);
  if (read.mismatch) {
    throw new TargetError(`ps and herdr disagree about pid ${proc.pid}'s command line in pane ${pane} — it changed or exited while being read; nothing was done. Check again:\n  maw herdr restart ${paneHandle(r, pane)} --dry`, 'changed');
  }

  // relaunch = the process's own argv minus argv[0] (herdr runs the kind's executable)
  let relaunch = dedupeArgs(read.argv.slice(1));
  const herdrSession = await paneSessionId(pane, r.session);
  let sessionNote;
  if (knowsResume(r.agent)) {
    const id = herdrSession ?? sessionInArgs(r.agent, relaunch);
    if (!id) {
      throw new TargetError(
        `herdr reports no session for the ${r.agent} in pane ${pane} (pid ${proc.pid}) and its argv names none, so a relaunch would open a NEW conversation — nothing was done. Stop it and resume its newest transcript instead:\n  maw herdr kill ${paneHandle(r, pane)} && maw herdr resume ${targetHandle(r, pane)}`,
        'no-session',
      );
    }
    relaunch = withSession(r.agent, relaunch, id).args;
    sessionNote = `${id} (${herdrSession ? 'herdr agent_session' : 'already in its argv'})`;
  } else {
    sessionNote = `not pinned — the ${r.agent} resume syntax is not known here, so its argv is reused as read`;
  }
  relaunch = withChannel(relaunch, o.channel);
  const current = r.panes.find(p => p.pane === pane)?.name;
  const plan = {
    verb: 'restart', session: r.session, pane, pid: proc.pid, kind: r.agent,
    name: current || agentName(`${r.agent}-${pane.replace(':', '-')}`),
    args: relaunch,
  };
  const shown = { ...plan, args: redactArgs(plan.args) };
  const lines = [
    `  restart   ${pane} · ${plan.kind} pid ${plan.pid} · agent "${plan.name}"${current ? '' : ' (herdr had no name for it; this one is derived from the pane)'}`,
    `    argv    read from ${read.source}`,
    `    session ${sessionNote}`,
    `    quit    ctrl+c until pid ${plan.pid} exits (up to ${QUIT_TRIES})`,
    `    start   ${herdrLine(startArgs(shown), plan.session)}`,
  ];
  if (hasDevChannel(plan.args)) lines.push('    channel a development channel is loaded; its startup warning will be accepted');

  if (o.dry) {
    printResolved(r);
    for (const l of lines) console.log(l);
    console.log('  --dry: nothing was done');
    return;
  }
  if (isCaller(caller, r, pane) || (await isOurAncestor(plan.pid))) {
    const w = spawnWorker(plan);
    for (const l of lines) console.log(l);
    console.log(`  restart scheduled — this command runs inside the agent it restarts, so a detached worker (pid ${w.pid}) does it and survives the quit. Follow it:\n  tail -n 20 ${shq(w.log)}`);
    return;
  }
  for (const l of lines) console.log(l);
  const now = await performRestart(plan, () => {});
  console.log(`  restarted ${r.label} in ${pane} — ${plan.kind} pid ${plan.pid} → ${now?.running ? `pid ${now.pid}` : 'relaunched'}, agent "${plan.name}"`);
}

// --- resume ----------------------------------------------------------------------------

export async function cmdResume(args, { UsageError = Error } = {}) {
  const o = parse(args, 'resume', UsageError);
  if (o.help) return void console.log(HELP.resume);
  const caller = callerFromEnv();
  const r = await resolveLive(o.target, { session: o.session, verb: 'resume', caller });
  if (r.prunable) requirePane({ ...r, pane: null, paneChoices: null }, 'resume');   // throws the prune fix

  const live = r.panes.filter(p => p.agent);
  if (live.length) {
    throw new TargetError(
      `'${r.label}' already runs ${live.length === 1 ? `a ${live[0].agent} in ${live[0].pane}` : `${live.length} agents`} — resume brings back a stopped agent. To relaunch a running one with a fresh environment:\n${live.map(p => `  maw herdr restart ${paneHandle(r, p.pane)}`).join('\n')}`,
      'running',
    );
  }

  const providers = configuredProviders();
  const found = findSessions(providers, new Map([[r.path, r.path]])).get(r.path);
  if (!found) {
    const where = providers.flatMap(p => p.roots.map(root => (p.name === 'claude' ? join(root, encodeClaudeDir(r.path)) : root)));
    throw new TargetError(
      providers.length
        ? `no transcript to resume for ${r.path} — searched ${providers.map(p => p.name).join(', ')}:\n${where.map(w => `    ${w}`).join('\n')}\n  see what is there: ls -la ${where.map(shq).join(' ')}`
        : `every resume provider is off (MAW_HERDR_RESUME_PROVIDERS=${process.env.MAW_HERDR_RESUME_PROVIDERS}), so no transcript can be found for ${r.path}\n  MAW_HERDR_RESUME_PROVIDERS=claude,codex maw herdr resume ${targetHandle(r)}`,
      'no-transcript',
    );
  }
  const launch = RESUME_LAUNCH[found.provider]?.(found.id);
  if (!launch) throw new TargetError(`no launch rule for resume provider '${found.provider}'\n  MAW_HERDR_RESUME_PROVIDERS=claude,codex maw herdr resume ${targetHandle(r)}`, 'no-transcript');

  const createSession = r.session ?? o.session ?? caller?.session ?? null;
  // A worktree opens through `worktree open --cwd <repo root>`, which binds the space
  // to its repo so herdr (and the next resolve) sees it as that worktree; a space made
  // with `workspace create --cwd` carries no worktree block and would resolve as a
  // separate plain space beside a still-"closed" worktree.
  const create = r.repoRoot
    ? ['worktree', 'open', '--cwd', r.repoRoot, '--path', r.path, '--no-focus']
    : ['workspace', 'create', '--cwd', r.path, '--label', r.label, '--no-focus'];
  const name = agentName(r.label);
  const plan = { verb: 'resume', session: createSession, pane: r.pane, name, kind: launch.kind, args: launch.args };
  const lines = [
    `  resume    ${r.label} · ${found.provider} session ${found.id}`,
    `    from    ${found.file} (${(found.bytes / 1024).toFixed(0)} KB, ${new Date(found.at).toISOString()})`,
    r.pane ? `    pane    ${r.pane} (open space ${r.workspace}, at its shell prompt)` : `    open    ${herdrLine(create, createSession)}`,
    `    start   ${herdrLine(startArgs({ ...plan, pane: r.pane ?? '<new root pane>' }), createSession)}`,
  ];
  if (o.dry) {
    printResolved(r);
    for (const l of lines) console.log(l);
    console.log('  --dry: nothing was done');
    return;
  }

  let pane = r.pane;
  if (pane) {
    const busy = await paneProcess(pane, r.session);
    if (busy.running) {
      throw new TargetError(`pane ${pane} is running ${busy.name} (pid ${busy.pid}), not sitting at a shell prompt — an agent cannot be started into it; see what it is:\n  ${herdrLine(['pane', 'read', pane, '--source', 'visible', '--lines', '20'], r.session)}`, 'busy');
    }
  } else {
    const made = await herdrJson(create, createSession);
    pane = made?.result?.root_pane?.pane_id ?? null;
    if (made?.result?.already_open) {
      throw new TargetError(`herdr says ${r.path} is already open (space ${made?.result?.workspace?.workspace_id ?? '?'}) — it appeared while this ran; nothing was started. Look again:\n  maw herdr resume ${targetHandle(r)} --dry`, 'changed');
    }
    if (!pane) throw new TargetError(`herdr opened no root pane for ${r.path}; see what it made:\n  ${herdrLine(['workspace', 'list'], createSession)}`, 'herdr');
    await waitForShell(pane, createSession);
  }
  for (const l of lines) console.log(l);
  await startAgent({ ...plan, pane }, () => {});
  console.log(`  resumed ${r.label} in ${pane} — ${launch.kind} on session ${found.id}, agent "${name}"`);
}

// --- kill ------------------------------------------------------------------------------

export async function cmdKill(args, { UsageError = Error } = {}) {
  const o = parse(args, 'kill', UsageError);
  if (o.help) return void console.log(HELP.kill);
  if (o.worker) return runWorker('kill');
  const caller = callerFromEnv();
  const r = await resolveLive(o.target, { session: o.session, verb: 'kill', caller });
  if (!r.workspace) {
    if (o.dry) printResolved(r);
    return void console.log(`  '${r.label}' has no open herdr space — nothing is running there, nothing to stop`);
  }
  const pane = requirePane(r, 'kill');
  if (!r.agent) {
    if (o.dry) printResolved(r);
    return void console.log(`  '${r.label}' runs no agent (pane ${pane} is a shell) — nothing to stop`);
  }
  const proc = await paneProcess(pane, r.session, r.agent);
  if (!proc.running) {
    if (o.dry) printResolved(r);
    return void console.log(`  the ${r.agent} in ${pane} has already exited — nothing to stop`);
  }
  if (!proc.isAgent) {
    throw new TargetError(`the foreground process in pane ${pane} (${proc.name}, pid ${proc.pid}) is not the ${r.agent} herdr detected there — nothing was done; see what is in front of it:\n  ${herdrLine(['pane', 'read', pane, '--source', 'visible', '--lines', '20'], r.session)}`, 'busy');
  }
  const plan = { verb: 'kill', session: r.session, pane, pid: proc.pid, kind: r.agent };
  const line = `  kill      ${pane} · ${r.agent} pid ${proc.pid} · ctrl+c until it exits (up to ${QUIT_TRIES}); the pane stays`;
  if (o.dry) {
    printResolved(r);
    console.log(line);
    console.log('  --dry: nothing was done');
    return;
  }
  console.log(line);
  if (isCaller(caller, r, pane) || (await isOurAncestor(proc.pid))) {
    const w = spawnWorker(plan);
    console.log(`  kill scheduled — this command runs inside the agent it stops, so a detached worker (pid ${w.pid}) does it. Follow it:\n  tail -n 20 ${shq(w.log)}`);
    return;
  }
  await performKill(plan, () => {});
  console.log(`  stopped ${r.agent} pid ${proc.pid} in ${pane}; the pane stays open. Bring it back with:\n${resumeHint(r, pane)}`);
}

// --- close -----------------------------------------------------------------------------

export async function cmdClose(args, { UsageError = Error } = {}) {
  const o = parse(args, 'close', UsageError);
  if (o.help) return void console.log(HELP.close);
  const r = await resolveLive(o.target, { session: o.session, verb: 'close' });
  if (!r.workspace) {
    if (o.dry) printResolved(r);
    return void console.log(`  '${r.label}' has no open herdr space — nothing to close`);
  }
  const live = r.panes.filter(p => p.agent);
  if (live.length && !o.force) {
    throw new TargetError(
      `'${r.label}' (space ${r.workspace}, session ${r.session}) holds ${live.length} running agent${live.length === 1 ? '' : 's'} — closing the space would end ${live.length === 1 ? 'it' : 'them'}; nothing was done. Stop ${live.length === 1 ? 'it' : 'them'} first, or close anyway:\n${live.map(p => `  maw herdr kill ${paneHandle(r, p.pane)}`).join('\n')}\n  maw herdr close ${targetHandle(r)} --force`,
      'running',
    );
  }
  const cmd = ['workspace', 'close', r.workspace];
  const line = `  close     space ${r.workspace} '${r.label}' in session ${r.session} · ${r.panes.length} pane${r.panes.length === 1 ? '' : 's'}${live.length ? `, ${live.length} running agent${live.length === 1 ? '' : 's'} (--force)` : ''}\n    run     ${herdrLine(cmd, r.session)}`;
  if (o.dry) {
    printResolved(r);
    console.log(line);
    console.log('  --dry: nothing was done');
    return;
  }
  console.log(line);
  await herdr(cmd, r.session);
  console.log(`  closed '${r.label}'; the worktree and its transcript stay${r.kind === 'worktree' ? `. Bring it back with:\n  maw herdr resume ${targetHandle(r)}` : ''}`);
}
