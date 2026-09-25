/**
 * The minimal resume lookup `maw herdr resume` needs: "which transcript would this
 * worktree resume from". It implements the SAME provider interface and the SAME
 * environment as the #60 resumability providers (src/cli/mod.resumeProviders.mjs on
 * feat/60-ls-state), which were still on a sibling branch when #62 was written:
 *
 *   provider = { name, roots, find(paths, skip?) → Map<path, Session> }
 *              skip: a Set of session ids a live agent already holds — never resumed
 *              twice (#62: two agents in one worktree), so the newest NOT held wins
 *   Session  = { provider, id, file, at, bytes }
 *   MAW_HERDR_RESUME_PROVIDERS  "claude,codex" (default) · "none" turns all off
 *   MAW_HERDR_CLAUDE_ROOTS      default $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects
 *   MAW_HERDR_CODEX_ROOTS       default $CODEX_HOME/sessions, else ~/.codex/sessions
 *
 * INTEGRATION NOTE: once #60 lands, delete this file and import configuredProviders
 * and findSessions from ./mod.resumeProviders.mjs in mod.lifecycle.mjs instead; the
 * call sites do not change — but carry the optional `skip` argument over, since
 * mod.lifecycle.mjs relies on it (and re-checks the result against it, refusing a
 * held session, so a provider that ignores it can only refuse, never double-resume).
 * Nothing else in the plugin imports this module.
 */
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';

// A transcript this small holds a header and nothing to return to.
export const MIN_BYTES = 1024;
// herdr types an agent's arguments into the pane's shell, so a session id is only
// used when it looks like one (Claude and Codex ids are UUIDs); a transcript named
// `a$(touch x).jsonl` was not written by the agent and is skipped, not quoted.
export const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const HEAD_BYTES = 16 * 1024;

const list = v => (v ?? '').split(delimiter).map(s => s.trim()).filter(Boolean);
const stat = p => { try { return statSync(p); } catch { return null; } };
const entries = d => { try { return readdirSync(d, { withFileTypes: true }); } catch { return []; } };

/** Claude names a project directory by replacing every non-alphanumeric with '-'. */
export const encodeClaudeDir = path => path.replace(/[^a-zA-Z0-9]/g, '-');

export function claudeProvider(roots) {
  return {
    name: 'claude',
    roots,
    find(paths, skip = new Set()) {
      const out = new Map();
      for (const path of paths) {
        let best = null;
        for (const root of roots) {
          const dir = join(root, encodeClaudeDir(path));
          for (const e of entries(dir)) {
            if (!e.isFile() || !e.name.endsWith('.jsonl') || !SAFE_ID.test(basename(e.name, '.jsonl')) || skip.has(basename(e.name, '.jsonl'))) continue;
            const file = join(dir, e.name);
            const s = stat(file);
            if (!s || s.size < MIN_BYTES) continue;
            if (!best || s.mtimeMs > best.at) best = { file, at: s.mtimeMs, bytes: s.size };
          }
        }
        if (best) out.set(path, { provider: 'claude', id: basename(best.file, '.jsonl'), ...best });
      }
      return out;
    },
  };
}

function head(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0)).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A rollout's first line: {"type":"session_meta","payload":{"id","cwd","source"}}; subagents are not resumable. */
export function codexMeta(text) {
  const line = text.split('\n', 1)[0];
  if (!line.includes('"session_meta"') || /"source"\s*:\s*\{\s*"subagent"/.test(line)) return null;
  const cwd = line.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!cwd) return null;
  const id = line.match(/"payload"\s*:\s*\{[^{}]*?"id"\s*:\s*"([^"]+)"/);
  try { return { cwd: JSON.parse(`"${cwd[1]}"`), id: id?.[1] ?? null }; } catch { return null; }
}

export function codexProvider(roots) {
  return {
    name: 'codex',
    roots,
    find(paths, skip = new Set()) {
      const wanted = new Set(paths);
      const best = new Map();
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
          if (e.isDirectory()) { if (depth < 4) walk(full, depth + 1); continue; }
          if (!e.isFile() || !e.name.startsWith('rollout-') || !e.name.endsWith('.jsonl')) continue;
          const s = stat(full);
          if (!s || s.size < MIN_BYTES) continue;
          const meta = codexMeta(head(full));
          const key = meta && match(meta.cwd);
          if (!key) continue;
          const seen = best.get(key);
          if (seen && seen.at >= s.mtimeMs) continue;
          const id = meta.id ?? e.name.slice(0, -'.jsonl'.length).slice(-36);
          if (!SAFE_ID.test(id) || skip.has(id)) continue;
          best.set(key, { provider: 'codex', id, file: full, at: s.mtimeMs, bytes: s.size });
        }
      };
      for (const root of roots) walk(root, 0);
      return best;
    },
  };
}

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
    const keep = [...new Set(names.filter(n => BUILT_IN[n]))];
    throw new Error(`unknown resume provider '${unknown[0]}' in MAW_HERDR_RESUME_PROVIDERS; built in: ${Object.keys(BUILT_IN).join(', ')}\n  export MAW_HERDR_RESUME_PROVIDERS=${keep.length ? keep.join(',') : 'claude,codex'}`);
  }
  return [...new Set(names)].map(n => BUILT_IN[n](env));
}

/** Newest session per path across every provider; `aliases` maps each spelling to the caller's key; ids in `skip` are passed over. */
export function findSessions(providers, aliases, skip = new Set()) {
  const out = new Map();
  const paths = [...aliases.keys()];
  for (const p of providers) {
    for (const [path, session] of p.find(paths, skip)) {
      const key = aliases.get(path) ?? path;
      const seen = out.get(key);
      if (!seen || session.at > seen.at) out.set(key, session);
    }
  }
  return out;
}
