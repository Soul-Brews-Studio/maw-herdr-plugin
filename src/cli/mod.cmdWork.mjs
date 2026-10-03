// maw herdr work — open a repo, or one task worktree of it, as a space with an agent in the
// running session: the herdr port of maw-rs `maw work` (#101). A repo is `.`/a path, org/repo,
// a GitHub URL (repo, issue or pull) or a bare name under ghq. A task gets the worktree the
// dashboard's task flow uses — <repo>/agents/<slug> on agents/<slug>, labelled <repo>-<slug> —
// planned by the same planTaskWorktree. --dry plans every step and runs none of them.
import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { TargetError, shq } from './mod.target.mjs';
import { herdrJson, herdrLine } from './mod.herdrCall.mjs';
import { planTaskWorktree, taskSlug } from '../serve/bun/mod.planTaskWorktree.ts';

const USAGE = 'maw herdr work <repo|.|path|url> [task] [--wt [slug]] [--engine <kind>] [--prompt <text>] [--attach] [--dry]';
const GITHUB = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(issues|pull)\/(\d+))?(?:[/?#].*)?$/;
const ORG_REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

const isDir = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };

function run(file, args, { cwd, timeout = 15_000 } = {}) {
  return new Promise((ok, fail) => {
    execFile(file, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err) { err.detail = String(stderr || err.message || '').trim().split('\n')[0]; fail(err); }
      else ok(stdout);
    });
  });
}

function parseArgs(args, UsageError) {
  const o = { input: undefined, task: [], wt: undefined, engine: 'claude', prompt: null, attach: false, dry: false };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--wt') o.wt = args.length && !args[0].startsWith('-') ? args.shift() : '';
    else if (arg.startsWith('--wt=')) o.wt = arg.slice(5);
    else if (arg === '--engine' || arg === '--kind' || arg === '-e') o.engine = args.shift() ?? '';
    else if (arg === '--prompt') o.prompt = args.shift() ?? '';
    else if (arg === '--attach' || arg === '-a') o.attach = true;
    else if (arg === '--dry' || arg === '--dry-run') o.dry = true;
    else if (arg.startsWith('-') && arg !== '.' && arg !== '-') throw new UsageError(`unknown argument: ${arg}\n  ${USAGE}`);
    else if (o.input === undefined) o.input = arg;
    else o.task.push(arg);
  }
  if (o.input === undefined) throw new UsageError(`work needs a repo\n  ${USAGE}`);
  if (!o.engine || o.engine.startsWith('-')) throw new UsageError('--engine needs a value (a herdr agent kind, e.g. claude, codex)\n  maw herdr work . --engine claude');
  if (o.task.length && o.wt !== undefined) throw new UsageError(`use either a task or --wt, not both (maw-rs rule)\n  maw herdr work ${shq(o.input)} --wt ${shq(taskSlugOr(o.task.join(' ')))}`);
  return o;
}

const taskSlugOr = (raw) => { try { return taskSlug(raw); } catch { return 'my-task'; } };

async function ghqRoot() {
  try { return (await run('ghq', ['root'])).trim(); } catch {}
  return join(homedir(), 'ghq');
}

async function toplevel(path) {
  try { return realpathSync((await run('git', ['rev-parse', '--show-toplevel'], { cwd: path })).trim()); }
  catch { throw new TargetError(`'${path}' is not inside a git checkout\n  git -C ${shq(path)} rev-parse --show-toplevel`, 'not-found'); }
}

/** → { name, path, org?, clone?, issue?, prompt? } — clone is the command to run when not yet checked out. */
async function resolveRepo(input, UsageError) {
  const local = resolve(input.replace(/^~(?=\/|$)/, homedir()));
  if (input === '.' || /^(\/|\.\.?\/|~)/.test(input) || isDir(local)) {
    if (!isDir(local)) throw new TargetError(`no directory '${input}'\n  ls -d ${shq(local)}`, 'not-found');
    const path = await toplevel(local);
    return { name: basename(path), path };
  }
  const gh = input.match(GITHUB) ?? (input.match(ORG_REPO) && [input, ...input.match(ORG_REPO).slice(1)]);
  if (gh) {
    const [, org, repo, kind, number] = gh;
    const path = join(await ghqRoot(), 'github.com', org, repo);
    const ssh = /^(git@|ssh:\/\/)/.test(input);
    const out = { name: repo, org, path };
    if (kind) Object.assign(out, { issue: { kind, number }, prompt: `https://github.com/${org}/${repo}/${kind}/${number}` });
    if (!isDir(path)) out.clone = ['ghq', 'get', ...(ssh ? ['-p'] : []), `github.com/${org}/${repo}`];
    else out.path = await toplevel(path);
    return out;
  }
  if (input.includes('/') || input.includes(':')) {
    throw new UsageError(`'${input}' is not a path, org/repo, GitHub URL or repo name\n  ${USAGE}`);
  }
  let listed = [];
  try { listed = (await run('ghq', ['list', '-p'])).split('\n').filter(Boolean); }
  catch { throw new TargetError(`ghq is not available to find '${input}' — give a path or org/repo instead\n  maw herdr work <org>/${input}`, 'not-found'); }
  const hits = listed.filter(p => basename(p) === input);
  if (hits.length === 1) { const path = await toplevel(hits[0]); return { name: basename(path), path }; }
  if (hits.length > 1) throw new TargetError(`'${input}' names ${hits.length} checkouts; pick one:\n${hits.map(p => `  maw herdr work ${shq(p)}`).join('\n')}`, 'ambiguous');
  throw new TargetError(`no checkout named '${input}' under ghq — name it by org/repo (clones when missing):\n  maw herdr work <org>/${input} --dry`, 'not-found');
}

async function runningSession() {
  let list;
  try { list = JSON.parse(await run('herdr', ['session', 'list', '--json'])).sessions ?? []; }
  catch (err) { throw new TargetError(`herdr session list failed — ${err?.code === 'ENOENT' ? 'herdr is not on PATH' : err?.detail || err?.message}\n  herdr session list --json`, 'herdr'); }
  const running = list.filter(s => s.running).map(s => s.name);
  if (running.includes('default')) return 'default';
  if (running.length === 1) return running[0];
  if (!running.length) throw new TargetError('no herdr session is running — start one, then run this again\n  herdr', 'not-found');
  throw new TargetError(`${running.length} herdr sessions are running and none is 'default' — the space would land in an arbitrary one\n  herdr session list --json`, 'ambiguous');
}

const agentName = (label) => (label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '') || 'work').slice(0, 32);
const real = (p) => { try { return realpathSync(p); } catch { return null; } };

export async function cmdWork(args, { UsageError = Error, runAttach } = {}) {
  const o = parseArgs(args, UsageError);
  const repo = await resolveRepo(o.input, UsageError);
  if (o.wt === '' && !repo.issue) throw new UsageError(`--wt needs a slug, or give a task or an issue URL\n  maw herdr work ${shq(o.input)} --wt my-task`);
  const taskRaw = o.wt || o.task.join(' ') || (repo.issue ? `${repo.issue.kind === 'pull' ? 'pr' : 'issue'}-${repo.issue.number}` : '');
  const prompt = o.prompt ?? repo.prompt ?? null;
  const session = await runningSession();
  const plan = [];
  if (repo.clone) plan.push(repo.clone.map(shq).join(' '));

  // the worktree: planned by the dashboard's planner when the checkout exists; spelled out when it is still to be cloned
  let path = repo.path, label = repo.name, worktree = null;
  if (taskRaw) {
    if (repo.clone) {
      const slug = taskSlug(taskRaw);
      worktree = { slug, path: join(repo.path, 'agents', slug), branch: `agents/${slug}`, create: true, materialize: null };
    } else {
      try { worktree = await planTaskWorktree(repo.path, taskRaw, AbortSignal.timeout(30_000)); }
      catch (err) {
        throw new TargetError(`no task worktree for '${taskRaw}' in ${repo.path} — ${err?.message || err} (an unsafe or ambiguous agents/ layout is refused)\n  git -C ${shq(repo.path)} worktree list`, 'refused');
      }
    }
    path = worktree.path; label = `${repo.name}-${worktree.slug}`;
    plan.push(worktree.create ? `git -C ${shq(repo.path)} worktree add ${shq(worktree.path)} -b ${shq(worktree.branch)}` : `# reuse worktree ${worktree.path} (${worktree.branch || 'detached'})`);
  }
  const agent = agentName(label);

  // a space already showing this folder is reused, not doubled
  let open = [];
  if (!repo.clone && !(worktree && worktree.create)) {
    const panes = (await herdrJson(['pane', 'list'], session)).result?.panes ?? [];
    open = panes.filter(p => p.cwd && real(p.cwd) === real(path));
  }
  plan.push(...(open.length ? [`# already open: ${open.map(p => p.pane_id).join(', ')}`] : [
    `${herdrLine(['workspace', 'create', '--cwd', path, '--label', label, '--no-focus'], session)}`,
    `${herdrLine(['agent', 'start', agent, '--kind', o.engine, '--pane', '<root pane>'], session)}`,
    ...(prompt !== null ? [herdrLine(['agent', 'prompt', agent, prompt], session)] : []),
  ]), ...(o.attach ? [herdrLine([], session)] : []));

  console.log(`  ${label} → ${repo.org ? `${repo.org}/${repo.name}` : repo.path}${worktree ? `  worktree ${worktree.branch}` : ''}  herdr session ${session}, agent ${agent} (${o.engine})`);
  if (o.dry) {
    console.log('Plan:');
    for (const line of plan) console.log(`  ${line}`);
    return;
  }

  if (repo.clone) {
    try { await run(repo.clone[0], repo.clone.slice(1), { timeout: 300_000 }); }
    catch (err) {
      throw new TargetError(`clone failed — ${err?.detail || err?.message}\n  gh repo clone ${repo.org}/${repo.name} ${shq(repo.path)}`, 'clone');
    }
    console.log(`  ● cloned ${repo.org}/${repo.name} → ${repo.path}`);
    repo.path = await toplevel(repo.path);
    if (taskRaw) {
      worktree = await planTaskWorktree(repo.path, taskRaw, AbortSignal.timeout(30_000));
      path = worktree.path; label = `${repo.name}-${worktree.slug}`;
    } else path = repo.path;
  }
  if (worktree?.materialize) {
    await worktree.materialize();
    console.log(`  ● worktree ${worktree.path} (${worktree.branch})${worktree.create ? '' : ' — reused'}`);
  }
  if (open.length) {
    console.log(`  already open: ${label} in pane ${open.map(p => p.pane_id).join(', ')} — nothing started`);
    if (o.attach && runAttach) runAttach(['herdr', '--session', session]);
    else console.log(`  bring it up: maw herdr a ${shq(open[0].pane_id)}`);
    return;
  }

  const created = await herdrJson(['workspace', 'create', '--cwd', path, '--label', label, '--no-focus'], session);
  const pane = created.result?.root_pane?.pane_id;
  if (!pane) throw new TargetError(`workspace create returned no root pane: ${JSON.stringify(created).slice(0, 160)}\n  ${herdrLine(['workspace', 'list'], session)}`, 'herdr');
  const name = agentName(label);
  // an engine can take longer than one herdr call to come up: wake allows 60 s, so does work
  const start = ['agent', 'start', name, '--kind', o.engine, '--pane', pane];
  try { await run('herdr', ['--session', session, ...start], { timeout: 60_000 }); }
  catch (err) { throw new TargetError(`agent start failed — ${err?.detail || err?.message}; the space ${label} is open in pane ${pane} without an agent\n  ${herdrLine(start, session)}`, 'herdr'); }
  console.log(`  ● opened ${label} in ${session} pane ${pane}, agent ${name} (${o.engine})`);
  if (prompt !== null) {
    const send = ['agent', 'prompt', name, prompt];
    try { await run('herdr', ['--session', session, ...send], { timeout: 30_000 }); }
    catch (err) { throw new TargetError(`prompt not sent — ${err?.detail || err?.message}\n  ${herdrLine(send, session)}`, 'herdr'); }
    console.log(`  ● prompt sent: ${prompt}`);
  }
  if (o.attach && runAttach) runAttach(['herdr', '--session', session]);
  else console.log(`  bring it up: maw herdr a ${shq(label)}`);
}
