#!/usr/bin/env node
// `maw herdr clean` / `sync` (#64): the safety floor, case by case, against the
// actual CLI process. Each case below was a way to delete a folder someone was
// working in, or to act on a picture that was not the one shown:
//
//   plain-agent     an agent in a PLAIN space (`workspace create --cwd` binds no
//                   repo) sitting in a merged worktree — kept
//   foreign-agent   an agent whose pane cd'd into a merged worktree from a space
//                   bound to ANOTHER checkout — kept
//   plain-shell     a bare shell in a plain space — kept; with --idle-shells the
//                   plain space is closed BEFORE git removes the folder, and herdr
//                   and git agree afterwards
//   caller-wt / pane-caller   the checkout this command runs in, by cwd and by
//                   HERDR_PANE_ID — kept
//   locked-merged / locked-gone   git-locked — kept
//   envrc-*         an .envrc (the fleet keeps its operator token there) is data,
//                   untracked or gitignored — kept
//   nested-db       data/target/labels.db is data, not a Rust target dir — kept;
//                   root-build (build/ at the root, a self-ignoring .pytest_cache)
//                   is rebuildable — removed
//   idle-codex      an idle codex beside only a claude transcript — not idle
//   idle-two        herdr's agent_session names the agent's own transcript;
//                   resume opens THAT one, not the newest in the folder
//   idle-lost       herdr names a session with no transcript — not idle
//   snapshot fails ONCE, or answers only after loadTargets' timeout — clean
//                   --go refuses (the guard reads the same load the plan used)
//   --pick q        one prompt, then nothing more is asked
//   --pick, and a space opens on the worktree while the prompt waits — the
//                   re-planned steps differ from the approved ones: SKIP
//   --session with no target — exit 2 with runnable commands, not a silent no-op
//   herdr `worktree remove` fails — the fix lines are other commands, not a rerun
//
// Collects every failure before exiting, so running it against the pre-fix code
// (MAW_CLEANUP_ENTRY=<old checkout>/index.mjs) lists every defect at once.
// Nothing can reach the live herdr: PATH is a fake herdr and git alone, HOME and
// GHQ_ROOT are temp.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(process.env.MAW_CLEANUP_ENTRY || join(root, 'index.mjs'));
const bun = process.versions.bun ? process.execPath : spawnSync('bun', ['-e', 'console.log(process.execPath)'], { encoding: 'utf8' }).stdout.trim();
assert.ok(bun && existsSync(bun), 'bun is required: curl -fsSL https://bun.sh/install | bash');
const gitBin = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
assert.ok(gitBin, 'git is required: xcode-select --install   (or: sudo apt-get install -y git)');

const T = realpathSync(mkdtempSync(join(tmpdir(), 'maw-herdr-safety-')));
const bin = join(T, 'bin');
const log = join(T, 'calls.jsonl');
const home = join(T, 'home');
mkdirSync(bin);
mkdirSync(home);
symlinkSync(gitBin, join(bin, 'git'));

const OLD = `${Math.floor(Date.now() / 1000) - 10 * 86_400} +0000`;
const gitEnv = { ...process.env, GIT_AUTHOR_DATE: OLD, GIT_COMMITTER_DATE: OLD };
for (const k of Object.keys(gitEnv)) if (k.startsWith('GIT_') && !k.endsWith('_DATE')) delete gitEnv[k];
const git = (cwd, ...args) => execFileSync(gitBin, ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', '-c', 'init.defaultBranch=main', '-C', cwd, ...args], { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] });

const origin = join(T, 'origin.git');
git(T, 'init', '-q', '--bare', origin);
const seed = join(T, 'seed');
git(T, 'clone', '-q', origin, seed);
writeFileSync(join(seed, 'README'), 'alpha\n');
writeFileSync(join(seed, '.gitignore'), '.data/\nnode_modules/\n*.db\nbuild/\nsub/.envrc\n');
mkdirSync(join(seed, 'data'));
writeFileSync(join(seed, 'data', 'keep.txt'), 'k\n');
mkdirSync(join(seed, 'sub'));
writeFileSync(join(seed, 'sub', 'keep.txt'), 'k\n');
git(seed, 'add', '.');
git(seed, 'commit', '-q', '-m', 'init');
git(seed, 'push', '-q', 'origin', 'main');

const ghq = join(T, 'code');
const repo = join(ghq, 'github.com', 'org', 'alpha');
mkdirSync(dirname(repo), { recursive: true });
git(T, 'clone', '-q', origin, repo);
const wt = name => join(repo, 'wt', name);
const NAMES = ['plain-agent', 'foreign-agent', 'plain-shell', 'bound-shell', 'caller-wt', 'pane-caller', 'locked-merged', 'locked-gone',
  'envrc-untracked', 'envrc-ignored', 'nested-db', 'root-build', 'idle-codex', 'idle-two', 'idle-lost'];
for (const n of NAMES) git(repo, 'worktree', 'add', '-q', '-b', `b/${n}`, wt(n));
git(repo, 'worktree', 'lock', wt('locked-merged'));
git(repo, 'worktree', 'lock', wt('locked-gone'));
rmSync(wt('locked-gone'), { recursive: true, force: true });
writeFileSync(join(wt('envrc-untracked'), '.envrc'), 'export NOT_A_REAL_TOKEN=1\n');
writeFileSync(join(wt('envrc-ignored'), 'sub', '.envrc'), 'export NOT_A_REAL_TOKEN=1\n');
mkdirSync(join(wt('nested-db'), 'data', 'target'), { recursive: true });
writeFileSync(join(wt('nested-db'), 'data', 'target', 'labels.db'), 'labels');
mkdirSync(join(wt('root-build'), 'build'));
writeFileSync(join(wt('root-build'), 'build', 'out.js'), 'built\n');
// pytest's cache ignores itself, so git lists the files inside it one by one
mkdirSync(join(wt('root-build'), 'app', '.pytest_cache', 'v', 'cache'), { recursive: true });
writeFileSync(join(wt('root-build'), 'app', '.pytest_cache', '.gitignore'), '*\n');
writeFileSync(join(wt('root-build'), 'app', '.pytest_cache', 'README.md'), 'cache\n');
writeFileSync(join(wt('root-build'), 'app', '.pytest_cache', 'v', 'cache', 'nodeids'), '[]\n');

// transcripts
const claudeRoot = join(T, 'claude-projects');
const codexRoot = join(T, 'codex-sessions');
mkdirSync(codexRoot);
const enc = p => p.replace(/[^a-zA-Z0-9]/g, '-');
const transcript = (path, id, ageMs) => {
  const dir = join(claudeRoot, enc(path));
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${id}.jsonl`);
  writeFileSync(f, `{"type":"user","message":"${'x'.repeat(2048)}"}\n`);
  const t = new Date(Date.now() - ageMs);
  utimesSync(f, t, t);
};
const DAY = 86_400_000;
const OWN = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
const LOST = 'cccccccc-0000-4000-8000-000000000003';
const STRAY = 'dddddddd-0000-4000-8000-000000000004';
transcript(wt('idle-codex'), 'eeeeeeee-0000-4000-8000-000000000005', 3 * DAY);   // claude's, not the codex's
transcript(wt('idle-two'), OWN, 3 * DAY);
transcript(wt('idle-two'), OTHER, 2 * DAY);   // newer, and someone else's
transcript(wt('idle-lost'), STRAY, 3 * DAY);

// the fake herdr
const tree = (checkout, linked = true) => ({ repo_name: 'alpha', repo_key: join(repo, '.git'), repo_root: repo, checkout_path: checkout, is_linked_worktree: linked });
const session = (agent, id) => ({ agent, kind: 'id', source: `herdr:${agent}`, value: id });
const snapshotFile = join(T, 'snapshot.json');
const counter = join(T, 'snapshots.count');
writeFileSync(snapshotFile, JSON.stringify({
  workspaces: [
    { workspace_id: 'wP', label: 'plain agent', agent_status: 'working' },
    { workspace_id: 'wF', label: 'alpha main', agent_status: 'idle', worktree: tree(repo, false) },
    { workspace_id: 'wS', label: 'plain shell', agent_status: 'unknown' },
    { workspace_id: 'wB', label: 'bound-shell', agent_status: 'unknown', worktree: tree(wt('bound-shell')) },
    { workspace_id: 'wC', label: 'pane-caller', agent_status: 'unknown', worktree: tree(wt('pane-caller')) },
    { workspace_id: 'wX', label: 'idle-codex', agent_status: 'idle', worktree: tree(wt('idle-codex')) },
    { workspace_id: 'wY', label: 'idle-two', agent_status: 'idle', worktree: tree(wt('idle-two')) },
    { workspace_id: 'wZ', label: 'idle-lost', agent_status: 'idle', worktree: tree(wt('idle-lost')) },
  ],
  panes: [
    { pane_id: 'wP:p1', workspace_id: 'wP', agent: 'omp', agent_status: 'working', cwd: wt('plain-agent') },
    { pane_id: 'wF:p1', workspace_id: 'wF', agent: null, cwd: repo },
    { pane_id: 'wF:p2', workspace_id: 'wF', agent: 'claude', agent_status: 'idle', cwd: wt('foreign-agent') },
    { pane_id: 'wS:p1', workspace_id: 'wS', agent: null, cwd: wt('plain-shell') },
    { pane_id: 'wB:p1', workspace_id: 'wB', agent: null, cwd: wt('bound-shell') },
    { pane_id: 'wC:p1', workspace_id: 'wC', agent: null, cwd: wt('pane-caller') },
    { pane_id: 'wX:p1', workspace_id: 'wX', agent: 'codex', agent_status: 'idle', cwd: wt('idle-codex') },
    { pane_id: 'wY:p1', workspace_id: 'wY', agent: 'claude', agent_status: 'idle', cwd: wt('idle-two'), agent_session: session('claude', OWN) },
    { pane_id: 'wZ:p1', workspace_id: 'wZ', agent: 'claude', agent_status: 'idle', cwd: wt('idle-lost'), agent_session: session('claude', LOST) },
  ],
  agents: [],
}));
writeFileSync(join(bin, 'herdr'), `#!${bun}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const verb = args[0] === '--session' ? args.slice(2) : args;
const file = ${JSON.stringify(snapshotFile)};
const counter = ${JSON.stringify(counter)};
const snap = () => JSON.parse(readFileSync(file, 'utf8'));
const drop = (s, ws) => { s.workspaces = s.workspaces.filter(w => w.workspace_id !== ws); s.panes = s.panes.filter(p => p.workspace_id !== ws); writeFileSync(file, JSON.stringify(s)); };
const v = verb.join(' ');
if (v === 'session list --json') console.log(JSON.stringify({ sessions: [{ name: 'default', running: true, default: true }] }));
else if (v === 'api snapshot') {
  const n = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
  writeFileSync(counter, String(n));
  const mode = process.env.FAKE_SNAPSHOT;
  if (mode === 'fail-first' && n === 1) { console.error('fake herdr: socket busy'); process.exit(1); }
  if (mode === 'slow-first' && n === 1) await new Promise(r => setTimeout(r, 11_500));
  const s = snap();
  // a person opens a shell on a worktree while --pick waits for an answer
  if (process.env.FAKE_GROW && n > 1) {
    s.workspaces.push({ workspace_id: 'wG', label: 'grown', agent_status: 'unknown' });
    s.panes.push({ pane_id: 'wG:p1', workspace_id: 'wG', agent: null, cwd: process.env.FAKE_GROW });
  }
  console.log(JSON.stringify({ result: { snapshot: s } }));
}
else if (verb[0] === 'workspace' && verb[1] === 'close' && verb.length === 3) {
  const s = snap();
  if (!s.workspaces.some(w => w.workspace_id === verb[2])) { console.error('fake herdr: no workspace ' + verb[2]); process.exit(1); }
  drop(s, verb[2]);
  console.log('{"result":{"closed":true}}');
} else if (v.startsWith('worktree remove --workspace ') && verb.length === 4) {
  if (process.env.FAKE_WTREMOVE === 'fail') { console.error('fake herdr: repository is not trusted'); process.exit(1); }
  const s = snap();
  const w = s.workspaces.find(w => w.workspace_id === verb[3]);
  if (!w?.worktree) { console.error('fake herdr: no worktree workspace ' + verb[3]); process.exit(1); }
  const r = spawnSync(${JSON.stringify(gitBin)}, ['-C', w.worktree.repo_root, 'worktree', 'remove', w.worktree.checkout_path], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr.trim()); process.exit(1); }
  drop(s, verb[3]);
  console.log('{"result":{"removed":true}}');
} else { console.error('fake herdr: unexpected', args); process.exit(8); }
`);
chmodSync(join(bin, 'herdr'), 0o700);

const base = { PATH: bin, HOME: home, GHQ_ROOT: ghq, MAW_HERDR_CLAUDE_ROOTS: claudeRoot, MAW_HERDR_CODEX_ROOTS: codexRoot, MAW_ORACLES_JSON: join(T, 'absent.json') };
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const run = (args, { env = {}, input = '', cwd = T } = {}) => {
  rmSync(log, { force: true });
  rmSync(counter, { force: true });
  const r = spawnSync(bun, [entry, ...args], { env: { ...base, ...env }, cwd, encoding: 'utf8', timeout: 90_000, input });
  return { code: r.status, out: r.stdout, err: r.stderr, calls: calls() };
};
const json = (args, opts) => {
  const r = run([...args, '--json'], opts);
  let parsed = {};
  try { parsed = JSON.parse(r.out); } catch { throw new Error(`${args.join(' ')} printed no JSON (exit ${r.code}): ${r.err.slice(0, 400)}`); }
  return { ...parsed, code: r.code, err: r.err, calls: r.calls };
};
const READS = new Set(['session list --json', 'api snapshot']);
const mutations = cs => cs.filter(c => !READS.has((c[0] === '--session' ? c.slice(2) : c).join(' ')));
const gitListed = () => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9));
const spaces = () => JSON.parse(readFileSync(snapshotFile, 'utf8')).workspaces.map(w => w.workspace_id);
const codesOf = (plan, label) => plan.kept.find(k => k.label === label || k.path === wt(label))?.reasons.map(r => r.code) ?? [];
const planned = (plan, label) => plan.actions.find(a => a.path === wt(label));

const failures = [];
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL ${name}\n     ${String(err.message).split('\n').slice(0, 6).join('\n     ')}`);
  }
}

try {
  // --- plans: nothing here may change anything ---------------------------------------
  // read lazily, so a verb the entry does not know fails its own tests, not the run
  const memo = f => { let v; return () => (v ??= f()); };
  const cP = memo(() => json(['clean', '--min-age', '0']));
  const ciP = memo(() => json(['clean', '--min-age', '0', '--idle-shells']));
  const aP = memo(() => json(['audit']));

  test('an agent in a plain space inside a merged worktree keeps it', () => {
    assert.equal(planned(cP(), 'plain-agent'), undefined, JSON.stringify(planned(cP(), 'plain-agent')));
    assert.ok(codesOf(cP(), 'plain-agent').includes('agent'), JSON.stringify(codesOf(cP(), 'plain-agent')));
  });
  test('an agent cd\'d in from a space bound to another checkout keeps it', () => {
    assert.equal(planned(ciP(), 'foreign-agent'), undefined);
    assert.ok(codesOf(ciP(), 'foreign-agent').includes('agent'), JSON.stringify(ciP().kept.find(k => k.label === 'foreign-agent')));
  });
  test('a bare shell keeps its worktree unless --idle-shells', () => {
    assert.equal(planned(cP(), 'plain-shell'), undefined);
    assert.ok(codesOf(cP(), 'plain-shell').includes('shell'), JSON.stringify(codesOf(cP(), 'plain-shell')));
    assert.ok(codesOf(cP(), 'bound-shell').includes('shell'), JSON.stringify(codesOf(cP(), 'bound-shell')));
  });
  test('--idle-shells closes a plain space on the worktree BEFORE git removes the folder', () => {
    assert.deepEqual(planned(ciP(), 'plain-shell')?.commands, ['herdr --session default workspace close wS', `git -C ${repo} worktree remove ${wt('plain-shell')}`]);
  });
  test('the checkout this command runs in is kept (cwd)', () => {
    const r = json(['clean', '--min-age', '0'], { cwd: wt('caller-wt') });
    assert.equal(planned(r, 'caller-wt'), undefined);
    assert.ok(codesOf(r, 'caller-wt').includes('caller'), JSON.stringify(codesOf(r, 'caller-wt')));
  });
  test('the checkout this command runs in is kept (HERDR_PANE_ID)', () => {
    const r = json(['clean', '--min-age', '0', '--idle-shells'], { env: { HERDR_PANE_ID: 'wC:p1', HERDR_SOCKET_PATH: join(home, '.config', 'herdr', 'herdr.sock') } });
    assert.equal(planned(r, 'pane-caller'), undefined);
    assert.ok(codesOf(r, 'pane-caller').includes('caller'), JSON.stringify(codesOf(r, 'pane-caller')));
    assert.ok(planned(ciP(), 'pane-caller'), 'and without the env it is removable, so the env is what kept it');
  });
  test('git-locked worktrees are kept, merged or gone', () => {
    assert.equal(planned(cP(), 'locked-merged'), undefined);
    assert.ok(codesOf(cP(), 'locked-merged').includes('locked'), JSON.stringify(codesOf(cP(), 'locked-merged')));
    assert.equal(planned(cP(), 'locked-gone'), undefined);
  });
  test('an .envrc is data, untracked or gitignored — the worktree is kept', () => {
    assert.equal(planned(cP(), 'envrc-untracked'), undefined, JSON.stringify(planned(cP(), 'envrc-untracked')));
    assert.ok(codesOf(cP(), 'envrc-untracked').includes('uncommitted'), JSON.stringify(codesOf(cP(), 'envrc-untracked')));
    assert.equal(planned(cP(), 'envrc-ignored'), undefined, JSON.stringify(planned(cP(), 'envrc-ignored')));
    assert.ok(codesOf(cP(), 'envrc-ignored').includes('ignored'), JSON.stringify(codesOf(cP(), 'envrc-ignored')));
    assert.ok(!JSON.stringify(cP()).includes('NOT_A_REAL_TOKEN'), 'the .envrc content is never printed');
  });
  test('data/target/labels.db is data; build/ at the root and a .pytest_cache are rebuildable', () => {
    assert.equal(planned(cP(), 'nested-db'), undefined, JSON.stringify(planned(cP(), 'nested-db')));
    assert.ok(codesOf(cP(), 'nested-db').includes('ignored'), JSON.stringify(codesOf(cP(), 'nested-db')));
    assert.deepEqual(planned(cP(), 'root-build')?.commands, [`git -C ${repo} worktree remove ${wt('root-build')}`]);
  });

  const idle = pane => aP().findings.find(f => f.kind === 'idle' && f.pane === pane);
  test('an idle codex beside only a claude transcript is not idle (no transcript of its own)', () => {
    assert.equal(idle('wX:p1'), undefined, JSON.stringify(idle('wX:p1')));
  });
  test("herdr's agent_session picks the agent's own transcript, not the newest in the folder", () => {
    assert.equal(idle('wY:p1')?.resume.id, OWN, JSON.stringify(idle('wY:p1')?.resume));
    assert.ok(idle('wY:p1').resume.command.endsWith(`claude --resume ${OWN}`));
  });
  test('an agent whose named session has no transcript is not idle', () => {
    assert.equal(idle('wZ:p1'), undefined, JSON.stringify(idle('wZ:p1')));
  });
  test('sync --idle-agents never plans closing the codex space', () => {
    const s = json(['sync', '--idle-agents']);
    assert.ok(!s.actions.some(x => x.key === 'idle:default/wX'), JSON.stringify(s.actions.map(x => x.key)));
    assert.ok(s.actions.some(x => x.key === 'idle:default/wY' && x.why.includes(OWN)), JSON.stringify(s.actions.map(x => [x.key, x.why])));
  });

  test('--session with no target is a usage error ending in runnable commands', () => {
    const r = run(['clean', '--session', 'default']);
    assert.equal(r.code, 2, `${r.code} ${r.out.slice(0, 200)} ${r.err}`);
    assert.ok(r.err.includes(`maw herdr clean --session default ${wt('bound-shell')}`) || r.err.includes('maw herdr clean --session default '), r.err);
    assert.ok(!r.err.includes('<'), `no placeholder in the fix: ${r.err}`);
    assert.equal(mutations(r.calls).length, 0);
  });

  // --- the guard reads the same load the plan was built on ----------------------------
  test('a snapshot that fails ONCE stops clean --go (no second, luckier read)', () => {
    const r = run(['clean', '--min-age', '0', '--go'], { env: { FAKE_SNAPSHOT: 'fail-first' } });
    assert.equal(mutations(r.calls).length, 0, `acted on a blind plan: ${JSON.stringify(mutations(r.calls))}`);
    assert.equal(r.code, 1, r.out + r.err);
    assert.ok(r.err.includes('did nothing') && r.err.includes('herdr --session default api snapshot'), r.err);
  });
  test('a snapshot slower than the loader\'s timeout stops clean --go', () => {
    const r = run(['clean', '--min-age', '0', '--go'], { env: { FAKE_SNAPSHOT: 'slow-first' } });
    assert.equal(mutations(r.calls).length, 0, `acted on a blind plan: ${JSON.stringify(mutations(r.calls))}`);
    assert.equal(r.code, 1, r.out + r.err);
    assert.ok(r.err.includes('timed out') || r.err.includes('did not answer'), r.err);
  });

  // --- --pick -------------------------------------------------------------------------
  test('--pick answered q asks once and nothing more', () => {
    const r = run(['clean', '--min-age', '0', '--pick'], { input: 'q\n' });
    assert.equal(r.code, 0, r.err);
    assert.equal((r.err.match(/do it\? \[y\/N\/q\]/g) ?? []).length, 1, r.err);
    assert.ok(r.out.includes('not asked (you quit)'), r.out);
    assert.equal(mutations(r.calls).length, 0);
  });
  test('--pick: a space opened on it while the prompt waited means SKIP, not unshown steps', () => {
    const r = run(['clean', 'root-build', '--pick'], { input: 'y\n', env: { FAKE_GROW: wt('root-build') } });
    // without --idle-shells the grown shell keeps it; with it, the steps changed
    assert.equal(mutations(r.calls).length, 0, JSON.stringify(mutations(r.calls)));
    const s = run(['clean', 'root-build', '--idle-shells', '--pick'], { input: 'y\n', env: { FAKE_GROW: wt('root-build') } });
    assert.equal(mutations(s.calls).length, 0, `ran steps nobody approved: ${JSON.stringify(mutations(s.calls))}`);
    assert.ok(s.out.includes('SKIP') && s.out.includes('changed since the plan') && s.out.includes('workspace close wG'), s.out);
    assert.ok(existsSync(wt('root-build')));
  });

  // --- acting ---------------------------------------------------------------------------
  test('a failed herdr worktree remove prints other commands, not the same one again', () => {
    const r = json(['clean', 'bound-shell', '--idle-shells', '--go'], { env: { FAKE_WTREMOVE: 'fail' } });
    const res = r.results?.[0] ?? {};
    assert.equal(res.status, 'FAIL', JSON.stringify(r.results));
    const lines = String(res.fix).split('\n');
    assert.ok(lines.includes('herdr --session default worktree remove --workspace wB --trust-repository'), res.fix);
    assert.ok(lines.includes(`git -C ${repo} worktree remove ${wt('bound-shell')} && herdr --session default workspace close wB`), res.fix);
    assert.ok(!lines.includes('herdr --session default worktree remove --workspace wB'), 'never just the failed command again');
    assert.ok(existsSync(wt('bound-shell')) && spaces().includes('wB'));
  });
  test('clean plain-shell --idle-shells --go: plain space closed, folder gone, herdr and git agree', () => {
    const r = json(['clean', 'plain-shell', '--idle-shells', '--go']);
    assert.deepEqual(r.results?.map(x => [x.label, x.status]), [['plain-shell', 'RM']], JSON.stringify(r.results));
    assert.deepEqual(r.disagree, []);
    assert.ok(!spaces().includes('wS'), `wS still open: ${spaces()}`);
    assert.ok(!existsSync(wt('plain-shell')) && !gitListed().includes(wt('plain-shell')));
  });
  test('clean --min-age 0 --go removes only what may go', () => {
    const r = json(['clean', '--min-age', '0', '--go']);
    const listed = gitListed();
    for (const n of ['plain-agent', 'foreign-agent', 'bound-shell', 'pane-caller', 'locked-merged', 'envrc-untracked', 'envrc-ignored', 'nested-db', 'idle-codex', 'idle-two', 'idle-lost']) {
      assert.ok(listed.includes(wt(n)) && existsSync(wt(n)), `${n} must survive: ${JSON.stringify(r.results)}`);
    }
    assert.ok(listed.includes(wt('locked-gone')), 'a locked gone worktree stays listed');
    assert.ok(existsSync(join(wt('envrc-untracked'), '.envrc')) && existsSync(join(wt('nested-db'), 'data', 'target', 'labels.db')));
    for (const n of ['root-build', 'caller-wt']) assert.ok(!listed.includes(wt(n)) && !existsSync(wt(n)), `${n} should be removed: ${JSON.stringify(r.results)}`);
    assert.deepEqual(r.disagree, []);
    assert.equal(r.code, 0, JSON.stringify(r.results));
  });
} finally {
  rmSync(T, { recursive: true, force: true });
}
console.log(`${failures.length ? 'FAILED' : 'ok'}: ${passed} passed, ${failures.length} failed — clean/sync safety floor (${process.env.MAW_CLEANUP_ENTRY ? 'custom entry' : 'source'})`);
if (failures.length) process.exit(1);
