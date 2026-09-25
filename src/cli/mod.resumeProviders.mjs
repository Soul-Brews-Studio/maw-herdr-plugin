// Resume providers: who decides that a worktree with no open herdr space is
// "resumable" rather than "cold".
//
// herdr knows what is running and what is open. It does not know whether an
// agent left a transcript behind that it could pick up again, and neither
// should this plugin in general: it is a herdr plugin, not a Claude or a Codex
// plugin. So that one question is asked of providers, and each provider knows
// one agent's on-disk layout. Claude and Codex ship built in because they are
// what runs in herdr today; nothing else in the plugin names either of them.
//
// THE INTERFACE (small on purpose — a new agent is one more object like these):
//
//   {
//     name:  'claude',                     // what MAW_HERDR_RESUME_PROVIDERS lists
//     roots: ['/home/me/.claude/projects'],// where it looks; reported in ls --json
//     find(paths) -> Map<path, Session>    // paths: absolute worktree paths.
//   }                                      // A path absent from the map has no
//                                          // session this provider can resume.
//   Session = {
//     provider: 'claude',
//     id:       '9c77f5f5-…',              // what the agent's own resume takes;
//                                          // must match SAFE_ID, it goes in `command`
//     file:     '/…/9c77f5f5-….jsonl',     // the transcript itself
//     at:       1790000000000,             // its mtime, ms since epoch
//     bytes:    48213,
//     command:  "cd /code/x && claude --resume 9c77f5f5-…",  // runnable as-is
//   }
//
// find() is handed every path at once so a provider whose layout is not keyed
// by directory (Codex dates its files; the cwd is inside them) scans once, not
// once per worktree. It must never throw for a missing root: an agent that was
// never installed simply has nothing to resume.
//
// CONFIGURATION (environment; `path.delimiter`-separated lists, ':' on unix):
//
//   MAW_HERDR_RESUME_PROVIDERS  which providers run, comma-separated.
//                               Default "claude,codex". "none" (or empty) turns
//                               them all off: ls then reports running, open and
//                               cold, and never calls anything resumable.
//   MAW_HERDR_CLAUDE_ROOTS      Claude project roots.
//                               Default $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects.
//   MAW_HERDR_CODEX_ROOTS       Codex session roots.
//                               Default $CODEX_HOME/sessions, else ~/.codex/sessions.
//
// Env rather than the layered maw config: the CLI runs under plain node as well
// as Bun, and the maw config reader lives on the TypeScript server side.

import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';

// A transcript this small holds a header and nothing to return to; resuming it
// opens an empty session, which is not what "resumable" promises.
export const MIN_BYTES = 1024;

// Enough of a Codex rollout's first line to reach its cwd. The line carries the
// full base instructions after the cwd, so it can run to tens of KB; the cwd
// and the subagent marker sit in the first few hundred bytes.
const HEAD_BYTES = 16 * 1024;

// What a session id may look like before it is put in a shell command. Claude
// and Codex ids are UUIDs. The id comes from a file name (Claude) or from inside
// the file (Codex) and ends up in `command`, which is printed to paste and
// which resume runs, so anything else — `a$(touch x)` — is skipped, not quoted:
// a transcript with such a name was not written by the agent.
export const SAFE_ID = /^[A-Za-z0-9._-]+$/;

const list = value => (value ?? '').split(delimiter).map(s => s.trim()).filter(Boolean);

/** A path a shell reads back unchanged: bare when it is safe, single-quoted when not. */
export function shellQuote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function stat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function entries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// --- claude ------------------------------------------------------------------

/**
 * Claude Code keeps one directory per working directory under its projects
 * root, named by replacing every character that is not a letter or digit with
 * '-': /opt/Code/x/wt/a.b → -opt-Code-x-wt-a-b. Each session is a top-level
 * <session-id>.jsonl in it (subagent transcripts live in subdirectories and are
 * not resumable on their own). The encoding is lossy — /a/b-c and /a/b/c share
 * a directory — which is Claude's own ambiguity, not one this can undo.
 */
export const encodeClaudeDir = path => path.replace(/[^a-zA-Z0-9]/g, '-');

export function claudeProvider(roots) {
  return {
    name: 'claude',
    roots,
    find(paths) {
      const out = new Map();
      for (const path of paths) {
        let best = null;
        for (const root of roots) {
          const dir = join(root, encodeClaudeDir(path));
          for (const e of entries(dir)) {
            if (!e.isFile() || !e.name.endsWith('.jsonl') || !SAFE_ID.test(basename(e.name, '.jsonl'))) continue;
            const file = join(dir, e.name);
            const s = stat(file);
            if (!s || s.size < MIN_BYTES) continue;
            if (!best || s.mtimeMs > best.at) best = { file, at: s.mtimeMs, bytes: s.size };
          }
        }
        if (!best) continue;
        const id = basename(best.file, '.jsonl');
        out.set(path, { provider: 'claude', id, ...best, command: `cd ${shellQuote(path)} && claude --resume ${id}` });
      }
      return out;
    },
  };
}

// --- codex -------------------------------------------------------------------

function readHead(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * What a rollout's first line says about itself, or null when it is not a
 * session a person would resume. Codex writes
 *   {"type":"session_meta","payload":{"id":…,"cwd":…,"source":…}}
 * first. A subagent thread (source.subagent) was spawned by another session
 * and is resumed through its parent, so it is not this worktree's session.
 */
export function codexMeta(head) {
  const line = head.split('\n', 1)[0];
  if (!line.includes('"session_meta"')) return null;
  if (/"source"\s*:\s*\{\s*"subagent"/.test(line)) return null;
  const cwd = line.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!cwd) return null;
  const id = line.match(/"payload"\s*:\s*\{[^{}]*?"id"\s*:\s*"([^"]+)"/);
  try {
    return { cwd: JSON.parse(`"${cwd[1]}"`), id: id?.[1] ?? null };
  } catch {
    return null;
  }
}

/**
 * Codex dates its transcripts (<root>/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl)
 * and records the working directory inside, so the only way from a worktree to
 * its session is to read every rollout's first line once and index by cwd.
 * Only the head of each file is read. Measured on m5: 1,896 rollouts, 12 GB.
 */
export function codexProvider(roots) {
  return {
    name: 'codex',
    roots,
    find(paths) {
      const wanted = new Set(paths);
      const best = new Map();
      // A rollout may record a symlinked spelling of the directory (/var vs
      // /private/var on macOS, a ghq alias). Resolve each distinct cwd once.
      const resolved = new Map();
      const match = cwd => {
        if (wanted.has(cwd)) return cwd;
        if (!resolved.has(cwd)) {
          let r = null;
          try { r = realpathSync(cwd); } catch {}
          resolved.set(cwd, r && wanted.has(r) ? r : null);
        }
        return resolved.get(cwd);
      };
      const walk = (dir, depth) => {
        for (const e of entries(dir)) {
          const full = join(dir, e.name);
          if (e.isDirectory()) {
            if (depth < 4) walk(full, depth + 1);
            continue;
          }
          if (!e.isFile() || !e.name.startsWith('rollout-') || !e.name.endsWith('.jsonl')) continue;
          const s = stat(full);
          if (!s || s.size < MIN_BYTES) continue;
          const meta = codexMeta(readHead(full));
          const key = meta && match(meta.cwd);
          if (!key) continue;
          const seen = best.get(key);
          if (seen && seen.at >= s.mtimeMs) continue;
          // the uuid at the end of the name is the id `codex resume` takes
          const id = meta.id ?? e.name.slice(0, -'.jsonl'.length).slice(-36);
          if (!SAFE_ID.test(id)) continue;
          best.set(key, { provider: 'codex', id, file: full, at: s.mtimeMs, bytes: s.size, command: `cd ${shellQuote(meta.cwd)} && codex resume ${id}` });
        }
      };
      for (const root of roots) walk(root, 0);
      return best;
    },
  };
}

// --- configuration -----------------------------------------------------------

export const BUILT_IN = {
  claude: env => claudeProvider(list(env.MAW_HERDR_CLAUDE_ROOTS).length
    ? list(env.MAW_HERDR_CLAUDE_ROOTS)
    : [join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude'), 'projects')]),
  codex: env => codexProvider(list(env.MAW_HERDR_CODEX_ROOTS).length
    ? list(env.MAW_HERDR_CODEX_ROOTS)
    : [join(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'), 'sessions')]),
};

/** The providers this environment enables, in the order listed. Throws on a name it does not know. */
export function configuredProviders(env = process.env) {
  const raw = env.MAW_HERDR_RESUME_PROVIDERS;
  const names = raw === undefined ? ['claude', 'codex'] : raw.split(',').map(s => s.trim()).filter(Boolean);
  if (names.length === 1 && names[0] === 'none') return [];
  const unknown = names.filter(n => !BUILT_IN[n]);
  if (unknown.length) {
    const keep = names.filter(n => BUILT_IN[n]);
    throw new Error(`unknown resume provider '${unknown[0]}' in MAW_HERDR_RESUME_PROVIDERS; built in: ${Object.keys(BUILT_IN).join(', ')}\n  MAW_HERDR_RESUME_PROVIDERS=${keep.length ? [...new Set(keep)].join(',') : 'claude,codex'} maw herdr ls`);
  }
  return [...new Set(names)].map(n => BUILT_IN[n](env));
}

/**
 * Newest session per path across every provider. `paths` may hold several
 * spellings of one worktree (as registered, and resolved through symlinks);
 * `aliases` maps each spelling back to the key the caller uses.
 */
export function findSessions(providers, aliases) {
  const out = new Map();
  const paths = [...aliases.keys()];
  for (const p of providers) {
    for (const [path, session] of p.find(paths)) {
      const key = aliases.get(path) ?? path;
      const seen = out.get(key);
      if (!seen || session.at > seen.at) out.set(key, session);
    }
  }
  return out;
}
