// The restorable list (#90) as `ls`-style lines grouped by repo, or as JSON.
import { shq } from './mod.target.mjs';
import { ago, size, tilde } from './mod.humanize.mjs';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function line(r) {
  const branch = r.local ? 'local branch' : `branch on ${r.remote.split('/')[0]}`;
  const other = r.branch === r.name ? '' : ` ${r.branch}`;
  const husk = r.husk != null ? ` · its folder came back with ${r.husk} leftover file${r.husk === 1 ? '' : 's'} and no .git` : '';
  const tail = `${husk}${r.registered ? ' · git still registers it' : ''}`;
  return `${r.name}  ${branch}${other} · ${r.newest.provider} ${plural(r.sessions, 'session')} ${size(r.bytes)} · newest ${ago(r.newest.at)}${tail}`;
}

export function printRestorable(rows, { json = false } = {}) {
  if (json) {
    const slim = r => ({ ...r, newest: r.newest && { provider: r.newest.provider, id: r.newest.id, at: r.newest.at, file: r.newest.file, command: r.newest.command } });
    return void console.log(JSON.stringify(rows.map(slim), null, 2));
  }
  if (!rows.length) return void console.log('  nothing to restore: every worktree with a transcript still has its folder\n  see what can be resumed: maw herdr ls resumable');
  const ok = rows.filter(r => r.restorable);
  const not = rows.filter(r => !r.restorable);
  if (ok.length) {
    console.log(`  ↺ restorable — folder gone, branch and transcript still here (${ok.length})`);
    const groups = new Map();
    for (const r of ok) groups.set(r.repo, [...(groups.get(r.repo) ?? []), r]);
    for (const [repo, list] of groups) {
      console.log(`    ${tilde(repo)}`);
      list.forEach((r, i) => console.log(`      ${i === list.length - 1 ? '└─' : '├─'} ↺ ${line(r)}`));
    }
  }
  if (not.length) {
    console.log(`  ✗ not restorable (${not.length})`);
    for (const r of not) console.log(`      ${r.name} — ${r.why}`);
  }
  if (ok.length) console.log(`  bring one back: maw herdr restore ${shq(ok[0].name)}${ok.length > 1 ? '   (--dry to see the steps)' : ''}`);
}
