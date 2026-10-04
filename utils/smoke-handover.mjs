#!/usr/bin/env bun
// maw herdr handover (#106) through the actual CLI process. FAKE herdr, maw and gh lead PATH and record
// every call in one ordered log; git is real, on throwaway repos. HOME is temporary; no live herdr session
// is touched. A clean space with an idle agent is closed AFTER the new agent is briefed; a dirty, busy or
// unbriefed one is left open with the reason and the command that would close it. --dry runs only reads.
// Run: bun utils/smoke-handover.mjs (MAW_HANDOVER_ENTRY=<bundle> for the bundle).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(process.env.MAW_HANDOVER_ENTRY || join(root, 'index.mjs'));
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'maw-herdr-handover-')));
const bin = join(temporary, 'bin'), home = join(temporary, 'home'), log = join(temporary, 'calls.jsonl'), state = join(temporary, 'dest.txt');
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const reset = () => { rmSync(log, { force: true }); rmSync(state, { force: true }); };
const herdrCalls = () => calls().filter(c => c.tool === 'herdr').map(c => c.argv);
const has = (pred) => herdrCalls().findIndex(pred);

try {
  mkdirSync(bin); mkdirSync(home);
  const fake = (name, body) => writeFileSync(join(bin, name), `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: ${JSON.stringify(name)}, argv, cwd: process.cwd() }) + '\\n');
const say = (v) => { process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); };
const fail = (code, message) => { process.stderr.write(JSON.stringify({ error: { code, message } }) + '\\n'); process.exit(1); };
const e = process.env;
${body}
process.exit(97);
`, { mode: 0o755 });
  fake('herdr', `
const a = argv;
if (a[0] === 'workspace' && a[1] === 'list') say({ result: { workspaces: JSON.parse(e.FAKE_SPACES || '[]') } });
if (a[0] === 'workspace' && a[1] === 'close') say('');
if (a[0] === 'worktree' && a[1] === 'create') {
  const f = (k) => a[a.indexOf(k) + 1];
  execFileSync('git', ['-C', f('--cwd'), 'worktree', 'add', '-q', '-b', f('--branch'), f('--path'), f('--base')]);
  writeFileSync(${JSON.stringify(state)}, f('--path'));
  say({ result: { workspace: { workspace_id: 'wN' } } });
}
if (a[0] === 'pane' && a[1] === 'list') {
  const made = existsSync(${JSON.stringify(state)}) ? [{ pane_id: 'wN:p1', workspace_id: 'wN', cwd: readFileSync(${JSON.stringify(state)}, 'utf8') }] : [];
  say({ result: { panes: [...JSON.parse(e.FAKE_PANES || '[]'), ...made] } });
}
if (a[0] === 'pane' && a[1] === 'run') say('');
if (a[0] === 'pane' && a[1] === 'wait-output') { if (e.FAKE_WAIT === 'fail') fail('timeout', 'no match'); say(''); }
if (a[0] === 'agent' && (a[1] === 'rename' || a[1] === 'prompt')) say('');
`);
  fake('maw', `
if (argv[0] === 'locate') {
  if (argv[1] === 'nobody') { process.stderr.write('not found\\n'); process.exit(1); }
  say({ name: argv[1], org: 'acme', repo: argv[1] + '-oracle', ...(argv[1] === 'remote-only' ? {} : { local_path: e.FAKE_ORACLE_PATH }) });
}
if (argv[0] === 'token' && argv[1] === 'resolve') say('dd2\\n');
if (argv[0] === 'token' && argv[1] === 'use') say('');
`);
  fake('gh', `
if (argv[0] === 'repo' && argv[1] === 'view') say('acme/scribe-oracle\\n');
if (argv[0] === 'issue' && argv[1] === 'comment') say('');
`);
  const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const env = { PATH: `${bin}:${dirname(gitBin)}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), TMPDIR: temporary };
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', '-C', cwd, ...args], { env, encoding: 'utf8' }).trim();

  // the oracle's repo, with a bare origin; and the source checkout the space shows (a plain clone, github origin)
  const bare = join(temporary, 'origin.git'), scribe = join(temporary, 'acme', 'scribe-oracle'), lib = join(temporary, 'acme', 'source-lib');
  mkdirSync(join(temporary, 'acme'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env });
  execFileSync('git', ['clone', '-q', bare, scribe], { env, stdio: 'ignore' });
  git(scribe, 'checkout', '-q', '-b', 'main'); git(scribe, 'commit', '-q', '--allow-empty', '-m', 'init'); git(scribe, 'push', '-q', 'origin', 'main'); git(scribe, 'remote', 'set-head', 'origin', 'main');
  mkdirSync(lib); git(lib, 'init', '-q', '-b', 'topic'); git(lib, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(lib, 'remote', 'add', 'origin', 'git@github.com:acme/source-lib.git');
  const space = (id, label, path = lib) => ({ workspace_id: id, label, worktree: { checkout_path: path } });
  const spaces = JSON.stringify([space('wS', 'source-lib'), space('wT', 'source-lib-fix'), space('wU', 'other')]);
  const idle = JSON.stringify([{ pane_id: 'wS:p1', workspace_id: 'wS', cwd: lib, agent: 'claude', agent_status: 'idle' }, { pane_id: 'wS:p2', workspace_id: 'wS', cwd: lib, agent: null, agent_status: 'unknown' }]);
  const busy = JSON.stringify([{ pane_id: 'wS:p1', workspace_id: 'wS', cwd: lib, agent: 'claude', agent_status: 'working' }]);
  const day = execFileSync('date', ['+%-d%b-%a%Y'], { env: { ...env, TZ: 'Asia/Bangkok' }, encoding: 'utf8' }).trim().toLowerCase();
  const base = { FAKE_SPACES: spaces, FAKE_PANES: idle, FAKE_ORACLE_PATH: scribe };
  const run = (args, extra = {}) => spawnSync(process.execPath, [entry, 'handover', ...args], { cwd: temporary, env: { ...env, ...base, ...extra }, encoding: 'utf8', timeout: 30_000 });
  const dest = (issue) => join(scribe, 'wt', `source-lib-scribe${issue ? `-issue${issue}` : ''}-${day}`);

  // a real run leaves its worktree; drop it (unlock, remove, delete the branch) so the next case may reuse the name
  const drop = (issue) => { const d = dest(issue); git(scribe, 'worktree', 'unlock', d); git(scribe, 'worktree', 'remove', '--force', d); git(scribe, 'branch', '-D', `source-lib-scribe${issue ? `-issue${issue}` : ''}-${day}`); };

  // A — --dry: reads the space and the oracle, plans wt and the close, runs nothing that changes anything
  reset();
  let r = run(['source-lib', 'scribe', '--dry']);
  eq(r.status, 0, `A exit: ${r.stderr}`);
  ok(r.stdout.includes('wS source-lib: acme/source-lib @ topic — clean, agent idle'), `A reads the space: ${r.stdout}`);
  ok(r.stdout.includes(`→ scribe (acme/scribe-oracle) at ${scribe}`), 'A resolves the oracle with maw locate');
  ok(r.stdout.includes(`--base origin/main --path ${dest()}`) && r.stdout.includes('# then close wS: herdr workspace close wS'), `A plans wt and the close: ${r.stdout}`);
  eq([...new Set(herdrCalls().map(a => a.slice(0, 2).join(' ')))].sort(), ['pane list', 'workspace list'], 'A --dry calls only workspace list and pane list');
  ok(!existsSync(join(scribe, 'wt')), 'A --dry creates nothing');

  // B — clean + idle: wt runs in the oracle's repo, the brief starts with the incubate step, THEN the old space closes
  reset();
  r = run(['wS', 'scribe']);
  eq(r.status, 0, `B exit: ${r.stderr}`);
  ok(existsSync(dest()), `B worktree made in the ORACLE's repo: ${r.stdout}`);
  const prompt = herdrCalls().find(a => a[0] === 'agent' && a[1] === 'prompt');
  ok(prompt && prompt[2] === 'wN:p1' && prompt[3].startsWith('First step: run `/incubate acme/source-lib --wt source-lib`'), `B brief's first step is /incubate <org>/<repo> --wt <slug>, sent by pane id: ${JSON.stringify(prompt)}`);
  ok(prompt[3].includes('space wS (source-lib, branch topic)'), 'B the brief names where it came from');
  const iPrompt = has(a => a[1] === 'prompt'), iClose = has(a => a[0] === 'workspace' && a[1] === 'close');
  ok(iClose > iPrompt && iPrompt > 0, `B the old space closes after the brief: prompt ${iPrompt}, close ${iClose}`);
  eq(herdrCalls()[iClose], ['workspace', 'close', 'wS'], 'B closes exactly the old space');
  ok(existsSync(lib), 'B the old folder stays');
  drop();

  // C — --issue N rides through wt: -issueN- in the name, the 5-line brief after the first step, comment posted
  reset();
  r = run(['source-lib', 'scribe', '--issue', '7']);
  eq(r.status, 0, `C exit: ${r.stderr}`);
  ok(existsSync(dest('7')), `C -issue7- in the worktree name: ${r.stdout}`);
  const p7 = herdrCalls().find(a => a[1] === 'prompt');
  ok(p7[3].split('\n').length === 6 && p7[3].includes('gh issue view 7 --repo acme/scribe-oracle --comments'), `C first step + the 5-line issue brief: ${p7[3]}`);
  ok(calls().some(c => c.tool === 'gh' && c.argv[1] === 'comment' && c.argv[2] === '7'), 'C the workspace is commented on the issue');
  drop('7');

  // D — dirty, busy, or not yet briefed: the old space stays open, with the reason and the close command
  writeFileSync(join(lib, 'wip.txt'), 'unsaved\n');
  reset();
  r = run(['source-lib', 'scribe']);
  eq(r.status, 0, `D exit: ${r.stderr}`);
  ok(r.stdout.includes('1 uncommitted') && r.stdout.includes('wS left open: its checkout has 1 uncommitted change') && r.stdout.includes('when it is safe: herdr workspace close wS'), `D dirty is left open with the command: ${r.stdout}`);
  ok(has(a => a[1] === 'prompt') > 0 && has(a => a[0] === 'workspace' && a[1] === 'close') === -1, 'D the new agent is still briefed; nothing is closed');
  drop();
  rmSync(join(lib, 'wip.txt'));
  reset();
  r = run(['source-lib', 'scribe'], { FAKE_PANES: busy });
  ok(r.status === 0 && r.stdout.includes('agent busy (wS:p1)') && r.stdout.includes('its agent is not idle (wS:p1 working)'), `D busy agent is left open: ${r.stdout}${r.stderr}`);
  ok(has(a => a[0] === 'workspace' && a[1] === 'close') === -1, 'D busy: nothing is closed');
  drop();
  reset();
  r = run(['source-lib', 'scribe'], { FAKE_WAIT: 'fail' });
  ok(r.status === 0 && r.stdout.includes('waiting at a startup question') && r.stdout.includes('wS left open') && r.stdout.includes('not briefed yet'), `D unbriefed: ${r.stdout}${r.stderr}`);
  ok(has(a => a[0] === 'workspace' && a[1] === 'close') === -1, 'D unbriefed: nothing is closed');

  // E — resolution: unknown or ambiguous space, unknown oracle, no checkout, no origin — each ends in a command
  reset();
  r = run(['nosuch', 'scribe']);
  ok(r.status === 1 && r.stderr.includes("no herdr space 'nosuch'") && r.stderr.includes('herdr workspace list'), `E unknown space: ${r.stderr}`);
  r = run(['source', 'scribe']);
  ok(r.status === 1 && r.stderr.includes('names 2 spaces') && r.stderr.includes('maw herdr handover wS <oracle>') && r.stderr.includes('maw herdr handover wT <oracle>'), `E ambiguous space lists ids: ${r.stderr}`);
  r = run(['wS', 'nobody']);
  ok(r.status === 1 && r.stderr.includes("does not know an oracle 'nobody'") && r.stderr.includes('maw locate nobody'), `E unknown oracle: ${r.stderr}`);
  r = run(['wS', 'remote-only']);
  ok(r.status === 1 && r.stderr.includes('no checkout on this machine') && r.stderr.includes('ghq get github.com/acme/remote-only-oracle'), `E oracle not checked out: ${r.stderr}`);
  const bare2 = join(temporary, 'bare-dir'); mkdirSync(bare2); git(bare2, 'init', '-q', '-b', 'main');
  r = run(['wX', 'scribe'], { FAKE_SPACES: JSON.stringify([space('wX', 'noorigin', bare2)]) });
  ok(r.status === 1 && r.stderr.includes('no GitHub origin') && r.stderr.includes(`git -C ${bare2} remote -v`), `E no origin: ${r.stderr}`);
  eq(herdrCalls().filter(a => a[0] === 'worktree' || a[0] === 'workspace' && a[1] === 'close').length, 0, 'E refusals create and close nothing');

  // F — usage mistakes exit 2 with a fix line; help
  for (const [args, needle] of [[[], 'handover needs a space and an oracle'], [['wS'], 'handover needs a space and an oracle'], [['a', 'b', 'c'], 'extra'],
    [['wS', 'scribe', '--issue', 'x'], '--issue needs an issue number'], [['wS', 'scribe', '--engine', 'vim'], '--engine must be one of'], [['wS', 'scribe', '--bogus'], 'unknown argument']]) {
    r = run(args);
    ok(r.status === 2 && r.stderr.includes(needle) && r.stderr.trim().split('\n').length >= 2, `F ${JSON.stringify(args)} → 2 with a fix line: ${r.status} ${r.stderr}`);
  }
  for (const flag of ['--help', '-h']) {
    reset();
    r = run([flag]);
    ok(r.status === 0 && r.stdout.includes('handover <space> <oracle>') && calls().length === 0, `F handover ${flag} prints usage and runs nothing`);
  }

  console.log(`ok: maw herdr handover — ${checks} checks (${entry === join(root, 'index.mjs') ? 'source' : 'bundle'})`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
