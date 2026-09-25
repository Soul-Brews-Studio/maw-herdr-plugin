/**
 * The command line a restarted agent is relaunched with — pure functions, no I/O.
 *
 * `restart` reads argv from the RUNNING process (decided in #57/#62) and reuses
 * it, so it needs no agent-specific knowledge to keep `--dangerously-skip-permissions`,
 * `--channels`, a model flag, or anything else the agent was started with. Two
 * things are adjusted on top of that, and only these two:
 *
 *   1. duplicates are dropped. herdr types the relaunch into the pane's shell, where
 *      a `claude` alias may add its own flags; carrying the old argv over as well grew
 *      the command by one full copy per restart in the fleet tool this came from
 *      (seen: three --dangerously-skip-permissions after the third restart).
 *   2. the session is pinned. A process started as `claude --resume A` that has since
 *      forked or cleared is on session B; herdr reports B as the pane's agent_session,
 *      and relaunching with A would quietly go back in time. Pinning needs the
 *      agent's resume syntax, which is known for claude and codex only; any other
 *      kind is relaunched with its argv exactly as read.
 *
 *   execIndex(argv, kind, proc)         → where the agent's own executable sits in a process argv, or -1
 *   isKindProcess(proc, kind)           → a process-info entry IS that agent (whole path components only)
 *   dedupeArgs(args)                    → args with repeated flag units removed
 *   withSession(kind, args, id)         → { args, how } | null (null: syntax unknown for kind)
 *   sessionInArgs(kind, args)           → the session id the argv already names, or null
 *   withChannel(args, channel)          → args with the development channel set/removed/kept
 *   hasDevChannel(args)                 → boolean
 *   redactArgs(args)                    → args safe to print (values of token-ish flags hidden)
 *   agentName(raw, fallback)            → a name herdr accepts (lowercase letter first, ≤ 32)
 *   freeName(name, taken)               → name, or name-2, name-3 … when a live agent holds it
 *   CONTROL_CHAR                        → herdr refuses any agent arg matching it
 */

import { basename } from 'node:path';

export const DEV_CHANNEL_FLAG = '--dangerously-load-development-channels';

// A flag and every value after it (up to the next flag) form one unit, so
// `--model x --model x` is one and so is `--add-dir a b --add-dir a b` (variadic).
// Without the agent's flag table a boolean flag followed by a positional reads as one
// unit too; so a unit whose LEADING part repeats a unit already seen drops only that
// part, and what follows it stays: `--x v … --x v prompt` keeps `prompt`.
function units(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const unit = [a];
    if (a.startsWith('-') && a !== '-' && a !== '--' && !a.includes('=')) {
      while (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) unit.push(args[++i]);
    }
    out.push(unit);
  }
  return out;
}

/** Drop repeated flag units, keeping the first of each. Positionals are never dropped. */
export function dedupeArgs(args) {
  const seen = new Set();
  const out = [];
  for (const unit of units(args)) {
    if (!unit[0].startsWith('-')) { out.push(...unit); continue; }
    let k = unit.length;
    while (k > 0 && !seen.has(unit.slice(0, k).join('\0'))) k--;
    // an exact repeat goes whole; a repeated flag with trailing positionals keeps them
    if (k === unit.length) continue;
    if (k > 0) { out.push(...unit.slice(k)); continue; }
    seen.add(unit.join('\0'));
    out.push(...unit);
  }
  return out;
}

// --- where the agent is in a process's argv -----------------------------------------

const base = s => basename(String(s ?? ''));
// runtimes that host an agent written as a script: `bun ~/.bun/bin/omp`, `node ~/.local/bin/codex`
const INTERPRETER = /^(node|nodejs|bun|deno|python[0-9.]*|ruby|perl)(\.exe)?$/;

/**
 * The index of the agent's own executable in a process argv, or -1 when it is not
 * there. herdr relaunches with the kind's canonical executable, so everything up to
 * and including this index is dropped and the rest is reused.
 *   [claude, --x]                         → 0   (native)
 *   [node, /…/bin/codex, resume]          → 1   (a script under its runtime)
 *   [/…/versions/2.1.280, --x] + argv0/name 'claude' → 0 (native binary under another file name)
 */
export function execIndex(argv, kind, { argv0 = null, name = null } = {}) {
  if (!kind || !Array.isArray(argv) || !argv.length) return -1;
  const first = base(argv[0]);
  if (first === kind) return 0;
  if (INTERPRETER.test(first)) {
    const script = argv.findIndex((a, i) => i > 0 && !String(a).startsWith('-'));
    return script > 0 && base(argv[script]) === kind ? script : -1;
  }
  return base(argv0) === kind || name === kind ? 0 : -1;
}

/** A herdr process-info entry is the agent itself — whole path components, never a substring. */
export const isKindProcess = (proc, kind) => !!proc && execIndex(Array.isArray(proc.argv) && proc.argv.length ? proc.argv : [proc.argv0 ?? proc.name ?? ''], kind, proc) !== -1;

/** A wrapper's argv as a human types it again: the runtime in front of a script goes. */
export function commandOf(argv) {
  const a = (argv ?? []).map(String);
  if (a.length > 1 && INTERPRETER.test(base(a[0]))) {
    const script = a.findIndex((x, i) => i > 0 && !x.startsWith('-'));
    if (script > 0) return a.slice(script);
  }
  return a;
}

/** herdr refuses an agent argument holding any control character (invalid_agent_argument). */
export const CONTROL_CHAR = /[\x00-\x1f\x7f]/;

// --- session pinning, per agent kind --------------------------------------------------

const CLAUDE_VALUE = new Set(['--resume', '-r', '--session-id']);
const CLAUDE_BARE = new Set(['--continue', '-c', '--fork-session']);

const SYNTAX = {
  claude: {
    find(args) {
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if ((a === '--resume' || a === '-r') && args[i + 1] && !args[i + 1].startsWith('-')) return args[i + 1];
        const eq = a.match(/^--resume=(.+)$/);
        if (eq) return eq[1];
      }
      return null;
    },
    pin(args, id) {
      const out = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (CLAUDE_VALUE.has(a)) {
          if (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) i++;
          continue;
        }
        if (CLAUDE_BARE.has(a) || /^--(resume|session-id)=/.test(a)) continue;
        out.push(a);
      }
      return [...out, '--resume', id];
    },
  },
  // `codex resume <id>` is a subcommand. Options given before it are codex's own
  // and stay; an old `resume [<id>|--last]` is replaced by the pinned one.
  codex: {
    find(args) {
      const at = args.indexOf('resume');
      const id = at === -1 ? null : args[at + 1];
      return id && !id.startsWith('-') ? id : null;
    },
    pin(args, id) {
      const out = [...args];
      const at = out.indexOf('resume');
      if (at !== -1) {
        let n = 1;
        while (out[at + n] !== undefined && (out[at + n] === '--last' || (n === 1 && !out[at + n].startsWith('-')))) n++;
        out.splice(at, n);
      }
      return [...out, 'resume', id];
    },
  },
};

/** The resume syntax is known for this agent kind. */
export const knowsResume = kind => Object.hasOwn(SYNTAX, kind);

/** The session id the argv itself already points at (`--resume X`, `resume X`), or null. */
export function sessionInArgs(kind, args) {
  return knowsResume(kind) ? SYNTAX[kind].find(args) : null;
}

/** args with the session pinned to `id`, or null when the kind's resume syntax is unknown. */
export function withSession(kind, args, id) {
  if (!knowsResume(kind) || !id) return null;
  return { args: SYNTAX[kind].pin(args, id), how: `${kind} resume syntax` };
}

// --- the development channel (claude) -------------------------------------------------

export const hasDevChannel = args => args.includes(DEV_CHANNEL_FLAG) || args.some(a => a.startsWith(`${DEV_CHANNEL_FLAG}=`));

/**
 * channel: undefined keeps whatever the process already had, so a restart never
 * silently changes it; a string (e.g. "server:fleet") adds that channel unless it
 * is already loaded; false removes every development channel.
 */
export function withChannel(args, channel) {
  if (channel === undefined) return args;
  const out = [];
  const had = [];
  for (let i = 0; i < args.length; i++) {
    const eq = args[i].startsWith(`${DEV_CHANNEL_FLAG}=`) ? args[i].slice(DEV_CHANNEL_FLAG.length + 1) : null;
    if (eq !== null) { had.push(eq); continue; }
    if (args[i] !== DEV_CHANNEL_FLAG) { out.push(args[i]); continue; }
    // the flag may carry several entries (`… server:a server:b`); every one goes with
    // it, or the second is left behind as a positional that claude submits as a prompt
    while (args[i + 1] !== undefined && CHANNEL_ENTRY.test(args[i + 1])) had.push(args[++i]);
  }
  if (channel === false) return out;
  if (had.includes(channel)) return args;
  return [DEV_CHANNEL_FLAG, channel, ...args];
}

// a development-channel entry: server:<name> or plugin:<name>[@marketplace]
const CHANNEL_ENTRY = /^(server|plugin):\S+$/;

// --- display --------------------------------------------------------------------------

const SECRET_FLAG = /(token|secret|password|passwd|api[-_]?key|auth|credential|ticket)/i;

/**
 * argv safe to print: the value of any token/secret/key-looking flag becomes
 * <redacted>, and so does a `-c`/`--config` override whose KEY looks like one
 * (codex: `-c model_providers.x.api_key=sk-…`).
 */
export function redactArgs(args) {
  const out = [];
  const secretKv = v => {
    const m = String(v).match(/^([^=]+)=(.*)$/s);
    return m && SECRET_FLAG.test(m[1]) ? `${m[1]}=<redacted>` : v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const eq = a.match(/^(--?[^=]+)=(.*)$/s);
    if (eq && CONFIG_FLAG.has(eq[1])) { out.push(`${eq[1]}=${secretKv(eq[2])}`); continue; }
    if (eq && SECRET_FLAG.test(eq[1])) { out.push(`${eq[1]}=<redacted>`); continue; }
    out.push(a);
    const next = args[i + 1];
    if (next === undefined || String(next).startsWith('-')) continue;
    if (CONFIG_FLAG.has(a)) { out.push(secretKv(next)); i++; }
    else if (a.startsWith('-') && SECRET_FLAG.test(a) && !a.includes('=')) { out.push('<redacted>'); i++; }
  }
  return out;
}

const CONFIG_FLAG = new Set(['-c', '--config']);

/** The literal secret values redactArgs hides, to scrub them from any other text. */
export function secretValues(args) {
  const shown = redactArgs(args);
  if (shown.length !== args.length) return [];
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (shown[i] === args[i]) continue;
    const a = String(args[i]);
    const at = String(shown[i]).indexOf('<redacted>');
    const v = at === -1 ? a : a.slice(at);
    if (v.length >= 3) out.push(v);
  }
  return out;
}

/** herdr requires an agent name matching [a-z][a-z0-9_-]{0,31}. */
export function agentName(raw, fallback = 'agent') {
  let n = String(raw || fallback).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
  if (!/^[a-z]/.test(n)) n = `w-${n}`.slice(0, 32);
  return n;
}

/** herdr requires a name unique among live agents: name, else name-2, name-3 … (≤ 32). */
export function freeName(name, taken) {
  const held = new Set(taken);
  if (!held.has(name)) return name;
  for (let k = 2; k < 100; k++) {
    const suffix = `-${k}`;
    const n = `${name.slice(0, 32 - suffix.length)}${suffix}`;
    if (!held.has(n)) return n;
  }
  return null;
}
