#!/usr/bin/env node
// `maw herdr audit`, `clean` and `sync` (#64) against the actual CLI process:
// real git worktrees cloned from a real bare origin in a temp ghq root, a fake
// Claude transcript root, and a fake herdr first on PATH that keeps its state in
// a JSON file, logs every call, and really removes a checkout (with real git)
// when asked `worktree remove`. Nothing here can reach the live herdr or the
// real ghq tree: PATH is the fake's directory alone, HOME and GHQ_ROOT are temp.
//
// Checked, not assumed: audit and every plan leave git, the filesystem and herdr
// byte-for-byte as they were; --pick asks before each action and an unanswered
// or declined prompt changes nothing; a worktree with gitignored data survives
// clean --go, even when named; removals leave herdr and `git worktree list`
// agreeing; a herdr session that does not answer stops clean before it acts.
// MAW_CLEANUP_ENTRY=<bundle> runs the same checks against a built index.js.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(process.env.MAW_CLEANUP_ENTRY || join(root, 'index.mjs'));
const bun = process.versions.bun ? process.execPath : spawnSync('bun', ['-e', 'console.log(process.execPath)'], { encoding: 'utf8' }).stdout.trim();
assert.ok(bun && existsSync(bun), 'bun is required: curl -fsSL https://bun.sh/install | bash');
const gitBin = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
assert.ok(gitBin, 'git is required: xcode-select --install   (or: sudo apt-get install -y git)');

// realpath: macOS hands out /var/… for /private/var/…, and git records the latter
const T = realpathSync(mkdtempSync(join(tmpdir(), 'maw-herdr-cleanup-')));
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

// --- origin, a seed clone that can push, and the repo under the ghq root ----------
const origin = join(T, 'origin.git');
git(T, 'init', '-q', '--bare', origin);
const seed = join(T, 'seed');
git(T, 'clone', '-q', origin, seed);
writeFileSync(join(seed, 'README'), 'alpha\n');
writeFileSync(join(seed, '.gitignore'), '.data/\nnode_modules/\n');
git(seed, 'add', '.');
git(seed, 'commit', '-q', '-m', 'init');
git(seed, 'push', '-q', 'origin', 'main');

const ghq = join(T, 'code');
const repo = join(ghq, 'github.com', 'org', 'alpha');
mkdirSync(dirname(repo), { recursive: true });
git(T, 'clone', '-q', origin, repo);
const wt = name => join(repo, 'wt', name);
const NAMES = ['gone-cold', 'gone-open', 'gone-agent', 'merged-shell', 'merged-cold', 'merged-data', 'merged-nodemods', 'merged-dirty', 'merged-agent', 'feature', 'pushed', 'idle-old', 'idle-busy'];
// commits are 10 days old, but each worktree is added NOW: its reflog says it was
// just touched, which is what --min-age reads (a new branch looks merged too)
const gitNow = (cwd, ...args) => execFileSync(gitBin, ['-C', cwd, ...args], { encoding: 'utf8', env: Object.fromEntries(Object.entries(gitEnv).filter(([k]) => !k.endsWith('_DATE'))), stdio: ['ignore', 'pipe', 'pipe'] });
for (const n of NAMES) gitNow(repo, 'worktree', 'add', '-q', '-b', `b/${n}`, wt(n));
rmSync(wt('gone-cold'), { recursive: true, force: true });
rmSync(wt('gone-open'), { recursive: true, force: true });
rmSync(wt('gone-agent'), { recursive: true, force: true });
mkdirSync(join(wt('merged-data'), '.data'));
writeFileSync(join(wt('merged-data'), '.data', 'model.bin'), 'm'.repeat(4096));
mkdirSync(join(wt('merged-nodemods'), 'node_modules', 'x'), { recursive: true });
writeFileSync(join(wt('merged-nodemods'), 'node_modules', 'x', 'index.js'), 'module.exports = 1;\n');
writeFileSync(join(wt('merged-nodemods'), '.DS_Store'), 'junk');   // OS litter never keeps a worktree
writeFileSync(join(wt('merged-dirty'), 'notes.txt'), 'half a thought\n');
writeFileSync(join(wt('feature'), 'f.txt'), 'f\n');
git(wt('feature'), 'add', 'f.txt');
git(wt('feature'), 'commit', '-q', '-m', 'local only');
writeFileSync(join(wt('pushed'), 'p.txt'), 'p\n');
git(wt('pushed'), 'add', 'p.txt');
git(wt('pushed'), 'commit', '-q', '-m', 'pushed, not merged');
git(wt('pushed'), 'push', '-q', 'origin', 'b/pushed');
// upstream moves on: the main checkout is now only behind
writeFileSync(join(seed, 'CHANGES'), 'upstream\n');
git(seed, 'add', 'CHANGES');
git(seed, 'commit', '-q', '-m', 'upstream change');
git(seed, 'push', '-q', 'origin', 'main');
git(repo, 'fetch', '-q');

// --- transcripts: idle-old and idle-busy were last written 3 days ago --------------
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
const IDLE_ID = '11111111-2222-4333-8444-555555555555';
transcript(wt('idle-old'), IDLE_ID, 3 * 86_400_000);
transcript(wt('idle-busy'), '22222222-2222-4333-8444-555555555555', 3 * 86_400_000);
transcript(wt('merged-agent'), '33333333-2222-4333-8444-555555555555', 60_000);

// --- the fake herdr ----------------------------------------------------------------
const tree = (checkout, linked = true) => ({ repo_name: 'alpha', repo_key: join(repo, '.git'), repo_root: repo, checkout_path: checkout, is_linked_worktree: linked });
const vanished = join(T, 'vanished');
const vanished2 = join(T, 'vanished2');
const snapshotFile = join(T, 'snapshot.json');
writeFileSync(snapshotFile, JSON.stringify({
  workspaces: [
    { workspace_id: 'w2', label: 'merged-shell', agent_status: 'unknown', worktree: tree(wt('merged-shell')) },
    { workspace_id: 'w3', label: 'merged-agent', agent_status: 'idle', worktree: tree(wt('merged-agent')) },
    { workspace_id: 'w4', label: 'scratch', agent_status: 'unknown' },
    { workspace_id: 'w5', label: 'gone-open', agent_status: 'unknown', worktree: tree(wt('gone-open')) },
    { workspace_id: 'w6', label: 'idle-old', agent_status: 'idle', worktree: tree(wt('idle-old')) },
    { workspace_id: 'w7', label: 'idle-busy', agent_status: 'working', worktree: tree(wt('idle-busy')) },
    { workspace_id: 'w8', label: 'lost-agent', agent_status: 'idle' },
    { workspace_id: 'w9', label: 'gone-agent', agent_status: 'working', worktree: tree(wt('gone-agent')) },
  ],
  panes: [
    { pane_id: 'w2:p1', workspace_id: 'w2', agent: null, cwd: wt('merged-shell') },
    { pane_id: 'w3:p1', workspace_id: 'w3', agent: 'claude', agent_status: 'idle', cwd: wt('merged-agent') },
    { pane_id: 'w4:p1', workspace_id: 'w4', agent: null, cwd: vanished },
    { pane_id: 'w5:p1', workspace_id: 'w5', agent: null, cwd: wt('gone-open') },
    { pane_id: 'w6:p1', workspace_id: 'w6', agent: 'claude', agent_status: 'idle', cwd: wt('idle-old') },
    { pane_id: 'w7:p1', workspace_id: 'w7', agent: 'claude', agent_status: 'idle', cwd: wt('idle-busy') },
    { pane_id: 'w7:p2', workspace_id: 'w7', agent: 'codex', agent_status: 'working', cwd: wt('idle-busy') },
    { pane_id: 'w8:p1', workspace_id: 'w8', agent: 'claude', agent_status: 'idle', cwd: vanished2 },
    { pane_id: 'w9:p1', workspace_id: 'w9', agent: 'claude', agent_status: 'working', cwd: wt('gone-agent') },
  ],
  agents: [],
}));
writeFileSync(join(bin, 'herdr'), `#!${bun}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const verb = args[0] === '--session' ? args.slice(2) : args;
const file = ${JSON.stringify(snapshotFile)};
const snap = () => JSON.parse(readFileSync(file, 'utf8'));
const drop = (s, ws) => { s.workspaces = s.workspaces.filter(w => w.workspace_id !== ws); s.panes = s.panes.filter(p => p.workspace_id !== ws); writeFileSync(file, JSON.stringify(s)); };
const v = verb.join(' ');
if (v === 'session list --json') console.log(JSON.stringify({ sessions: [{ name: 'default', running: true, default: true }] }));
else if (v === 'api snapshot' && process.env.FAKE_SNAPSHOT === 'fail') { console.error('fake herdr: socket refused'); process.exit(1); }
else if (v === 'api snapshot') console.log(JSON.stringify({ result: { snapshot: snap() } }));
else if (verb[0] === 'workspace' && verb[1] === 'close' && verb.length === 3) {
  const s = snap();
  if (!s.workspaces.some(w => w.workspace_id === verb[2])) { console.error('fake herdr: no workspace ' + verb[2]); process.exit(1); }
  drop(s, verb[2]);
  console.log('{"result":{"closed":true}}');
} else if (v.startsWith('worktree remove --workspace ') && (verb.length === 4 || (verb.length === 5 && verb[4] === '--force'))) {
  const s = snap();
  const w = s.workspaces.find(w => w.workspace_id === verb[3]);
  if (!w?.worktree) { console.error('fake herdr: no worktree workspace ' + verb[3]); process.exit(1); }
  const r = spawnSync(${JSON.stringify(gitBin)}, ['-C', w.worktree.repo_root, 'worktree', 'remove', ...verb.slice(4), w.worktree.checkout_path], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr.trim()); process.exit(1); }
  drop(s, verb[3]);
  console.log('{"result":{"removed":true}}');
} else { console.error('fake herdr: unexpected', args); process.exit(8); }
`);
chmodSync(join(bin, 'herdr'), 0o700);

const base = {
  PATH: bin, HOME: home, GHQ_ROOT: ghq,
  MAW_HERDR_CLAUDE_ROOTS: claudeRoot, MAW_HERDR_CODEX_ROOTS: codexRoot,
  MAW_ORACLES_JSON: join(T, 'absent.json'),
};
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const run = (args, { env = {}, input = '' } = {}) => {
  rmSync(log, { force: true });
  const r = spawnSync(bun, [entry, ...args], { env: { ...base, ...env }, cwd: T, encoding: 'utf8', timeout: 60_000, input });
  return { code: r.status, out: r.stdout, err: r.stderr, calls: calls() };
};
const json = (args, opts) => {
  const r = run([...args, '--json'], opts);
  assert.ok(r.code === 0 || r.code === 1, `${args.join(' ')} exited ${r.code}: ${r.err}`);
  return { ...JSON.parse(r.out), code: r.code, err: r.err, calls: r.calls };
};
const READS = new Set(['session list --json', 'api snapshot']);
const readOnly = cs => cs.every(c => READS.has((c[0] === '--session' ? c.slice(2) : c).join(' ')));
const mutations = cs => cs.filter(c => !READS.has((c[0] === '--session' ? c.slice(2) : c).join(' ')));

/** Everything a cleanup could change: git's worktrees and refs, every HEAD, every index, the folders, herdr. */
function fingerprint() {
  const g = (...a) => { try { return git(...a); } catch (e) { return `ERR ${e.status}`; } };
  const stamp = p => (existsSync(p) ? statSync(p).mtimeMs : 'absent');
  const parts = [g(repo, 'worktree', 'list', '--porcelain'), g(repo, 'for-each-ref'), g(repo, 'rev-parse', 'HEAD'), stamp(join(repo, '.git', 'index'))];
  for (const n of NAMES) {
    parts.push(n, existsSync(wt(n)), existsSync(wt(n)) ? g(wt(n), 'rev-parse', 'HEAD') : '-', stamp(join(repo, '.git', 'worktrees', n, 'index')));
  }
  parts.push(existsSync(join(wt('merged-data'), '.data', 'model.bin')), readFileSync(snapshotFile, 'utf8'));
  return JSON.stringify(parts);
}
const gitListed = () => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9));
const spaces = () => JSON.parse(readFileSync(snapshotFile, 'utf8')).workspaces.map(w => w.workspace_id);
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };

try {
  const before = fingerprint();
  const unchanged = what => { assert.equal(fingerprint(), before, `${what} changed something`); checks++; };

  // --- audit: every finding, and nothing changed ---------------------------------------
  {
    const r = run(['audit']);
    assert.equal(r.code, 0, r.err);
    for (const s of ['gone-cold', 'gone-open', 'scratch', 'lost-agent', 'idle-old', 'read-only: nothing was changed', 'claude --resume ' + IDLE_ID, 'plan the removals: maw herdr clean', 'plan the sync:     maw herdr sync', 'maw herdr sync --idle-agents']) ok(r.out.includes(s), `audit text lacks '${s}':\n${r.out}`);
    ok(readOnly(r.calls), `audit may only read herdr: ${JSON.stringify(r.calls)}`);
    unchanged('audit');

    const a = json(['audit']);
    const of = k => a.findings.filter(f => f.kind === k);
    assert.equal(a.command, 'audit');
    assert.equal(a.readOnly, true);
    assert.deepEqual(of('gone').map(f => f.path), [wt('gone-agent'), wt('gone-cold'), wt('gone-open')]);
    assert.deepEqual(of('gone')[2].spaces.map(s => s.workspace), ['w5'], 'the gone worktree with a space carries it');
    assert.deepEqual(of('orphan').map(f => [f.workspace, f.agents]), [['w4', []], ['w8', ['w8:p1']]]);
    assert.deepEqual(of('idle').map(f => f.pane).sort(), ['w6:p1', 'w7:p1'], 'only agents idle past 24h WITH a transcript; merged-agent wrote one a minute ago');
    assert.equal(of('idle').find(f => f.pane === 'w6:p1').resume.id, IDLE_ID);
    assert.deepEqual(of('behind').map(f => [f.path, f.behind, f.upstream]), [[repo, 1, 'origin/main']]);
    checks += 6;
    // default --min-age 3: every merged worktree was just added, so all are kept
    const merged = of('merged');
    assert.deepEqual(merged.map(f => f.label).sort(), ['idle-busy', 'idle-old', 'merged-agent', 'merged-cold', 'merged-data', 'merged-dirty', 'merged-nodemods', 'merged-shell']);
    const codes = f => f.keep.map(k => k.code);
    ok(merged.every(f => codes(f).includes('young') || codes(f).every(c => c === 'agent')), `a worktree added today is kept under --min-age 3: ${JSON.stringify(merged.map(f => [f.label, f.keep]))}`);
    ok(merged.filter(f => codes(f)[0] === 'agent').map(f => f.label).sort().join() === 'idle-busy,idle-old,merged-agent', 'an agent in it is reason enough; the disk checks are skipped');
    ok(!a.findings.some(f => [wt('feature'), wt('pushed')].includes(f.path)), 'unmerged worktrees are not clean candidates unless named');
    ok(readOnly(a.calls), 'audit --json only reads');
    unchanged('audit --json');

    const z = json(['audit', '--min-age', '0']);
    const keep = label => z.findings.find(f => f.kind === 'merged' && f.label === label).keep.map(k => k.reason).join(' | ');
    for (const l of ['merged-shell', 'merged-cold', 'merged-nodemods']) assert.equal(keep(l), '', `${l} should be removable: ${keep(l)}`);
    ok(/holds 4 KB of gitignored data \(\.data\)/.test(keep('merged-data')), `gitignored data keeps merged-data: ${keep('merged-data')}`);
    ok(/1 uncommitted: notes\.txt/.test(keep('merged-dirty')), keep('merged-dirty'));
    ok(/agent w3:p1 \(claude, idle\) is in it/.test(keep('merged-agent')), keep('merged-agent'));
    ok(z.findings.find(f => f.label === 'merged-data').keep.some(k => k.fix === `du -sh ${join(wt('merged-data'), '.data')}`), 'the kept reason ends in a command that shows the data');
    unchanged('audit --min-age 0');
    console.log('PASS audit: gone, orphan spaces, idle agents past 24h, only-behind, merged or kept — and it changed nothing (git, folders, indexes, herdr)');
  }

  // --- plans: clean and sync print, and change nothing ----------------------------------
  {
    const c = json(['clean']);
    assert.equal(c.mode, 'plan');
    assert.deepEqual(c.actions.map(a => a.key), [`gone:${wt('gone-cold')}`, `gone:${wt('gone-open')}`]);
    ok(c.kept.some(k => k.path === wt('gone-agent') && k.reasons[0].fix === 'maw herdr peek --session default w9:p1'), 'a gone worktree whose space holds an agent is kept: closing the space would end the agent');
    ok(readOnly(c.calls), 'clean plan only reads');
    const c0 = json(['clean', '--min-age', '0']);
    assert.deepEqual(c0.actions.map(a => a.label), ['gone-cold', 'gone-open', 'merged-cold', 'merged-nodemods', 'merged-shell']);
    assert.deepEqual(c0.actions.find(a => a.label === 'merged-shell').commands, ['herdr --session default worktree remove --workspace w2'], 'a worktree with a space is removed through herdr');
    assert.deepEqual(c0.actions.find(a => a.label === 'merged-cold').commands, [`git -C ${repo} worktree remove ${wt('merged-cold')}`], 'no --force when nothing is untracked');
    assert.deepEqual(c0.actions.find(a => a.label === 'merged-nodemods').commands, [`git -C ${repo} worktree remove --force ${wt('merged-nodemods')}`], '--force only because .DS_Store is all that is untracked');
    assert.deepEqual(c0.actions.find(a => a.label === 'gone-open').commands, ['herdr --session default workspace close w5', `git -C ${repo} worktree remove ${wt('gone-open')}`]);
    ok(c0.kept.some(k => k.label === 'merged-data' && k.reasons.some(r => r.reason.includes('gitignored data'))), 'merged-data is kept in the plan');
    const text = run(['clean', '--min-age', '0']);
    ok(text.out.includes('plan only, nothing was changed') && text.out.includes('run them all:   maw herdr clean --min-age 0 --go') && text.out.includes('ask for each:   maw herdr clean --min-age 0 --pick'), text.out);
    const s = json(['sync']);
    assert.deepEqual(s.actions.map(a => a.key), [`gone:${wt('gone-cold')}`, `gone:${wt('gone-open')}`, 'orphan:default/w4', `behind:${repo}`]);
    assert.deepEqual(s.actions.find(a => a.kind === 'behind').commands, [`git -C ${repo} merge --ff-only '@{u}'`]);
    ok(s.kept.some(k => k.workspace === 'w8' && k.reasons[0].fix === 'maw herdr peek --session default w8:p1'), 'an orphan space with an agent is kept, with the command to look at it');
    ok(s.kept.some(k => k.workspace === 'w6' && k.reasons[0].fix === 'maw herdr sync --idle-agents'), 'idle agents are only closed with --idle-agents');
    const si = json(['sync', '--idle-agents']);
    ok(si.actions.some(a => a.key === 'idle:default/w6'), 'sync --idle-agents plans closing w6');
    ok(si.kept.some(k => k.workspace === 'w7' && k.reasons.some(r => r.reason.includes('w7:p2 in the same space is working'))), 'one working agent keeps the whole space');
    ok([c, c0, s, si].every(x => readOnly(x.calls)), 'plans only read herdr');
    unchanged('clean / sync plans');
    console.log('PASS clean and sync are plan-only by default: every action listed with its exact command, nothing changed');
  }

  // --- --pick asks, and no or no answer changes nothing ------------------------------------
  {
    const eof = run(['clean', '--min-age', '0', '--pick']);
    assert.equal(eof.code, 0, eof.err);
    ok(eof.err.includes('do it? [y/N/q]') && eof.err.includes('herdr --session default workspace close w5') === false, 'the first prompt is shown; end of input stops asking');
    ok((eof.err.match(/do it\? \[y\/N\/q\]/g) ?? []).length === 1, `one prompt, then EOF stops: ${eof.err}`);
    ok(eof.out.includes('declined 5'), eof.out);
    ok(mutations(eof.calls).length === 0, `nothing closed without a yes: ${JSON.stringify(eof.calls)}`);
    unchanged('clean --pick with stdin closed');
    const no = run(['clean', '--min-age', '0', '--pick'], { input: 'n\nn\nn\nn\nn\n' });
    ok((no.err.match(/do it\? \[y\/N\/q\]/g) ?? []).length === 5, `five prompts: ${no.err}`);
    ok(no.err.includes('runs:\n    herdr --session default worktree remove --workspace w2'), 'each prompt shows the exact commands it will run');
    ok(mutations(no.calls).length === 0, 'answering no closes nothing');
    unchanged('clean --pick answered no');
    console.log('PASS --pick asks before each action, shows the commands, and a no (or no answer) changes nothing');
  }

  // --- named targets, through #59's grammar -------------------------------------------------
  {
    const f = json(['clean', 'feature']);
    ok(f.actions.length === 0 && /1 local-only commit/.test(f.kept[0]?.reasons.map(r => r.reason).join(' ')), `local-only work keeps a named worktree: ${JSON.stringify(f.kept)}`);
    const p = json(['clean', 'pushed']);
    assert.deepEqual(p.actions.map(a => a.path), [wt('pushed')], 'a named, pushed worktree may be removed (a squash-merged PR looks like this)');
    const m = json(['clean', 'alpha']);
    ok(m.actions.length === 0 && m.kept[0]?.reasons[0].reason.includes("main checkout"), `the main checkout is never removed: ${JSON.stringify(m.kept)}`);
    const d = run(['clean', 'merged-data', '--go']);
    assert.equal(d.code, 0, d.err);
    ok(existsSync(join(wt('merged-data'), '.data', 'model.bin')) && gitListed().includes(wt('merged-data')), 'a named worktree with gitignored data survives clean --go');
    ok(d.out.includes('gitignored data') && mutations(d.calls).length === 0, d.out);
    const amb = run(['clean', 'merged']);
    ok(amb.code === 1 && amb.err.includes('nothing was done') && amb.err.includes(`maw herdr clean ${wt('merged-cold')}`), `an ambiguous target lists runnable candidates: ${amb.err}`);
    unchanged('named-target plans');
    console.log('PASS named targets: local-only work kept, pushed work removable, main never, gitignored data kept even when named, ambiguity lists commands');
  }

  // --- a herdr session that does not answer stops clean before it acts --------------------
  {
    const r = run(['clean', '--min-age', '0', '--go'], { env: { FAKE_SNAPSHOT: 'fail' } });
    assert.equal(r.code, 1, r.out + r.err);
    ok(r.err.includes('did nothing') && r.err.includes('herdr --session default api snapshot'), r.err);
    ok(mutations(r.calls).length === 0 && existsSync(wt('merged-agent')), 'blind to the agent in merged-agent, clean refused rather than remove it');
    unchanged('clean --go with a failed snapshot');
    console.log('PASS a herdr session whose snapshot fails stops clean --go, with the command to check it');
  }

  // --- --pick: yes to one, and it goes through herdr -------------------------------------
  {
    const r = run(['clean', '--min-age', '0', '--pick'], { input: 'n\nn\nn\nn\ny\n' });
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(mutations(r.calls), [['--session', 'default', 'worktree', 'remove', '--workspace', 'w2']]);
    ok(!existsSync(wt('merged-shell')) && !gitListed().includes(wt('merged-shell')) && !spaces().includes('w2'), 'merged-shell is gone from disk, git and herdr');
    ok(r.out.includes('RM') && r.out.includes('declined 4'), r.out);
    ok(existsSync(wt('merged-cold')) && existsSync(wt('merged-nodemods')), 'the declined ones stay');
    console.log('PASS --pick with one yes: exactly that worktree removed, through herdr, and herdr and git agree');
  }

  // --- clean --go ---------------------------------------------------------------------------
  {
    const r = json(['clean', '--min-age', '0', '--go']);
    assert.equal(r.code, 0, JSON.stringify({ results: r.results, disagree: r.disagree, err: r.err }, null, 1));
    assert.deepEqual(r.results.map(x => [x.label, x.status]), [['gone-cold', 'PRUNED'], ['gone-open', 'PRUNED'], ['merged-cold', 'RM'], ['merged-nodemods', 'RM']]);
    assert.deepEqual(r.disagree, []);
    assert.deepEqual(mutations(r.calls), [['--session', 'default', 'workspace', 'close', 'w5']]);
    const listed = gitListed();
    for (const n of ['gone-cold', 'gone-open', 'merged-cold', 'merged-nodemods']) ok(!listed.includes(wt(n)) && !existsSync(wt(n)), `${n} removed`);
    for (const n of ['merged-data', 'merged-dirty', 'merged-agent', 'feature', 'pushed']) ok(listed.includes(wt(n)) && existsSync(wt(n)), `${n} kept`);
    ok(existsSync(join(wt('merged-data'), '.data', 'model.bin')), 'the gitignored data is still there');
    // agreement: every space herdr shows sits on a folder git still lists (or on no worktree)
    const snap = JSON.parse(readFileSync(snapshotFile, 'utf8'));
    ok(snap.workspaces.filter(w => w.worktree).every(w => listed.includes(w.worktree.checkout_path)), `herdr and git agree: ${JSON.stringify(snap.workspaces.map(w => w.worktree?.checkout_path))}`);
    console.log('PASS clean --go: gone pruned (its space closed through herdr), merged removed, dirty/agent/gitignored-data kept; herdr and git agree');
  }

  // --- sync --go, then --idle-agents --go --------------------------------------------------
  {
    const r = json(['sync', '--go']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.results.map(x => [x.kind, x.status]), [['orphan', 'CLOSED'], ['behind', 'FF']]);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'origin/main'), 'main fast-forwarded to origin/main');
    ok(!spaces().includes('w4') && spaces().includes('w8') && spaces().includes('w6') && spaces().includes('w7'), `orphan closed; agent spaces untouched: ${spaces()}`);
    const i = json(['sync', '--idle-agents', '--go']);
    assert.equal(i.code, 0, i.err);
    assert.deepEqual(i.results.map(x => [x.key, x.status]), [['idle:default/w6', 'CLOSED']]);
    ok(i.results[0].detail.includes(`claude --resume ${IDLE_ID}`), 'closing an idle agent prints how to resume it');
    ok(!spaces().includes('w6') && spaces().includes('w7'), 'w6 closed; w7 kept for its working codex');
    const after = json(['audit']);
    ok(!after.findings.some(f => ['gone', 'orphan', 'behind'].includes(f.kind) && f.workspace !== 'w8' && f.label !== 'gone-agent'), `nothing left to sync but the spaces with an agent: ${JSON.stringify(after.findings.map(f => [f.kind, f.label]))}`);
    ok(spaces().includes('w9') && gitListed().includes(wt('gone-agent')), 'the agent on a gone worktree was left alone by clean and sync');
    console.log('PASS sync --go closed the orphan space and fast-forwarded main; --idle-agents closed only the all-idle, resumable space');
  }

  // --- usage errors end in a command; help runs nothing -----------------------------------
  {
    for (const [args, want] of [
      [['clean', '--go', '--pick'], 'maw herdr clean --pick\n  maw herdr clean --go'],
      [['audit', '--go'], 'unknown argument for audit: --go'],
      [['sync', '--dry', '--go'], 'maw herdr sync --go'],
      [['clean', '--min-age', 'soon'], 'maw herdr clean --min-age 3'],
      [['sync', '--idle', 'x'], 'maw herdr sync --idle 24h'],
    ]) {
      const r = run(args);
      ok(r.code === 2 && r.err.includes(want) && r.calls.length === 0, `${args.join(' ')}: ${r.code} ${r.err}`);
    }
    for (const verb of ['audit', 'clean', 'sync']) {
      const r = run([verb, '--help']);
      ok(r.code === 0 && r.out.includes('clean [<target>...] [--go|--pick]') && r.calls.length === 0, `${verb} --help: ${r.err}`);
    }
    console.log('PASS usage errors exit 2 ending in a runnable command; --help prints usage and calls nothing');
  }

  console.log(`ok: ${checks} audit/clean/sync checks (${process.env.MAW_CLEANUP_ENTRY ? 'bundle' : 'source'})`);
} finally {
  rmSync(T, { recursive: true, force: true });
}
