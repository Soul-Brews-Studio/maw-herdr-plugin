// maw herdr wt — the /herdr-wt flow as a verb (#106): cut <repo>/wt/<slug>-<owner>[-issue<N>]-<day>
// as a herdr worktree space, lock it, fix its token, start the engine through the pane's shell,
// name the agent and brief it by pane id. Every step and trap is from ~/.claude/skills/herdr-wt:
//   1 `herdr agent start` bypasses direnv (wrong token) → start the engine with `pane run`
//   2 a fresh worktree's pane shell beat the trust → one throwaway `pane run` first
//   3 `agent rename` right after start fails agent_not_found → wait for the engine, --timeout in ms
//   4 agent names: lowercase, a letter first, ≤ 32 chars → <slug>-<owner>, else <slug>
//   5 brief by pane id, never by agent name (names prefix-match)
//   6 branch from origin/<default> after a fetch, never HEAD (the main checkout may sit on a feature branch)
//   7 a folder-trust question is reported, never answered
// The verb does not write issues: --issue N links one that exists. --dry runs only reads.
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { TargetError, shq } from './mod.target.mjs';
import { herdrLine } from './mod.herdrCall.mjs';

const USAGE = 'maw herdr wt <slug> [--base REF] [--issue N] [--engine claude|codex|omx] [--brief <text>] [--repo <path>] [--dry]';
export const ENGINES = {
  claude: { cmd: 'claude', wait: ['--match', 'bypass permissions', '--timeout', '40000'] },
  codex: { cmd: 'codex --dangerously-bypass-approvals-and-sandbox', wait: ['--regex', 'Ask Codex to do anything|Hooks need review', '--source', 'visible', '--timeout', '150000'] },
  omx: { cmd: 'OMX_AUTO_UPDATE=0 omx --direct --madmax', wait: ['--regex', 'Ask Codex to do anything|Hooks need review', '--source', 'visible', '--timeout', '150000'] },
};
const WARMUP = 'echo "TOK=$CLAUDE_TOKEN_NAME"';
const sleep = (ms) => new Promise(ok => setTimeout(ok, ms));

function run(file, args, { cwd, timeout = 30_000 } = {}) {
  return new Promise((ok, fail) => {
    execFile(file, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err) { err.detail = String(stderr || stdout || err.message || '').trim().split('\n')[0]; err.stdout = stdout; fail(err); }
      else ok(stdout);
    });
  });
}
const tryRun = async (...a) => { try { return (await run(...a)).trim(); } catch { return null; } };

function parseArgs(args, UsageError) {
  const o = { slug: undefined, base: null, issue: null, engine: 'claude', brief: null, repo: null, dry: false };
  const value = (flag) => {
    const v = args.shift();
    if (v === undefined || v.startsWith('-')) throw new UsageError(`${flag} needs a value\n  ${USAGE}`);
    return v;
  };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--base') o.base = value(arg);
    else if (arg === '--issue') o.issue = value(arg);
    else if (arg === '--engine' || arg === '-e') o.engine = value(arg);
    else if (arg === '--brief') o.brief = value(arg);
    else if (arg === '--repo') o.repo = value(arg);
    else if (arg === '--dry' || arg === '--dry-run') o.dry = true;
    else if (arg.startsWith('-')) throw new UsageError(`unknown argument: ${arg}\n  ${USAGE}`);
    else if (o.slug === undefined) o.slug = arg;
    else throw new UsageError(`one slug only, got '${o.slug}' and '${arg}'\n  maw herdr wt ${shq(o.slug)}`);
  }
  if (o.slug === undefined) throw new UsageError(`wt needs a slug\n  ${USAGE}\n  maw herdr wt my-task --dry`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(o.slug)) throw new UsageError(`slug '${o.slug}' must be lowercase letters, digits and '-', starting with a letter or digit\n  maw herdr wt ${shq(o.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '') || 'my-task')}`);
  if (o.issue !== null && !/^[1-9][0-9]*$/.test(o.issue)) throw new UsageError(`--issue needs an issue number, got '${o.issue}'\n  maw herdr wt ${shq(o.slug)} --issue 106`);
  if (!ENGINES[o.engine]) throw new UsageError(`--engine must be one of ${Object.keys(ENGINES).join(', ')}, got '${o.engine}'\n  maw herdr wt ${shq(o.slug)} --engine claude`);
  if (o.brief !== null && !o.brief.trim()) throw new UsageError(`--brief is empty\n  maw herdr wt ${shq(o.slug)} --brief 'read the issue first'`);
  return o;
}

/** Bangkok day, lowercase, no padding: 4oct-sun2026 — what `TZ=Asia/Bangkok date +%-d%b-%a%Y` prints. */
export function bangkokDay(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', weekday: 'short', year: 'numeric' })
    .formatToParts(date).map(x => [x.type, x.value]));
  return `${p.day}${p.month}-${p.weekday}${p.year}`.toLowerCase();
}

/** Worktree/branch name: slug first, owner = repo basename without -oracle, -issue<N> when linked, day last. */
export const wtName = (slug, repoPath, issue, day = bangkokDay()) =>
  `${slug}-${basename(repoPath).replace(/-oracle$/, '')}${issue ? `-issue${issue}` : ''}-${day}`;

/** Agent name: <slug>-<owner> when it is a legal herdr name (≤ 32), else <slug>. */
export function agentNameFor(slug, repoPath) {
  const clean = (s) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '');
  const full = clean(`${slug}-${basename(repoPath).replace(/-oracle$/, '')}`);
  if (full && full.length <= 32) return full;
  return (clean(slug) || 'work').slice(0, 32);
}

export const lockReason = (slug, issue, who, when) => `herdr|${who}|${when}|${slug}${issue ? `|#${issue}` : ''}`;

export const briefFor = (issue, repo, text) => text ?? [
  `Your task is GitHub issue #${issue} in ${repo}: https://github.com/${repo}/issues/${issue}`,
  `Read it first: gh issue view ${issue} --repo ${repo} --comments`,
  'It is your full brief — sources, deliverables, rules, done criteria.',
  'Report progress as comments on that issue (what is done, what is blocked, open questions).',
  `Work only in this worktree, commit on this branch. Open a PR with "Closes #${issue}" only if the issue says to.`,
].join('\n');

/** The checkout that owns the worktree: git's common dir, so `.` inside a linked worktree is its main repo. */
async function mainRepo(input) {
  const start = resolve(input);
  const common = await tryRun('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: start });
  if (!common) throw new TargetError(`'${start}' is not inside a git checkout\n  git -C ${shq(start)} rev-parse --show-toplevel`, 'not-found');
  return basename(common) === '.git' ? dirname(common) : common;
}

/** origin/<default>, never HEAD. Real runs fetch first; --dry only reads. */
async function resolveBase(repo, given, dry) {
  if (given) return given;
  if (!dry) {
    try { await run('git', ['-C', repo, 'fetch', 'origin', '--prune']); }
    catch (err) { throw new TargetError(`git fetch origin failed — ${err.detail || err.message}; the base would be stale\n  git -C ${shq(repo)} fetch origin\n  maw herdr wt <slug> --base HEAD   # only when this repo has no origin`, 'git'); }
  }
  let head = await tryRun('git', ['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (!head && !dry) {
    await tryRun('git', ['-C', repo, 'remote', 'set-head', 'origin', '-a']);
    head = await tryRun('git', ['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  }
  if (head) return head;
  if (dry) return 'origin/HEAD';
  throw new TargetError(`cannot tell origin's default branch in ${repo} — refusing to branch from HEAD, which may be someone's feature branch\n  git -C ${shq(repo)} remote set-head origin -a\n  git -C ${shq(repo)} branch -r`, 'not-found');
}

/** → { dry } | { space, pane, name, briefed } — handover reads it to decide whether the old space may close.
 *  briefPrefix: lines put before the brief (handover's first step); it is sent even with no --issue/--brief. */
export async function cmdWt(args, { UsageError = Error, briefPrefix = null } = {}) {
  const o = parseArgs(args, UsageError);
  const repo = await mainRepo(o.repo ?? process.cwd());
  const name = wtName(o.slug, repo, o.issue);
  const dest = join(repo, 'wt', name);
  const agent = agentNameFor(o.slug, repo);
  const engine = ENGINES[o.engine];
  const who = `${userInfo().username}@${hostname().split('.')[0]}`;
  const reason = lockReason(o.slug, o.issue, who, new Date().toISOString());
  if (existsSync(dest)) throw new TargetError(`already exists: ${dest}\n  ls -la ${shq(dest)}\n  maw herdr wt ${shq(`${o.slug}-2`)}${o.issue ? ` --issue ${o.issue}` : ''}`, 'refused');

  const base = await resolveBase(repo, o.base, o.dry);
  const token = await tryRun('maw', ['token', 'resolve'], { cwd: repo });
  const issueRepo = o.issue ? await tryRun('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: repo }) : null;
  if (o.issue && !issueRepo) throw new TargetError(`--issue ${o.issue} needs a GitHub repo to name it in — gh repo view failed in ${repo}\n  gh repo view --json nameWithOwner\n  gh auth status`, 'not-found');
  const body = o.issue || o.brief !== null ? briefFor(o.issue, issueRepo, o.brief) : null;
  const briefText = briefPrefix || body ? [briefPrefix, body].filter(Boolean).join('\n') : null;

  const create = ['worktree', 'create', '--cwd', repo, '--branch', name, '--base', base, '--path', dest, '--no-focus'];
  const lockArgs = ['-C', repo, 'worktree', 'lock', '--reason', reason, dest];
  const wait = ['pane', 'wait-output', '<pane>', ...engine.wait];
  const commentBody = (space, pane, lab) => `Workspace\n- branch: \`${name}\`\n- path: \`wt/${name}\`\n- herdr space: \`${space}\` · pane: \`${pane}\`\n- agent: \`${agent}\` (${o.engine})\n- lab: \`${lab || 'none (no ψ/ in this repo)'}\``;
  const plan = [
    ...(o.base ? [] : [`git -C ${shq(repo)} fetch origin --prune   # base = ${base}, never HEAD`]),
    herdrLine(create),
    `git ${lockArgs.map(shq).join(' ')}`,
    ...(existsSync(join(repo, '.envrc')) ? [`# copy .envrc into the worktree when it has none`] : []),
    token ? `(cd ${shq(dest)} && maw token use ${shq(token)})` : '# token: no assignment (maw token resolve found none) — maw token use skipped',
    `# when the worktree has ψ/: mkdir ψ/lab/${o.slug} and re-include it in .gitignore`,
    herdrLine(['pane', 'run', '<pane>', WARMUP]),
    herdrLine(['pane', 'run', '<pane>', engine.cmd]),
    herdrLine(wait),
    herdrLine(['agent', 'rename', '<pane>', agent]),
    ...(o.issue ? [`gh issue comment ${o.issue} --repo ${issueRepo} --body <workspace: branch, path, space, pane, agent>`] : []),
    ...(briefText !== null ? [herdrLine(['agent', 'prompt', '<pane>', briefText.split('\n')[0] + ' …'])] : []),
  ];

  console.log(`  ${name} → ${repo}  base ${base}, agent ${agent} (${o.engine})`);
  if (o.dry) {
    console.log('Plan:');
    for (const line of plan) console.log(`  ${line.replaceAll("'<pane>'", '<pane>')}`);   // the pane is only known once herdr makes it
    return { dry: true };
  }

  // 1 — the worktree, as a herdr space
  let made;
  try { made = JSON.parse(await run('herdr', create)); }
  catch (err) { throw new TargetError(`worktree create failed — ${err.detail || err.message}\n  ${herdrLine(create)}`, 'herdr'); }
  const space = made.result?.workspace?.workspace_id ?? '?';
  console.log(`  ● worktree ${dest} (${name}) in space ${space}`);
  const stuck = (what, cmd) => new TargetError(`${what}; the space ${space} and ${dest} exist\n  ${cmd}`, 'herdr');
  try { await run('git', lockArgs); console.log(`  ● locked: ${reason}`); }
  catch (err) { throw stuck(`lock failed — ${err.detail || err.message}`, `git ${lockArgs.map(shq).join(' ')}`); }

  // 2 — untracked env, then token + direnv trust in one step
  if (existsSync(join(repo, '.envrc')) && !existsSync(join(dest, '.envrc'))) { copyFileSync(join(repo, '.envrc'), join(dest, '.envrc')); console.log('  ● copied .envrc'); }
  if (token) {
    try { await run('maw', ['token', 'use', token], { cwd: dest }); console.log(`  ● token ${token} (allowed ${dest})`); }
    catch (err) { throw stuck(`maw token use ${token} failed — ${err.detail || err.message}`, `cd ${shq(dest)} && maw token use ${shq(token)}`); }
  } else console.log('  ○ token: no assignment found — skipped (maw token resolve)');

  // 3 — the lab folder, only where a ψ/ vault came with the worktree
  let lab = '';
  if (existsSync(join(dest, 'ψ'))) {
    lab = `ψ/lab/${o.slug}`;
    mkdirSync(join(dest, lab), { recursive: true });
    const ignored = async () => (await tryRun('git', ['-C', dest, 'check-ignore', '-q', `${lab}/x`])) !== null;
    if (await ignored()) {
      appendFileSync(join(dest, '.gitignore'), `!${lab}/\n`);
      if (await ignored()) throw stuck(`${lab} is still ignored: a parent directory is excluded`, `git -C ${shq(dest)} check-ignore -v ${shq(`${lab}/x`)}`);
    }
    console.log(`  ● lab ${lab}`);
  }

  // 4 — the pane: the create answer when it names one, else the pane herdr registers on that folder
  let pane = made.result?.root_pane?.pane_id ?? null;
  for (let i = 0; !pane && i < 20; i++) {
    try { pane = (JSON.parse(await run('herdr', ['pane', 'list'])).result?.panes ?? []).find(p => p.cwd === dest)?.pane_id ?? null; } catch {}
    if (!pane) await sleep(500);
  }
  if (!pane) throw stuck(`no pane registered on ${dest}`, `herdr pane list`);

  if (o.issue) {
    try { await run('gh', ['issue', 'comment', o.issue, '--repo', issueRepo, '--body', commentBody(space, pane, lab)], { cwd: repo }); console.log(`  ● commented the workspace on ${issueRepo}#${o.issue}`); }
    catch (err) { console.log(`  ⚠ could not comment on ${issueRepo}#${o.issue} — ${err.detail || err.message}\n    gh issue comment ${o.issue} --repo ${issueRepo} --body ${shq(commentBody(space, pane, lab))}`); }
  }

  // 5 — the engine through the pane's shell: throwaway first, then the engine
  const step = async (a, what, fix = herdrLine(a)) => {
    try { return await run('herdr', a, { timeout: 200_000 }); }
    catch (err) { throw stuck(`${what} failed — ${err.detail || err.message}`, fix); }
  };
  await step(['pane', 'run', pane, WARMUP], 'warm-up');
  await step(['pane', 'run', pane, engine.cmd], `${o.engine} launch`);
  console.log(`  ● ${o.engine} started in ${pane} through the pane's shell`);
  const waitArgs = ['pane', 'wait-output', pane, ...engine.wait];
  const held = (why) => {
    // never answer a folder-trust or hooks question: it is a person's call. Exit 0 — the space exists.
    console.log(`  ● opened ${name} in pane ${pane}; ${o.engine} is ${why}`);
    console.log(`    (a folder it has never opened asks whether to trust it) — answer it yourself:`);
    console.log(`    maw herdr a ${shq(pane)}`);
    console.log(`    then: ${herdrLine(['agent', 'rename', pane, agent])}`);
    if (briefText !== null) console.log(`  brief held back; send it after answering:\n    ${herdrLine(['agent', 'prompt', pane, briefText])}`);
    return { space, pane, name, briefed: false };
  };
  try { await run('herdr', waitArgs, { timeout: 200_000 }); }
  catch { return held('waiting at a startup question (it never reached its prompt)'); }
  if (o.engine !== 'claude') {
    const screen = await tryRun('herdr', ['pane', 'read', pane, '--source', 'visible', '--lines', '30']);
    if (screen?.includes('Hooks need review')) return held('waiting at its hooks trust gate');
  }

  // 6 — name it (after the wait, or agent_not_found), then brief by pane id
  const rename = ['agent', 'rename', pane, agent];
  try { await run('herdr', rename); console.log(`  ● agent named ${agent}`); }
  catch (err) { console.log(`  ⚠ could not name the agent ${agent} — ${err.detail || err.message}\n    ${herdrLine(rename)}`); }
  if (briefText !== null) {
    const send = ['agent', 'prompt', pane, briefText];
    try { await run('herdr', send); console.log(`  ● brief sent to ${pane}`); }
    catch (err) { throw new TargetError(`brief not delivered to ${pane} — ${err.detail || err.message}; read the pane before re-sending\n  herdr pane read ${shq(pane)} --source visible --lines 20`, 'herdr'); }
  }
  console.log(`  bring it up: maw herdr a ${shq(pane)}`);
  return { space, pane, name, briefed: briefText !== null };
}
