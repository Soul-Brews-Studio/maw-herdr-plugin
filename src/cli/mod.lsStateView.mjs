// How `maw herdr ls` prints the four states.
//
// Plain `ls` keeps its workspace tree and gains one line: every worktree
// counted by state. `ls <state>` lists the worktrees in that state, grouped by
// repo — the only way to see the ones with no open space, which the tree
// cannot show because it is drawn from open spaces.

import { checkoutLine } from './mod.checkoutLine.mjs';
import { STATES } from './mod.worktreeStates.mjs';

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

/** "142 worktrees · 23 running · 1 open · 26 resumable · 92 cold" (resumable says "off" with no provider). */
export function stateTally(result, providers, C) {
  const parts = STATES.map(s => (s === 'resumable' && !providers.length ? `resumable off` : `${result.counts[s]} ${s}`));
  return `${count(result.rows.length, 'worktree')} · ${parts.join(' · ')}`;
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
