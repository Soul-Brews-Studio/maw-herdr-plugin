// How `maw herdr ls` prints the four states.
//
// Plain `ls` keeps its workspace tree and gains one line: every worktree
// counted by state. `ls <state>` lists the worktrees in that state, grouped by
// repo — the only way to see the ones with no open space, which the tree
// cannot show because it is drawn from open spaces.

import { checkoutLine } from './mod.checkoutLine.mjs';
import { STATES } from './mod.worktreeStates.mjs';
import { shellQuote } from './mod.resumeProviders.mjs';

/**
 * One JSON document on stdout, resolved once it is actually written.
 *
 * Under Bun, a single console.log larger than a pipe buffer is cut at 65,536
 * bytes when the process ends right after it — measured on this `ls` path
 * before this change too, with the output padded past 64 KB. Every worktree on
 * a real machine (288 on m5) is ~130 KB of JSON, so `ls --json | jq` got
 * half a document. Waiting for the write callback lets it drain.
 */
export function writeJson(value) {
  return new Promise(resolve => process.stdout.write(`${JSON.stringify(value)}\n`, () => resolve()));
}

/**
 * `--state <s>`, taken out of `rest` in place. The positional `ls <state>` is
 * read later, after the other listing flags have had their turn.
 * UsageError is index.mjs's own class, so a bad value still exits 2.
 */
export function takeStateFlag(rest, UsageError) {
  const at = rest.indexOf('--state');
  if (at === -1) return null;
  const state = rest.splice(at, 2)[1];
  if (!STATES.includes(state)) throw new UsageError(`--state needs one of ${STATES.join(', ')}\n  maw herdr ls resumable`);
  if (rest.length) throw new UsageError(`unknown argument: ${rest[0]}`);
  return state;
}

/**
 * One line on why a session's snapshot did not come back: herdr's own last
 * stderr line when it said something, "timed out" when execFile killed it,
 * else the parse error.
 */
export function snapshotFailure(session, err) {
  const said = String(err?.stderr ?? '').split('\n').map(l => l.trim()).filter(Boolean).pop();
  const reason = err?.killed ? 'timed out' : said ?? String(err?.message ?? err).split('\n')[0];
  return { session, reason: reason.length > 200 ? `${reason.slice(0, 199)}…` : reason };
}

/**
 * Why a listing may be short, one warning per cause, each ending in the command
 * that shows the cause. On stderr, so `ls --json | jq` still gets one document.
 *
 * failed:     [{ session, reason }] — herdr sessions whose snapshot did not
 *             come back. Their spaces are absent, so a worktree with a live
 *             agent in one of them falls through to resumable or cold; nothing
 *             here can tell which, so the listing says it is incomplete instead.
 * unreadable: repos `git worktree list` failed on; their closed worktrees are absent.
 */
export function scanWarnings(failed, unreadable) {
  const lines = [];
  for (const { session, reason } of failed) {
    lines.push(`maw herdr: warning: herdr session '${session}' did not return a snapshot (${reason}); its spaces are missing, so worktrees they sit on may show as resumable or cold`);
    lines.push(`  herdr --session ${session} api snapshot`);
  }
  if (unreadable.length) {
    lines.push(`maw herdr: warning: git could not list the worktrees of ${count(unreadable.length, 'repo')}; its closed worktrees are missing from the counts`);
    for (const repo of unreadable.slice(0, 5)) lines.push(`  git -C ${shellQuote(repo)} worktree list`);
    if (unreadable.length > 5) lines.push(`  maw herdr ls --json | jq -r '.unreadable[]'   # ${unreadable.length - 5} more`);
  }
  return lines;
}

/**
 * The state part of `ls`: warnings, then --json or `ls <state>`. Returns true
 * when it printed the whole answer; false leaves plain `ls` to draw its tree.
 */
export async function showWorktreeStates(found, { state, json, path, providers, failed, C }) {
  const warnings = scanWarnings(failed, found.unreadable);
  if (warnings.length) process.stderr.write(`${warnings.join('\n')}\n`);
  if (json) {
    const pick = list => (state ? list.filter(r => r.state === state) : list);
    await writeJson({
      command: 'ls', mode: 'workspaces', scope: 'herdr', json: true, ...(state ? { state } : {}),
      workspaces: pick(found.spaces), worktrees: pick(found.rows), states: found.counts,
      providers: providers.map(p => ({ name: p.name, roots: p.roots })),
      incomplete: failed.map(f => f.session),
      unreadable: found.unreadable,
    });
    return true;
  }
  if (state) {
    printStateListing(found, state, providers, { C, path });
    return true;
  }
  return false;
}

const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function age(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  for (const [size, tag] of [[86400, 'd'], [3600, 'h'], [60, 'm']]) if (s >= size) return `${Math.round(s / size)}${tag} ago`;
  return `${s}s ago`;
}

export function stateDot(state, C) {
  if (state === 'running') return `${C.green}●${C.off}`;
  if (state === 'open') return `${C.cyan}○${C.off}`;
  if (state === 'resumable') return `${C.blue}◐${C.off}`;
  return `${C.dim}·${C.off}`;
}

/**
 * "142 checkouts · 23 running · 1 open · 26 resumable · 92 cold" (resumable says "off" with no provider).
 *
 * "checkouts", not "worktrees": plain `ls` already ends its tree with
 * "… · 20 worktrees · …", counting linked worktrees that have a space open, and
 * this line sits right under it counting every checkout on disk. One noun for
 * two numbers on adjacent lines cannot be read, by a person or by a script.
 */
export function stateTally(result, providers, C) {
  const parts = STATES.map(s => (s === 'resumable' && !providers.length ? `resumable off` : `${result.counts[s]} ${s}`));
  return `${count(result.rows.length, 'checkout')} · ${parts.join(' · ')}`;
}

/** The one line plain `ls` adds under its tree. */
export function stateSummaryLine(result, providers, C) {
  const hint = providers.length ? 'list one: maw herdr ls resumable' : 'no resume provider enabled: MAW_HERDR_RESUME_PROVIDERS=claude,codex maw herdr ls';
  return `  ${C.dim}${stateTally(result, providers, C)} · ${hint}${C.off}`;
}

function detail(r, C) {
  const where = r.workspaces.map(w => w.label).join(', ');
  if (r.state === 'running') return `${C.dim}${count(r.agents, 'agent')} · space ${where}${C.off}`;
  if (r.state === 'open') return `${C.dim}space ${where} · no agent${C.off}`;
  if (r.state === 'resumable') return `${C.dim}${r.resume.provider} ${age(r.resume.at)}${C.off}`;
  return '';
}

/** `ls <state>`: the worktrees in one state, repo → worktree. */
export function printStateListing(result, state, providers, { C, path }) {
  const rows = result.rows.filter(r => r.state === state);
  console.log(`  ${C.blue}Local${C.off} ${C.dim}·${C.off} ${stateDot(state, C)} ${state}`);
  if (state === 'resumable' && !providers.length) {
    console.log(`  ${C.dim}nothing can be resumable: every resume provider is off${C.off}`);
    console.log('  MAW_HERDR_RESUME_PROVIDERS=claude,codex maw herdr ls resumable');
    return;
  }
  const groups = new Map();
  for (const r of rows) {
    const key = r.repoRoot ?? r.path ?? r.label;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const byName = [...groups.values()].sort((a, b) => String(a[0].repo ?? a[0].label).localeCompare(String(b[0].repo ?? b[0].label)));
  for (const items of byName) {
    // main checkout first, then linked worktrees by name
    items.sort((a, b) => Number(a.linked) - Number(b.linked) || a.label.localeCompare(b.label));
    console.log(`    ${C.cyan}${items[0].repo ?? items[0].label}${C.off}`);
    items.forEach((r, i) => {
      const last = i === items.length - 1;
      const branch = r.branch && r.branch !== r.label ? `  ${C.dim}${r.branch}${C.off}` : '';
      const more = detail(r, C);
      console.log(`      ${C.dim}${last ? '└─' : '├─'}${C.off} ${stateDot(r.state, C)} ${r.label}${branch}${more ? `  ${more}` : ''}`);
      if (path) console.log(checkoutLine(r.path, last ? 'last' : 'child', C));
    });
  }
  if (!rows.length) console.log(`    ${C.dim}no ${state} worktrees${C.off}`);
  console.log(`  ${C.dim}${rows.length} ${state} of ${stateTally(result, providers, C)}${C.off}`);
  if (state === 'resumable' && rows.length) {
    const newest = rows.reduce((a, b) => (b.resume.at > a.resume.at ? b : a));
    console.log(`  ${C.dim}resume the newest (${newest.label}):${C.off} ${newest.resume.command}`);
  }
}
