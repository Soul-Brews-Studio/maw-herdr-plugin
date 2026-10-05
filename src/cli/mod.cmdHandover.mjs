// maw herdr handover <space> <oracle> — hand a space's repo to another oracle (#106, on top of `wt`):
// read the space (repo from its origin, branch, clean?, agent idle?), run `wt` in the oracle's own repo
// (resolved with `maw locate`) with a brief whose first step is `/incubate <org>/<repo> --wt <slug>`, then
// close the old space only when its checkout is clean AND its agent idle — otherwise leave it and say why.
import { execFile } from 'node:child_process';
import { TargetError, shq } from './mod.target.mjs';
import { herdrJson, herdrLine } from './mod.herdrCall.mjs';
import { cmdWt, ENGINES } from './mod.cmdWt.mjs';

const USAGE = 'maw herdr handover <space> <oracle> [--issue N] [--engine claude|codex|omx] [--dry]';
const IDLE = new Set(['idle', 'done', 'unknown']);   // a pane with no agent reads unknown

function run(file, args, { cwd, timeout = 30_000 } = {}) {
  return new Promise((ok, fail) => {
    execFile(file, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err) { err.detail = String(stderr || stdout || err.message || '').trim().split('\n')[0]; fail(err); }
      else ok(stdout);
    });
  });
}
const tryRun = async (...a) => { try { return (await run(...a)).trim(); } catch { return null; } };

function parseArgs(args, UsageError) {
  const o = { space: undefined, oracle: undefined, issue: null, engine: 'claude', dry: false };
  const value = (flag) => {
    const v = args.shift();
    if (v === undefined || v.startsWith('-')) throw new UsageError(`${flag} needs a value\n  ${USAGE}`);
    return v;
  };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--issue') o.issue = value(arg);
    else if (arg === '--engine' || arg === '-e') o.engine = value(arg);
    else if (arg === '--dry' || arg === '--dry-run') o.dry = true;
    else if (arg.startsWith('-')) throw new UsageError(`unknown argument: ${arg}\n  ${USAGE}`);
    else if (o.space === undefined) o.space = arg;
    else if (o.oracle === undefined) o.oracle = arg;
    else throw new UsageError(`handover takes a space and an oracle, got extra '${arg}'\n  ${USAGE}`);
  }
  if (o.space === undefined || o.oracle === undefined) throw new UsageError(`handover needs a space and an oracle\n  ${USAGE}\n  maw herdr ls   # spaces\n  maw locate <oracle>`);
  if (o.issue !== null && !/^[1-9][0-9]*$/.test(o.issue)) throw new UsageError(`--issue needs an issue number, got '${o.issue}'\n  maw herdr handover ${shq(o.space)} ${shq(o.oracle)} --issue 106`);
  if (!ENGINES[o.engine]) throw new UsageError(`--engine must be one of ${Object.keys(ENGINES).join(', ')}, got '${o.engine}'\n  maw herdr handover ${shq(o.space)} ${shq(o.oracle)} --engine claude`);
  return o;
}

/** org/repo from a git remote URL (https or ssh); null when it is not a GitHub-shaped remote. */
export const repoOfRemote = (url) => url?.match(/[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/)?.slice(1, 3).join('/') ?? null;

async function findSpace(wanted) {
  const spaces = (await herdrJson(['workspace', 'list'])).result?.workspaces ?? [];
  const hits = spaces.filter(s => s.workspace_id === wanted);
  const exact = hits.length ? hits : spaces.filter(s => s.label === wanted);
  const found = exact.length ? exact : spaces.filter(s => s.label?.includes(wanted));
  if (found.length === 1) return found[0];
  if (!found.length) throw new TargetError(`no herdr space '${wanted}'\n  herdr workspace list | jq -r '.result.workspaces[] | [.workspace_id, .label] | @tsv'`, 'not-found');
  throw new TargetError(`'${wanted}' names ${found.length} spaces; use the id:\n${found.map(s => `  maw herdr handover ${s.workspace_id} <oracle>   # ${s.label}`).join('\n')}`, 'ambiguous');
}

export async function cmdHandover(args, { UsageError = Error } = {}) {
  const o = parseArgs(args, UsageError);
  const space = await findSpace(o.space);
  const panes = ((await herdrJson(['pane', 'list'])).result?.panes ?? []).filter(p => p.workspace_id === space.workspace_id);
  const path = space.worktree?.checkout_path ?? panes[0]?.cwd;
  if (!path) throw new TargetError(`space ${space.workspace_id} (${space.label}) has no folder to read\n  herdr pane list | jq '.result.panes[] | select(.workspace_id == "${space.workspace_id}")'`, 'not-found');

  // read the space: repo from origin, branch, clean?, agent idle?
  const remote = await tryRun('git', ['-C', path, 'remote', 'get-url', 'origin']);
  const source = repoOfRemote(remote);
  if (!source) throw new TargetError(`${path} has no GitHub origin to hand over (origin: ${remote ?? 'none'})\n  git -C ${shq(path)} remote -v`, 'not-found');
  const branch = await tryRun('git', ['-C', path, 'branch', '--show-current']);
  const dirt = (await tryRun('git', ['-C', path, 'status', '--porcelain']))?.split('\n').filter(Boolean) ?? null;
  const busy = panes.filter(p => p.agent && !IDLE.has(p.agent_status));
  const clean = dirt !== null && dirt.length === 0;
  const idle = busy.length === 0;

  // the oracle's own repo
  let located;
  try { located = JSON.parse(await run('maw', ['locate', o.oracle, '--json'])); }
  catch { throw new TargetError(`maw does not know an oracle '${o.oracle}'\n  maw locate ${shq(o.oracle)}\n  maw ls`, 'not-found'); }
  const target = located.local_path;
  if (!target) throw new TargetError(`oracle '${o.oracle}' has no checkout on this machine (${located.org}/${located.repo})\n  ghq get github.com/${located.org}/${located.repo}`, 'not-found');

  const slug = source.split('/')[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'handover';
  const first = `First step: run \`/incubate ${source} --wt ${slug}\` — it gives you your own body of ${source} (branch incubate/${slug}). Handed over from herdr space ${space.workspace_id} (${space.label}, branch ${branch || 'detached'}).`;
  console.log(`  ${space.workspace_id} ${space.label}: ${source} @ ${branch || 'detached'} — ${clean ? 'clean' : dirt === null ? 'unreadable' : `${dirt.length} uncommitted`}, agent ${idle ? 'idle' : `busy (${busy.map(p => p.pane_id).join(', ')})`}`);
  console.log(`  → ${o.oracle} (${located.org}/${located.repo}) at ${target}`);

  const wtArgs = [slug, '--repo', target, '--engine', o.engine, ...(o.issue ? ['--issue', o.issue] : []), ...(o.dry ? ['--dry'] : [])];
  console.log(`  maw herdr wt ${wtArgs.map(shq).join(' ')}   # brief starts: ${first.split('—')[0].trim()}`);
  const made = await cmdWt(wtArgs, { UsageError, briefPrefix: first });

  const close = ['workspace', 'close', space.workspace_id];
  if (o.dry) {
    console.log(`  # then ${clean && idle ? `close ${space.workspace_id}: ${herdrLine(close)}` : `leave ${space.workspace_id} open`} (now: ${clean ? 'clean' : 'not clean'}, agent ${idle ? 'idle' : 'busy'})`);
    return;
  }
  const why = [];
  if (!clean) why.push(dirt === null ? `its checkout could not be read` : `its checkout has ${dirt.length} uncommitted change${dirt.length === 1 ? '' : 's'}`);
  if (!idle) why.push(`its agent is not idle (${busy.map(p => `${p.pane_id} ${p.agent_status}`).join(', ')})`);
  if (!made?.briefed) why.push(`the new agent was not briefed yet (answer its startup question first)`);
  if (why.length) {
    console.log(`  ○ ${space.workspace_id} left open: ${why.join('; ')}`);
    console.log(`    when it is safe: ${herdrLine(close)}`);
    return;
  }
  try { await run('herdr', close); console.log(`  ● closed ${space.workspace_id} (${space.label}); the folder ${path} stays`); }
  catch (err) { throw new TargetError(`close failed — ${err.detail || err.message}; the handover itself is done\n  ${herdrLine(close)}`, 'herdr'); }
}
