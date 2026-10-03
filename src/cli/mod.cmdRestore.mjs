/**
 * maw herdr restore [<name|path>] (#90) — the list with no target; with one,
 * `git worktree add` at THE SAME PATH, then the resume code path. The same path is
 * the point: Claude keys its project directories by the encoded cwd, so a worktree
 * recreated anywhere else would orphan the transcripts this is rescuing. Refusals —
 * branch gone, branch held by another worktree, ambiguous name — change nothing and
 * print the command that resolves them. A folder that exists goes to resume.
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { TargetError, shq } from './mod.target.mjs';
import { cmdResume } from './mod.lifecycle.mjs';
import { findRestorable } from './mod.findRestorable.mjs';
import { printRestorable } from './mod.printRestorable.mjs';
import { restoreArgs } from './mod.restoreArgs.mjs';
import { git, gitLine } from './mod.git.mjs';
import { ago, size } from './mod.humanize.mjs';
import { copyBack, huskStamp, moveAside } from './mod.husk.mjs';
import { renameSync } from 'node:fs';

export const HELP = `maw herdr restore [--json]
maw herdr restore <name|path> [--dry] [--no-resume] [--session S]
  Bring back a worktree whose FOLDER is gone while its branch and its agent
  transcripts survive. No target: the list (= maw herdr ls restorable). A target:
  git worktree add at the SAME path (Claude finds transcripts by path) from its
  branch — local as it is, remote-only with --track -b — then resume it on its
  newest transcript. A target whose folder exists is handed to resume.
    --dry        print the git and resume steps; change nothing
    --no-resume  only put the folder back; resume later: maw herdr resume <path>
    maw herdr restore                      maw herdr restore alpha-feature --dry`;

function pick(rows, raw) {
  const full = resolve(raw.replace(/^~(?=\/|$)/, homedir()));
  const exact = rows.filter(r => r.name === raw || r.path === raw || r.path === full);
  return exact.length ? exact : rows.filter(r => r.name.includes(raw));
}

async function handOver(o, resume, UsageError) {
  try {
    return await resume([o.target, ...(o.dry ? ['--dry'] : []), ...(o.session ? ['--session', o.session] : [])], { UsageError });
  } catch (err) {
    if (!(err instanceof TargetError) || err.code !== 'not-found') throw err;
    throw new TargetError(`nothing named '${o.target}' to restore, and no worktree by that name to resume\n  see what can come back: maw herdr restore`, 'not-found');
  }
}

function refuse(r, raw, hits) {
  if (hits.length > 1) {
    return new TargetError(`'${raw}' matches ${hits.length} worktrees whose folder is gone — nothing was done. Name one:\n${hits.map(h => `  maw herdr restore ${shq(h.name === raw ? h.path : h.name)}   # ${h.restorable ? 'restorable' : h.why}`).join('\n')}`, 'ambiguous');
  }
  if (!r.branch) {
    return new TargetError(`'${r.name}': its folder is gone and so is its branch (${r.why.replace(/^its branch is gone /, '')}) — there is nothing to check out. Its newest transcript is ${r.newest.provider} ${r.newest.id} (${ago(r.newest.at)}). To resume it in a NEW branch at the same path (the old commits are not coming back):\n  ${gitLine(r.repo, ['worktree', 'add', '-b', r.name, r.path])}\n  maw herdr resume ${shq(r.path)}`, 'gone');
  }
  if (r.heldBy) return new TargetError(`branch ${r.branch} is checked out at ${r.heldBy} — git will not check it out twice; resume it there instead:\n  maw herdr resume ${shq(r.heldBy)}`, 'held');
  return null;
}

export async function cmdRestore(args, { UsageError = Error, resume = cmdResume, find = findRestorable } = {}) {
  const o = restoreArgs(args, UsageError);
  if (o.help) return void console.log(HELP);
  const rows = await find();
  if (!o.target) return void printRestorable(rows, { json: o.json });
  const hits = pick(rows, o.target);
  if (!hits.length) return handOver(o, resume, UsageError);
  const r = hits[0];
  const no = refuse(r, o.target, hits);
  if (no) throw no;
  const force = r.registered ? ['-f'] : [];
  const add = r.local ? ['worktree', 'add', ...force, r.path, r.branch] : ['worktree', 'add', ...force, '--track', '-b', r.branch, r.path, r.remote];
  const session = o.session ? ` --session ${shq(o.session)}` : '';
  console.log(`  restore   ${r.name} → ${r.path}`);
  console.log(`    branch  ${r.branch}${r.local ? '' : ` (only on ${r.remote.split('/')[0]}: a local branch tracking ${r.remote})`}${r.registered ? ' · git still registers this path with its folder missing: add -f' : ''}`);
  console.log(`    newest  ${r.newest.provider} ${r.newest.id} · ${ago(r.newest.at)} · ${r.sessions} session${r.sessions === 1 ? '' : 's'}, ${size(r.bytes)}`);
  const stamp = huskStamp();
  if (r.husk != null) console.log(`    husk    the folder is back with ${r.husk} leftover file${r.husk === 1 ? '' : 's'} and no .git: moved to ${r.path}.husk-${stamp} first, then copied back where the checkout has none (the moved folder stays)`);
  console.log(`    run     ${gitLine(r.repo, add)}`);
  console.log(`    then    ${o.resume ? '' : '(--no-resume) '}maw herdr resume ${shq(r.path)}${session}`);
  if (o.dry) return void console.log('  --dry: nothing was done');
  const backup = r.husk != null ? moveAside(r.path, stamp) : null;
  if (backup) console.log(`  moved     ${r.path} → ${backup}`);
  try {
    await git(r.repo, add, { timeout: 120_000 });
  } catch (err) {
    if (backup) renameSync(backup, r.path);   // put the husk back as it was
    throw new TargetError(`git worktree add failed — ${err.detail || err.message}; nothing else was done${backup ? ' (the leftover folder is back in place)' : ''}:\n  ${gitLine(r.repo, add)}`, 'git');
  }
  console.log(`  added     ${r.path} on ${r.branch}`);
  if (backup) {
    const { copied, kept } = copyBack(backup, r.path);
    console.log(`  leftovers ${copied} copied back${kept ? `, ${kept} not (the checkout has its own)` : ''} · backup kept: ${backup}`);
  }
  if (!o.resume) return void console.log(`  resume it when you want: maw herdr resume ${shq(r.path)}`);
  return resume([r.path, ...(o.session ? ['--session', o.session] : [])], { UsageError });
}
