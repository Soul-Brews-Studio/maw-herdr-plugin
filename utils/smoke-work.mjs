#!/usr/bin/env bun
// maw herdr work (#101) through the actual CLI process. FAKE herdr and ghq lead PATH and
// record every call; git is real, on throwaway repos under a temporary ghq root. HOME is
// temporary; no live herdr session is touched. --dry must run nothing but the two reads.
// Run: bun utils/smoke-work.mjs (MAW_WORK_ENTRY=<bundle> for the bundle).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(process.env.MAW_WORK_ENTRY || join(root, 'index.mjs'));
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'maw-herdr-work-')));
const bin = join(temporary, 'bin'), home = join(temporary, 'home'), ghq = join(temporary, 'ghq');
const herdrLog = join(temporary, 'herdr-calls.jsonl'), ghqLog = join(temporary, 'ghq-calls.jsonl');
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const calls = (log) => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const reset = () => { rmSync(herdrLog, { force: true }); rmSync(ghqLog, { force: true }); };

try {
  mkdirSync(bin); mkdirSync(home); mkdirSync(ghq);
  // herdr: the two reads answer; create/start/prompt answer like herdr does; anything else fails.
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(herdrLog)}, JSON.stringify(argv) + '\\n');
const a = argv[0] === '--session' ? argv.slice(2) : argv;
const say = (value) => { process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); process.exit(0); };
if (a[0] === 'session' && a[1] === 'list') say({ sessions: process.env.FAKE_NO_SESSION ? [{ name: 'default', running: false, default: true }] : [{ name: 'default', running: true, default: true }, { name: 'old', running: false }] });
if (a[0] === 'pane' && a[1] === 'list') say({ result: { panes: JSON.parse(process.env.FAKE_PANES || '[]') } });
if (a[0] === 'workspace' && a[1] === 'create') say({ result: { root_pane: { pane_id: 'wT:p1' } } });
if (a[0] === 'agent' && a[1] === 'start') say({ result: { agent: { agent_status: 'idle' } } });
if (a[0] === 'agent' && a[1] === 'prompt') say('');
process.exit(97);
`, { mode: 0o755 });
  // ghq: root and list answer from the temporary tree; get is recorded and fails (no network).
  writeFileSync(join(bin, 'ghq'), `#!${process.execPath}
import { appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(ghqLog)}, JSON.stringify(argv) + '\\n');
const root = ${JSON.stringify(ghq)};
if (argv[0] === 'root') { console.log(root); process.exit(0); }
if (argv[0] === 'list') {
  const host = join(root, 'github.com');
  for (const org of readdirSync(host)) for (const repo of readdirSync(join(host, org))) console.log(join(host, org, repo));
  process.exit(0);
}
process.exit(96);
`, { mode: 0o755 });
  const git = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const env = { PATH: `${bin}:${dirname(git)}`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), TMPDIR: temporary };
  const repo = (org, name) => {
    const path = join(ghq, 'github.com', org, name);
    mkdirSync(path, { recursive: true });
    const g = (...args) => execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', '-C', path, ...args], { env, stdio: 'ignore' });
    g('init', '-q', '-b', 'main'); g('commit', '-q', '--allow-empty', '-m', 'init');
    return path;
  };
  const widget = repo('acme', 'widget');
  repo('acme', 'solo');
  const run = (args, extra = {}) => spawnSync(process.execPath, [entry, 'work', ...args], { cwd: temporary, env: { ...env, ...extra }, encoding: 'utf8', timeout: 20_000 });
  const reads = [['session', 'list', '--json'], ['--session', 'default', 'pane', 'list']];

  // A — a path, the repo root: one space, one agent; --dry runs only the two reads
  reset();
  let r = run([widget, '--dry']);
  eq(r.status, 0, `A exit: ${r.stderr}`);
  ok(r.stdout.includes(`workspace create --cwd ${widget} --label widget --no-focus`), `A plans the space: ${r.stdout}`);
  ok(r.stdout.includes('agent start widget --kind claude'), 'A plans the agent');
  eq(calls(herdrLog), reads, 'A --dry calls only session list and pane list');
  ok(!existsSync(join(widget, 'agents')), 'A --dry creates no worktree folder');

  // B — org/repo and a task: the dashboard's worktree, planned not made
  reset();
  r = run(['acme/widget', 'Fix', 'the', 'Login', '--dry']);
  eq(r.status, 0, `B exit: ${r.stderr}`);
  ok(r.stdout.includes(`worktree add ${join(widget, 'agents', 'fix-the-login')} -b agents/fix-the-login`), `B plans agents/<slug>: ${r.stdout}`);
  ok(r.stdout.includes('--label widget-fix-the-login'), 'B labels the space <repo>-<slug>');
  eq(calls(herdrLog), [reads[0]], 'B --dry with a new worktree reads only the session list');
  ok(!existsSync(join(widget, 'agents')), 'B --dry creates no worktree');

  // C — an issue URL names the task and is the first prompt
  reset();
  r = run(['https://github.com/acme/widget/issues/12', '--dry']);
  eq(r.status, 0, `C exit: ${r.stderr}`);
  ok(r.stdout.includes('agents/issue-12') && r.stdout.includes('agent prompt widget-issue-12 https://github.com/acme/widget/issues/12'), `C issue → slug + prompt: ${r.stdout}`);

  // D, E — not cloned: the clone is planned (https as given, -p for ssh), never run under --dry
  reset();
  r = run(['https://github.com/acme/ghost', '--dry']);
  eq(r.status, 0, `D exit: ${r.stderr}`);
  ok(r.stdout.includes('ghq get github.com/acme/ghost'), `D plans ghq get: ${r.stdout}`);
  ok(!calls(ghqLog).some(argv => argv[0] === 'get'), 'D --dry never runs ghq get');
  r = run(['git@github.com:acme/ghost.git', '--dry']);
  ok(r.status === 0 && r.stdout.includes('ghq get -p github.com/acme/ghost'), `E ssh URL clones with -p: ${r.stdout}${r.stderr}`);

  // F — a space already on that folder is reused, never doubled
  reset();
  const panes = JSON.stringify([{ pane_id: 'wT:p9', cwd: widget }]);
  r = run([widget, '--dry'], { FAKE_PANES: panes });
  ok(r.status === 0 && r.stdout.includes('# already open: wT:p9'), `F --dry shows the open pane: ${r.stdout}`);
  reset();
  r = run([widget], { FAKE_PANES: panes });
  ok(r.status === 0 && r.stdout.includes('nothing started'), `F reuses: ${r.stdout}${r.stderr}`);
  ok(!calls(herdrLog).some(argv => argv.includes('workspace') || argv.includes('agent')), 'F starts nothing');

  // G — for real against the fake herdr: the worktree is made by git, then space and agent
  reset();
  r = run(['acme/widget', 'my', 'task']);
  eq(r.status, 0, `G exit: ${r.stderr}`);
  const wt = join(widget, 'agents', 'my-task');
  ok(existsSync(join(wt, '.git')), 'G git worktree add made agents/my-task');
  eq(execFileSync('git', ['-C', wt, 'branch', '--show-current'], { env, encoding: 'utf8' }).trim(), 'agents/my-task', 'G branch agents/my-task');
  const made = calls(herdrLog);
  ok(made.some(argv => argv.join(' ') === `--session default workspace create --cwd ${wt} --label widget-my-task --no-focus`), `G workspace create argv: ${JSON.stringify(made)}`);
  ok(made.some(argv => argv.join(' ') === '--session default agent start widget-my-task --kind claude --pane wT:p1'), 'G agent start argv');
  ok(r.stdout.includes('bring it up: maw herdr a widget-my-task'), 'G ends with the command that brings it up');
  // the same task again reuses the worktree instead of numbering a second one
  reset();
  r = run(['acme/widget', 'my', 'task', '--dry']);
  ok(r.status === 0 && r.stdout.includes(`# reuse worktree ${wt}`), `G2 reuses the worktree: ${r.stdout}${r.stderr}`);

  // H — --prompt and --engine override; I — a clone that fails says how to clone instead
  reset();
  r = run(['https://github.com/acme/solo/pull/7', '--prompt', 'review it', '-e', 'codex']);
  eq(r.status, 0, `H exit: ${r.stderr}`);
  ok(calls(herdrLog).some(argv => argv.join(' ') === '--session default agent prompt solo-pr-7 review it'), 'H --prompt replaces the URL');
  ok(calls(herdrLog).some(argv => argv.includes('--kind') && argv.includes('codex')), 'H -e codex');
  reset();
  r = run(['https://github.com/acme/ghost']);
  ok(r.status === 1 && r.stderr.includes('gh repo clone acme/ghost'), `I clone failure ends with a fix: ${r.stderr}`);

  // J — a bare name: unique resolves, shared lists the choices, unknown says how to name it
  repo('beta', 'widget');
  r = run(['solo', '--dry']);
  ok(r.status === 0 && r.stdout.includes('solo →'), `J unique bare name resolves: ${r.stderr}`);
  r = run(['widget', '--dry']);
  ok(r.status === 1 && r.stderr.includes('acme/widget') && r.stderr.includes('beta/widget'), `J ambiguous lists both: ${r.stderr}`);
  r = run(['nosuch', '--dry']);
  ok(r.status === 1 && r.stderr.includes('maw herdr work <org>/nosuch'), `J unknown ends with a fix: ${r.stderr}`);

  // K — usage mistakes exit 2 with a fix line; L — no running session exits 1
  for (const [args, needle] of [[[], 'work needs a repo'], [['acme/widget', 'a task', '--wt', 'x'], 'not both'],
    [['acme/widget', '--engine'], '--engine needs a value'], [['https://gitlab.com/x/y'], 'not a path'], [['acme/solo', '--wt', '--dry'], '--wt needs a slug'], [['acme/solo', '--bogus'], 'unknown argument']]) {
    r = run(args);
    ok(r.status === 2 && r.stderr.includes(needle) && r.stderr.trim().split('\n').length >= 2, `K ${JSON.stringify(args)} → 2 with a fix line: ${r.status} ${r.stderr}`);
  }
  r = run(['acme/solo', '--dry'], { FAKE_NO_SESSION: '1' });
  ok(r.status === 1 && r.stderr.includes('no herdr session is running'), `L no session: ${r.stderr}`);

  console.log(`ok: maw herdr work — ${checks} checks (${entry === join(root, 'index.mjs') ? 'source' : 'bundle'})`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
