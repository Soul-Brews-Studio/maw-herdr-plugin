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
 *   dedupeArgs(args)                    → args with repeated flag units removed
 *   withSession(kind, args, id)         → { args, how } | null (null: syntax unknown for kind)
 *   sessionInArgs(kind, args)           → the session id the argv already names, or null
 *   withChannel(args, channel)          → args with the development channel set/removed/kept
 *   hasDevChannel(args)                 → boolean
 *   redactArgs(args)                    → args safe to print (values of token-ish flags hidden)
 *   agentName(raw, fallback)            → a name herdr accepts (lowercase letter first, ≤ 24)
 */

export const DEV_CHANNEL_FLAG = '--dangerously-load-development-channels';

// A flag and the value after it count as one unit, so `--model x --model x` is one.
// Without the agent's flag table a boolean flag followed by a positional is read as
// a pair too; that only matters for an exact repeat, which is dropped either way.
function units(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    const pair = a.startsWith('-') && a !== '-' && a !== '--' && !a.includes('=') && next !== undefined && !next.startsWith('-');
    out.push(pair ? [a, next] : [a]);
    if (pair) i++;
  }
  return out;
}

/** Drop repeated flag units, keeping the first of each. Positionals are never dropped. */
export function dedupeArgs(args) {
  const seen = new Set();
  const out = [];
  for (const unit of units(args)) {
    if (unit[0].startsWith('-')) {
      const key = unit.join('\0');
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(...unit);
  }
  return out;
}

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
  for (let i = 0; i < args.length; i++) {
    if (args[i] === DEV_CHANNEL_FLAG) { i++; continue; }
    if (args[i].startsWith(`${DEV_CHANNEL_FLAG}=`)) continue;
    out.push(args[i]);
  }
  if (channel === false) return out;
  const had = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === DEV_CHANNEL_FLAG && args[i + 1] !== undefined) had.push(args[i + 1]);
    const eq = args[i].match(new RegExp(`^${DEV_CHANNEL_FLAG}=(.+)$`));
    if (eq) had.push(eq[1]);
  }
  if (had.includes(channel)) return args;
  return [DEV_CHANNEL_FLAG, channel, ...args];
}

// --- display --------------------------------------------------------------------------

const SECRET_FLAG = /(token|secret|password|passwd|api[-_]?key|auth|credential|ticket)/i;

/** argv safe to print: the value of any token/secret/key-looking flag becomes <redacted>. */
export function redactArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.match(/^(--?[^=]+)=(.*)$/);
    if (eq && SECRET_FLAG.test(eq[1])) { out.push(`${eq[1]}=<redacted>`); continue; }
    out.push(a);
    if (a.startsWith('-') && SECRET_FLAG.test(a) && !a.includes('=') && args[i + 1] !== undefined && !args[i + 1].startsWith('-')) {
      out.push('<redacted>');
      i++;
    }
  }
  return out;
}

/** herdr requires an agent name that starts with a lowercase letter. */
export function agentName(raw, fallback = 'agent') {
  let n = String(raw || fallback).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 24);
  if (!/^[a-z]/.test(n)) n = `w-${n}`.slice(0, 24);
  return n;
}
