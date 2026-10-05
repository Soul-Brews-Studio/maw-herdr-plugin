#!/usr/bin/env bun
// maw herdr wt (#106) through the actual CLI process. FAKE herdr, maw and gh lead PATH and record
// every call in one ordered log; git is real, on throwaway repos with a bare origin. HOME is temporary;
// no live herdr session is touched. The fake `herdr worktree create` runs the real `git worktree add`,
// as herdr does. --dry must run nothing but reads.
// Run: bun utils/smoke-wt.mjs (MAW_WT_ENTRY=<bundle> for the bundle).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(process.env.MAW_WT_ENTRY || join(root, 'index.mjs'));
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'maw-herdr-wt-')));
const bin = join(temporary, 'bin'), home = join(temporary, 'home'), log = join(temporary, 'calls.jsonl'), state = join(temporary, 'dest.txt');
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const reset = () => { rmSync(log, { force: true }); rmSync(state, { force: true }); };
const tools = (tool) => calls().filter(c => c.tool === tool).map(c => c.argv);
const at = (pred) => calls().findIndex(pred);

try {
  mkdirSync(bin); mkdirSync(home);
  const fake = (name, body) => writeFileSync(join(bin, name), `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: ${JSON.stringify(name)}, argv, cwd: process.cwd(), envrc: existsSync('.envrc') }) + '\\n');
const say = (v) => { process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); };
const fail = (code, message) => { process.stderr.write(JSON.stringify({ error: { code, message } }) + '\\n'); process.exit(1); };
${body}
process.exit(97);
`, { mode: 0o755 });
  fake('herdr', `
const a = argv;
const e = process.env;
if (a[0] === 'worktree' && a[1] === 'create') {
  const f = (k) => a[a.indexOf(k) + 1];
  execFileSync('git', ['-C', f('--cwd'), 'worktree', 'add', '-q', '-b', f('--branch'), f('--path'), f('--base')]);
  writeFileSync(${JSON.stringify(state)}, f('--path'));
  say({ result: { workspace: { workspace_id: 'wT' }, ...(e.FAKE_ROOT_PANE ? { root_pane: { pane_id: 'wR:p1' } } : {}) } });
}
if (a[0] === 'pane' && a[1] === 'list') say({ result: { panes: existsSync(${JSON.stringify(state)}) ? [{ pane_id: 'wT:p1', cwd: readFileSync(${JSON.stringify(state)}, 'utf8') }] : [] } });
if (a[0] === 'pane' && a[1] === 'run') say('');
if (a[0] === 'pane' && a[1] === 'wait-output') { if (e.FAKE_WAIT === 'fail') fail('timeout', 'no match'); say(''); }
if (a[0] === 'pane' && a[1] === 'read') say(e.FAKE_HOOKS ? 'Hooks need review' : 'Ask Codex to do anything');
if (a[0] === 'agent' && a[1] === 'rename') { if (e.FAKE_RENAME === 'fail') fail('agent_not_found', 'no agent'); say(''); }
if (a[0] === 'agent' && a[1] === 'prompt') say('');
`);
  fake('maw', `
if (argv[0] === 'token' && argv[1] === 'resolve') { if (process.env.FAKE_NO_TOKEN) { process.stderr.write('no token assignment found\\n'); process.exit(1); } say('dd2\\n'); }
if (argv[0] === 'token' && argv[1] === 'use') say('');
`);
  fake('gh', `
if (argv[0] === 'repo' && argv[1] === 'view') say('acme/widget-oracle\\n');
if (argv[0] === 'issue' && argv[1] === 'comment') say('');
`);
  const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const env = { PATH: `${bin}:${dirname(gitBin)}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), TMPDIR: temporary };
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', '-C', cwd, ...args], { env, encoding: 'utf8' }).trim();

  // a repo whose main checkout sits on a feature branch: origin/main and HEAD differ
  const bare = join(temporary, 'origin.git'), widget = join(temporary, 'acme', 'widget-oracle');
  mkdirSync(join(temporary, 'acme'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env });
  execFileSync('git', ['clone', '-q', bare, widget], { env, stdio: 'ignore' });
  mkdirSync(join(widget, 'ψ'));
  writeFileSync(join(widget, 'ψ', 'README.md'), 'vault\n');
  writeFileSync(join(widget, '.gitignore'), 'wt/\nψ/lab/*\n');
  git(widget, 'checkout', '-q', '-b', 'main'); git(widget, 'add', '-A'); git(widget, 'commit', '-q', '-m', 'init'); git(widget, 'push', '-q', 'origin', 'main');
  git(widget, 'remote', 'set-head', 'origin', 'main');
  writeFileSync(join(widget, '.envrc'), 'export CLAUDE_TOKEN_NAME=pb\n');
  git(widget, 'checkout', '-q', '-b', 'feature/someone-elses'); git(widget, 'commit', '-q', '--allow-empty', '-m', 'wip');
  const mainSha = git(widget, 'rev-parse', 'origin/main'), headSha = git(widget, 'rev-parse', 'HEAD');
  ok(mainSha !== headSha, 'fixture: HEAD is not origin/main');
  const day = execFileSync('date', ['+%-d%b-%a%Y'], { env: { ...env, TZ: 'Asia/Bangkok' }, encoding: 'utf8' }).trim().toLowerCase();
  const run = (args, extra = {}, cwd = widget) => spawnSync(process.execPath, [entry, 'wt', ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000 });
  const dest = (slug, issue) => join(widget, 'wt', `${slug}-widget${issue ? `-issue${issue}` : ''}-${day}`);

  // A — --dry prints the whole sequence with real paths and runs only reads
  reset();
  let r = run(['herdr-demo', '--dry']);
  eq(r.status, 0, `A exit: ${r.stderr}`);
  const A = dest('herdr-demo');
  for (const needle of [`worktree create --cwd ${widget} --branch herdr-demo-widget-${day} --base origin/main --path ${A} --no-focus`,
    'worktree lock --reason', `herdr|`, '|herdr-demo', `maw token use dd2`, `pane run <pane> 'echo "TOK=$CLAUDE_TOKEN_NAME"'`, 'pane run <pane> claude',
    "pane wait-output <pane> --match 'bypass permissions' --timeout 40000", 'agent rename <pane> herdr-demo-widget', 'copy .envrc', 'ψ/lab/herdr-demo', 'fetch origin']) {
    ok(r.stdout.includes(needle), `A plan has ${needle}: ${r.stdout}`);
  }
  const order = ['worktree create', 'worktree lock', 'maw token use', 'echo "TOK=', 'pane run <pane> claude', 'pane wait-output', 'agent rename'].map(n => r.stdout.indexOf(n));
  ok(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), `A plan order create → lock → token → warm-up → engine → wait → rename: ${order}`);
  eq(calls().filter(c => c.tool === 'herdr').length, 0, 'A --dry never calls herdr');
  eq(tools('maw'), [['token', 'resolve']], 'A --dry only reads the token assignment');
  ok(!existsSync(join(widget, 'wt')), 'A --dry creates nothing');

  // B — for real: argv, base, lock, order, env, lab
  reset();
  r = run(['herdr-demo']);
  eq(r.status, 0, `B exit: ${r.stderr}`);
  const B = dest('herdr-demo');
  eq(tools('herdr')[0], ['worktree', 'create', '--cwd', widget, '--branch', `herdr-demo-widget-${day}`, '--base', 'origin/main', '--path', B, '--no-focus'], 'B worktree create argv');
  eq(git(B, 'rev-parse', 'HEAD'), mainSha, 'B branched from origin/main, not the main checkout\'s HEAD');
  ok(git(widget, 'branch', '--show-current') === 'feature/someone-elses', 'B left the main checkout alone');
  const locked = git(widget, 'worktree', 'list', '--porcelain', '-z').replaceAll('\0', '\n');
  const reason = locked.split('\n').find(l => l.startsWith('locked '))?.slice(7);
  ok(/^herdr\|[^|@]+@[^|]+\|\d{4}-\d\d-\d\dT[^|]+\|herdr-demo$/.test(reason ?? ''), `B lock reason herdr|who@host|iso|slug: ${reason}`);
  ok(existsSync(join(B, '.envrc')), 'B copied .envrc into the worktree');
  const use = calls().find(c => c.tool === 'maw' && c.argv[1] === 'use');
  ok(use && use.argv[2] === 'dd2' && use.cwd === B && use.envrc, `B maw token use dd2 ran in the worktree after .envrc was copied: ${JSON.stringify(use)}`);
  ok(existsSync(join(B, 'ψ', 'lab', 'herdr-demo')), 'B made ψ/lab/<slug>');
  eq(spawnSync('git', ['-C', B, 'check-ignore', '-q', 'ψ/lab/herdr-demo/x'], { env }).status, 1, 'B the lab folder is re-included in .gitignore');
  const iHerdr = (sub) => at(c => c.tool === 'herdr' && c.argv.slice(0, 2).join(' ') === sub);
  const iUse = at(c => c.tool === 'maw' && c.argv[1] === 'use');
  const iWarm = at(c => c.tool === 'herdr' && c.argv[1] === 'run' && c.argv[3].includes('TOK='));
  const iEngine = at(c => c.tool === 'herdr' && c.argv[1] === 'run' && c.argv[3] === 'claude');
  const iWait = iHerdr('pane wait-output'), iRename = iHerdr('agent rename');
  ok(iHerdr('worktree create') < iUse && iUse < iWarm && iWarm < iEngine && iEngine < iWait && iWait < iRename, `B order create < token < warm-up < engine < wait < rename: ${[iUse, iWarm, iEngine, iWait, iRename]}`);
  eq(calls()[iWait].argv, ['pane', 'wait-output', 'wT:p1', '--match', 'bypass permissions', '--timeout', '40000'], 'B wait is in milliseconds');
  eq(calls()[iRename].argv, ['agent', 'rename', 'wT:p1', 'herdr-demo-widget'], 'B rename by pane id, <slug>-<owner>');
  ok(!tools('herdr').some(a => a[0] === 'agent' && a[1] === 'start'), 'B never uses herdr agent start');
  ok(!tools('herdr').some(a => a[1] === 'prompt'), 'B no --issue, no --brief: nothing sent');

  // C — --issue N: -issueN- in the name, |#N in the lock, comment, brief by pane id
  reset();
  r = run(['linked', '--issue', '106']);
  eq(r.status, 0, `C exit: ${r.stderr}`);
  const C = dest('linked', '106');
  ok(existsSync(C), `C name carries -issue106-: ${r.stdout}`);
  const lockedC = git(widget, 'worktree', 'list', '--porcelain', '-z').replaceAll('\0', '\n').split('\n').filter(l => l.startsWith('locked ')).find(l => l.endsWith('|linked|#106'));
  ok(lockedC, 'C lock reason ends |slug|#106');
  const comment = tools('gh').find(a => a[0] === 'issue' && a[1] === 'comment');
  ok(comment && comment[2] === '106' && comment.includes('acme/widget-oracle') && comment.at(-1).includes(`branch: \`linked-widget-issue106-${day}\``) && comment.at(-1).includes('herdr space: `wT` · pane: `wT:p1`'), `C commented the workspace: ${JSON.stringify(comment)}`);
  const prompt = tools('herdr').find(a => a[0] === 'agent' && a[1] === 'prompt');
  ok(prompt && prompt[2] === 'wT:p1' && prompt[3].split('\n').length === 5 && prompt[3].includes('#106') && prompt[3].includes('gh issue view 106 --repo acme/widget-oracle --comments'), `C 5-line brief sent to the pane id: ${JSON.stringify(prompt)}`);
  ok(at(c => c.tool === 'herdr' && c.argv[1] === 'prompt') > iHerdr('agent rename') || at(c => c.tool === 'herdr' && c.argv[1] === 'prompt') > at(c => c.tool === 'herdr' && c.argv[1] === 'wait-output'), 'C the brief comes after the wait');

  // D — agent name: <slug>-<owner> is 33 chars → fall back to <slug>; 32 stays whole
  reset();
  const slug26 = 'a'.repeat(26), slug25 = 'b'.repeat(25);
  r = run([slug26]);
  eq(r.status, 0, `D exit: ${r.stderr}`);
  eq(tools('herdr').find(a => a[1] === 'rename'), ['agent', 'rename', 'wT:p1', slug26], 'D 33 chars falls back to the slug');
  reset();
  r = run([slug25]);
  eq(tools('herdr').find(a => a[1] === 'rename'), ['agent', 'rename', 'wT:p1', `${slug25}-widget`], 'D 32 chars keeps <slug>-<owner>');

  // E — engines and their waits; the create answer's root pane wins over pane list
  reset();
  r = run(['eng-codex', '--engine', 'codex'], { FAKE_ROOT_PANE: '1' });
  eq(r.status, 0, `E exit: ${r.stderr}`);
  ok(tools('herdr').some(a => a[1] === 'run' && a[2] === 'wR:p1' && a[3] === 'codex --dangerously-bypass-approvals-and-sandbox'), 'E codex command on the root pane from the create answer');
  ok(tools('herdr').some(a => a[1] === 'wait-output' && a.includes('--regex') && a.includes('150000') && a.includes('visible')), 'E codex waits for its prompt on the visible screen');
  reset();
  r = run(['eng-omx', '--engine', 'omx']);
  ok(r.status === 0 && tools('herdr').some(a => a[1] === 'run' && a[3] === 'OMX_AUTO_UPDATE=0 omx --direct --madmax'), `E omx command: ${r.stderr}`);

  // F — a startup question is reported, never answered: no rename, no brief; exit 0
  reset();
  r = run(['blocked', '--issue', '9'], { FAKE_WAIT: 'fail' });
  eq(r.status, 0, `F exit: ${r.stderr}`);
  ok(r.stdout.includes('waiting at a startup question') && r.stdout.includes('maw herdr a wT:p1') && r.stdout.includes('brief held back'), `F says where to answer: ${r.stdout}`);
  ok(!tools('herdr').some(a => a[1] === 'rename' || a[1] === 'prompt'), 'F sends nothing, names nothing');
  reset();
  r = run(['hooks', '--engine', 'omx'], { FAKE_HOOKS: '1' });
  ok(r.status === 0 && r.stdout.includes('hooks trust gate') && !tools('herdr').some(a => a[1] === 'rename'), `F2 omx hooks gate reported: ${r.stdout}${r.stderr}`);

  // G — no token assignment is a note, not a failure; rename failing is a warning with the command
  reset();
  r = run(['no-token'], { FAKE_NO_TOKEN: '1' });
  ok(r.status === 0 && r.stdout.includes('no assignment') && !tools('maw').some(a => a[1] === 'use'), `G no token: ${r.stdout}${r.stderr}`);
  reset();
  r = run(['no-name', '--brief', 'read the plan'], { FAKE_RENAME: 'fail' });
  ok(r.status === 0 && r.stdout.includes('could not name the agent') && r.stdout.includes('herdr agent rename wT:p1 no-name-widget'), `G rename warning ends in the command: ${r.stdout}${r.stderr}`);
  eq(tools('herdr').find(a => a[1] === 'prompt'), ['agent', 'prompt', 'wT:p1', 'read the plan'], 'G --brief alone sends exactly that text by pane id');

  // H — --base wins; --repo from elsewhere; inside a linked worktree the main repo is used
  reset();
  r = run(['based', '--base', 'HEAD', '--repo', widget], {}, temporary);
  eq(r.status, 0, `H exit: ${r.stderr}`);
  eq(git(dest('based'), 'rev-parse', 'HEAD'), headSha, 'H --base HEAD branches from HEAD');
  reset();
  r = run(['inside', '--dry'], {}, B);
  ok(r.status === 0 && r.stdout.includes(`--cwd ${widget} `) && r.stdout.includes(`--path ${dest('inside')}`), `H from inside a worktree the main repo is used: ${r.stdout}${r.stderr}`);

  // I — refusals end in a command; exit codes: usage 2, refusal 1
  for (const [args, needle] of [[[], 'wt needs a slug'], [['Bad Slug'], 'must be lowercase'], [['x', '--issue', 'abc'], '--issue needs an issue number'],
    [['x', '--engine', 'vim'], '--engine must be one of'], [['x', '--bogus'], 'unknown argument'], [['x', '--base'], '--base needs a value'], [['x', 'y'], 'one slug only']]) {
    r = run(args);
    ok(r.status === 2 && r.stderr.includes(needle) && r.stderr.trim().split('\n').length >= 2, `I ${JSON.stringify(args)} → 2 with a fix line: ${r.status} ${r.stderr}`);
  }
  reset();
  r = run(['herdr-demo']);
  ok(r.status === 1 && r.stderr.includes('already exists') && r.stderr.includes('maw herdr wt herdr-demo-2'), `I existing worktree refused with a fix: ${r.stderr}`);
  eq(calls().filter(c => c.tool === 'herdr').length, 0, 'I a refusal calls no herdr');
  const lone = join(temporary, 'lone'); mkdirSync(lone); git(lone, 'init', '-q', '-b', 'main'); git(lone, 'commit', '-q', '--allow-empty', '-m', 'x');
  r = run(['solo'], {}, lone);
  ok(r.status === 1 && r.stderr.includes('git fetch origin failed') && r.stderr.includes('--base HEAD'), `I no origin: refuses, names --base: ${r.stderr}`);
  r = run(['x'], {}, temporary);
  ok(r.status === 1 && r.stderr.includes('not inside a git checkout') && r.stderr.includes('rev-parse --show-toplevel'), `I outside a repo: ${r.stderr}`);

  // J — help
  for (const flag of ['--help', '-h']) {
    reset();
    r = run([flag]);
    ok(r.status === 0 && r.stdout.includes('wt <slug>') && calls().length === 0, `J wt ${flag} prints usage and runs nothing`);
  }

  console.log(`ok: maw herdr wt — ${checks} checks (${entry === join(root, 'index.mjs') ? 'source' : 'bundle'})`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
