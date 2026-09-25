/**
 * `maw herdr inbox` — notes addressed to a herdr PANE, not to a person.
 *
 * A note carries the pane it is for ({session, pane}), so whatever agent sits in
 * that pane finds it without anyone having named it. `watch` files one when the
 * agent it watches finishes (or when that pane disappears); anything else that
 * needs a return path to "the pane that asked" can file one with fileNote().
 *
 * Storage: one append-only JSON-lines file per pane,
 *   <config>/maw-herdr/inbox/<session>/<pane>.jsonl
 * where <config> is ~/Library/Application Support on macOS and
 * ${XDG_CONFIG_HOME:-~/.config} elsewhere — the same root `serve` keeps its data
 * under. It is NOT an oracle's ψ/inbox: herdr is a public plugin and does not
 * write into anyone's vault (epic #57, decision 1).
 *
 * Reading is idempotent: `inbox` only reads. It never marks, moves or deletes a
 * note, so reading twice shows the same thing and two agents reading one pane's
 * inbox cannot race each other. `--since <note-id>` is how a reader skips what it
 * has already seen; the id of the newest note is printed at the bottom.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { callerFromEnv, resolveLive, shq } from './mod.target.mjs';

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', off: '\x1b[0m' }
  : { dim: '', cyan: '', green: '', red: '', off: '' };

/** Where watch records and inboxes live. Same root as `serve --data-dir`'s default. */
export function stateRoot(env = process.env) {
  const configHome = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support')
    : env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configHome, 'maw-herdr');
}

// A path segment that cannot climb out of its directory, whatever herdr named things.
const segment = s => (/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(s) ? s : encodeURIComponent(s).replace(/\./g, '%2E'));

/** The inbox file for one pane. Pane ids are only unique within a session, so both. */
export function inboxPath(to, root = stateRoot()) {
  if (!to?.session || !to?.pane) throw new Error('an inbox address needs both a herdr session and a pane id');
  return join(root, 'inbox', segment(to.session), `${segment(to.pane.replace(':', '_'))}.jsonl`);
}

/** Append one note to a pane's inbox. One write(2) with O_APPEND, so writers never interleave. */
export function fileNote(to, note, root = stateRoot()) {
  const path = inboxPath(to, root);
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const full = {
    id: `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    at: new Date().toISOString(),
    to: { session: to.session, pane: to.pane },
    ...note,
  };
  appendFileSync(path, `${JSON.stringify(full)}\n`, { mode: 0o600 });
  return full;
}

/** Every note for one pane, oldest first. A torn or foreign line is skipped, never fatal. */
export function readNotes(to, root = stateRoot()) {
  let raw;
  try { raw = readFileSync(inboxPath(to, root), 'utf8'); } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const notes = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const n = JSON.parse(line);
      if (n?.to?.pane === to.pane && n?.to?.session === to.session) notes.push(n);
    } catch {}
  }
  return notes;
}

/**
 * Who "this pane" is: the pane id and session herdr put in our environment. When
 * the socket path does not name a session (a custom HERDR_SOCKET_PATH), ask the
 * resolver, which finds the one session holding that pane id or lists them.
 */
export async function selfAddress(verb, cwd = process.cwd()) {
  const me = callerFromEnv();
  if (!me) {
    throw new Error(`${verb} is addressed to "this pane", and HERDR_PANE_ID is not set here — not inside a herdr pane\n  run it from the agent's own herdr pane; see which panes exist: maw herdr ls --agents`);
  }
  if (me.session) return me;
  const r = await resolveLive('self', { verb, cwd });
  return { pane: r.pane ?? me.pane, session: r.session };
}

const hhmm = iso => { const d = new Date(iso); return Number.isNaN(+d) ? '??:??:??' : d.toTimeString().slice(0, 8); };

function printNote(n) {
  const who = n.from ? `${n.from.label ? `${n.from.label} ` : ''}(${n.from.pane}${n.from.session && n.from.session !== n.to.session ? ` · ${n.from.session}` : ''})` : '';
  const mark = n.kind === 'finished' ? `${C.green}●${C.off}` : n.kind === 'vanished' ? `${C.red}○${C.off}` : `${C.dim}·${C.off}`;
  console.log(`  ${mark} ${C.dim}${hhmm(n.at)}${C.off}  ${(n.kind ?? 'note').padEnd(8)} ${C.cyan}${who}${C.off}  ${n.text ?? ''}`);
  const tail = (n.tail ?? '').replace(/\s+$/, '');
  if (tail) for (const line of tail.split('\n')) console.log(`      ${C.dim}│ ${line}${C.off}`);
}

/** `maw herdr inbox [--since <note-id>] [--all] [--json]` — this pane's notes. Read-only. */
export async function cmdInbox(args, { UsageError = Error } = {}) {
  const rest = [...args];
  const take = flag => { const at = rest.indexOf(flag); if (at === -1) return false; rest.splice(at, 1); return true; };
  const json = take('--json');
  const all = take('--all');
  let since = null;
  const at = rest.indexOf('--since');
  if (at !== -1) {
    since = rest[at + 1];
    if (!since || since.startsWith('-')) throw new UsageError('--since needs a note id (the last line of `inbox` prints the newest one)\n  maw herdr inbox');
    rest.splice(at, 2);
  }
  if (rest.length) throw new UsageError(`unknown argument: ${rest[0]} (inbox reads this pane's notes only; it takes --since, --all, --json)\n  maw herdr inbox`);

  const me = await selfAddress('inbox');
  let notes = readNotes(me);
  if (since) {
    const i = notes.findIndex(n => n.id === since);
    if (i === -1) throw new Error(`no note ${since} in the inbox of ${me.pane} (${me.session})\n  maw herdr inbox --all`);
    notes = notes.slice(i + 1);
  }
  const LIMIT = 20;
  const older = !all && notes.length > LIMIT ? notes.length - LIMIT : 0;
  const shown = older ? notes.slice(-LIMIT) : notes;

  if (json) {
    console.log(JSON.stringify({ command: 'inbox', json: true, pane: me.pane, session: me.session, older, notes: shown }));
    return;
  }
  console.log(`  ${C.cyan}inbox${C.off} ${C.dim}· ${me.pane} · ${me.session} · ${shown.length} note${shown.length === 1 ? '' : 's'}${since ? ` since ${since}` : ''}${C.off}`);
  if (!shown.length) {
    console.log(`  ${C.dim}nothing here — be told when an agent finishes: maw herdr watch <target>${C.off}`);
    return;
  }
  if (older) console.log(`  ${C.dim}… ${older} older; see them: maw herdr inbox --all${C.off}`);
  for (const n of shown) printNote(n);
  const last = shown[shown.length - 1];
  const reply = [...shown].reverse().find(n => n.from?.pane);
  console.log(`  ${C.dim}newest ${last.id} · next time only what is new: maw herdr inbox --since ${last.id}${C.off}`);
  if (reply) console.log(`  ${C.dim}talk back: maw herdr hey ${reply.from.session && reply.from.session !== me.session ? `--session ${shq(reply.from.session)} ` : ''}${reply.from.pane} "…"${C.off}`);
}
