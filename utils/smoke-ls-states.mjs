#!/usr/bin/env node
// `maw herdr ls [running|open|resumable|cold]` (#60), against the actual CLI
// process: an isolated fake Herdr first on PATH, real git worktrees in a temp
// ghq root, and fake Claude/Codex transcript roots. The fake Herdr logs every
// call, so "ls only ever reads" is checked, not assumed.
// MAW_STATES_ENTRY=<bundle> runs the same checks against a built index.js.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(process.env.MAW_STATES_ENTRY || join(root, 'index.mjs'));
const bun = process.versions.bun ? process.execPath : spawnSync('bun', ['-e', 'console.log(process.execPath)'], { encoding: 'utf8' }).stdout.trim();
assert.ok(bun && existsSync(bun), 'bun is required: curl -fsSL https://bun.sh/install | bash');
const gitBin = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
assert.ok(gitBin, 'git is required: xcode-select --install   (or: sudo apt-get install -y git)');

const temporary = mkdtempSync(join(tmpdir(), 'maw-herdr-ls-states-'));
const bin = join(temporary, 'bin');
const log = join(temporary, 'calls.jsonl');
const home = join(temporary, 'home');
mkdirSync(bin);
mkdirSync(home);
// git, and only git, joins the fake on PATH: the scan needs `git worktree list`.
symlinkSync(gitBin, join(bin, 'git'));

const git = (cwd, ...args) => execFileSync(gitBin, ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', '-c', 'init.defaultBranch=main', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// --- a ghq root: host/org/repo -------------------------------------------------
const ghq = join(temporary, 'code');
const repo = join(ghq, 'github.com', 'org', 'alpha');
mkdirSync(repo, { recursive: true });
git(repo, 'init', '-q');
writeFileSync(join(repo, 'README'), 'alpha\n');
git(repo, 'add', 'README');
git(repo, 'commit', '-q', '-m', 'init');
const wt = name => join(repo, 'wt', name);
for (const name of ['run-one', 'open-one', 'claude-one', 'codex-one', 'cold-one', 'tiny', 'sub', 'gone']) git(repo, 'worktree', 'add', '-q', '-b', `b/${name}`, wt(name));
// a worktree whose directory was deleted behind git's back: prunable, not listed
rmSync(wt('gone'), { recursive: true, force: true });
// a clone that never used a worktree, and a non-host directory that looks like
// a repo with worktrees: neither is a place work lives, neither is listed
const plain = join(ghq, 'github.com', 'org', 'plain');
mkdirSync(plain, { recursive: true });
git(plain, 'init', '-q');
mkdirSync(join(ghq, 'datasets', 'x', 'y', '.git', 'worktrees', 'z'), { recursive: true });

// --- transcripts ---------------------------------------------------------------
// Claude keys by the resolved cwd (process.cwd() on macOS is /private/var/…);
// Codex records the cwd as spelled. Using one of each covers both spellings.
const claudeRoot = join(temporary, 'claude-projects');
const codexRoot = join(temporary, 'codex-sessions');
const enc = p => p.replace(/[^a-zA-Z0-9]/g, '-');
const big = '{"type":"user","message":"' + 'x'.repeat(2048) + '"}\n';
const claudeId = '11111111-2222-4333-8444-555555555555';
mkdirSync(join(claudeRoot, enc(realpathSync(wt('claude-one')))), { recursive: true });
writeFileSync(join(claudeRoot, enc(realpathSync(wt('claude-one'))), `${claudeId}.jsonl`), big);
// an empty-ish transcript resumes into nothing: still cold
mkdirSync(join(claudeRoot, enc(realpathSync(wt('tiny')))), { recursive: true });
writeFileSync(join(claudeRoot, enc(realpathSync(wt('tiny'))), 'aaaaaaaa-0000-4000-8000-000000000000.jsonl'), '{}\n');
// the running worktree also has a transcript; running still wins
mkdirSync(join(claudeRoot, enc(realpathSync(wt('run-one')))), { recursive: true });
writeFileSync(join(claudeRoot, enc(realpathSync(wt('run-one'))), 'bbbbbbbb-0000-4000-8000-000000000000.jsonl'), big);

const codexId = '01a0d5fd-c656-78e2-a436-82d136350c71';
const codexDay = join(codexRoot, '2026', '09', '25');
mkdirSync(codexDay, { recursive: true });
const meta = (id, cwd, source) => JSON.stringify({ timestamp: '2026-09-25T00:36:13.575Z', type: 'session_meta', payload: { session_id: id, id, cwd, originator: 'codex-tui', source, base_instructions: { text: 'y'.repeat(3000) } } }) + '\n';
writeFileSync(join(codexDay, `rollout-2026-09-25T07-36-13-${codexId}.jsonl`), meta(codexId, wt('codex-one'), 'cli') + big);
// a subagent thread is resumed through its parent, never on its own: still cold
const subId = '01a0d5fd-0000-7000-8000-000000000000';
writeFileSync(join(codexDay, `rollout-2026-09-25T07-40-00-${subId}.jsonl`), meta(subId, wt('sub'), { subagent: { thread_spawn: { depth: 1 } } }) + big);

// --- the fake herdr --------------------------------------------------------------
const tree = (checkout, linked) => ({ repo_name: 'alpha', repo_key: join(repo, '.git'), repo_root: repo, checkout_path: checkout, is_linked_worktree: linked });
const scratch = join(temporary, 'scratch');
mkdirSync(scratch);
const snapshot = {
  workspaces: [
    { workspace_id: 'w1', label: 'run-one', agent_status: 'working', worktree: tree(wt('run-one'), true) },
    { workspace_id: 'w2', label: 'open-one', agent_status: 'unknown', worktree: tree(wt('open-one'), true) },
    { workspace_id: 'w3', label: 'scratch', agent_status: 'unknown' },   // no worktree block: its pane's cwd
  ],
  panes: [
    { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'working', cwd: wt('run-one') },
    { pane_id: 'w1:p2', workspace_id: 'w1', agent: null, cwd: wt('run-one') },
    { pane_id: 'w2:p1', workspace_id: 'w2', agent: null, cwd: wt('open-one') },
    { pane_id: 'w3:p1', workspace_id: 'w3', agent: null, cwd: scratch },
  ],
};
const snapshotFile = join(temporary, 'snapshot.json');
const useSnapshot = x => writeFileSync(snapshotFile, JSON.stringify(x));
useSnapshot(snapshot);
writeFileSync(join(bin, 'herdr'), `#!${bun}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const verb = args[0] === '--session' ? args.slice(2) : args;
if (verb.join(' ') === 'session list --json') console.log(JSON.stringify({ sessions: [{ name: 'default', running: true, default: true }] }));
else if (verb.join(' ') === 'api snapshot') console.log(JSON.stringify({ result: { snapshot: JSON.parse(readFileSync(${JSON.stringify(snapshotFile)}, 'utf8')) } }));
else if (verb[0] === 'machine') process.exit(1);
else { console.error('fake herdr: unexpected', args); process.exit(8); }
`);
chmodSync(join(bin, 'herdr'), 0o700);

const base = {
  PATH: bin, HOME: home, GHQ_ROOT: ghq,
  MAW_HERDR_CLAUDE_ROOTS: claudeRoot, MAW_HERDR_CODEX_ROOTS: codexRoot,
  HERDR_FED_URL: 'http://127.0.0.1:9', MAW_ORACLES_JSON: join(temporary, 'absent.json'),
};
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const run = (args, env = {}) => {
  rmSync(log, { force: true });
  const r = spawnSync(bun, [entry, ...args], { env: { ...base, ...env }, cwd: temporary, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, out: r.stdout, err: r.stderr, calls: calls() };
};
const json = (args, env) => {
  const r = run([...args, '--json'], env);
  assert.equal(r.code, 0, r.err);
  return { ...JSON.parse(r.out), calls: r.calls };
};
const READS = new Set(['session list --json', 'api snapshot', 'machine list']);
const readOnly = cs => cs.every(c => READS.has((c[0] === '--session' ? c.slice(2) : c).join(' ')));
const stateOf = (out, path) => out.worktrees.find(r => realpathSync(r.path) === realpathSync(path))?.state;
let checks = 0;

try {
  // --- all four states, one worktree each ------------------------------------------
  {
    const out = json(['ls']);
    const expect = { 'run-one': 'running', 'open-one': 'open', 'claude-one': 'resumable', 'codex-one': 'resumable', 'cold-one': 'cold', tiny: 'cold', sub: 'cold' };
    for (const [name, state] of Object.entries(expect)) assert.equal(stateOf(out, wt(name)), state, `${name}:\n${JSON.stringify(out.worktrees, null, 1)}`);
    assert.equal(stateOf(out, repo), 'cold', 'the main checkout is a worktree too, and it is cold');
    assert.equal(stateOf(out, scratch), 'open', 'a space on no worktree is still listed, keyed off its pane cwd');
    checks++;
    assert.ok(!out.worktrees.some(r => r.path.endsWith('/gone')), 'a prunable worktree (directory gone) is not listed');
    assert.ok(!out.worktrees.some(r => r.path.startsWith(plain)), 'a repo with no worktrees is not listed');
    assert.ok(!out.worktrees.some(r => r.path.includes('datasets')), 'a non-host directory under the root is never walked');
    assert.equal(out.worktrees.length, 9);   // main + 7 live worktrees + the scratch space
    assert.deepEqual(out.states, { running: 1, open: 2, resumable: 2, cold: 4 });
    checks++;
    const claude = out.worktrees.find(r => r.path === wt('claude-one') || realpathSync(r.path) === realpathSync(wt('claude-one'))).resume;
    assert.equal(claude.provider, 'claude');
    assert.equal(claude.id, claudeId);
    assert.match(claude.command, new RegExp(`&& claude --resume ${claudeId}$`));
    const codex = out.worktrees.find(r => realpathSync(r.path) === realpathSync(wt('codex-one'))).resume;
    assert.equal(codex.provider, 'codex');
    assert.equal(codex.id, codexId);
    assert.equal(codex.command, `cd ${wt('codex-one')} && codex resume ${codexId}`);
    checks++;
    // --json keeps its shape: the workspace rows, each now with a state
    assert.equal(out.command, 'ls');
    assert.equal(out.mode, 'workspaces');
    assert.deepEqual(out.workspaces.map(w => [w.id, w.state, w.agents]), [['w1', 'running', 1], ['w2', 'open', 0], ['w3', 'open', 0]]);
    assert.equal(out.workspaces[0].checkout, wt('run-one'));
    assert.deepEqual(out.providers.map(p => [p.name, p.roots]), [['claude', [claudeRoot]], ['codex', [codexRoot]]]);
    assert.ok(readOnly(out.calls), `ls may only read herdr: ${JSON.stringify(out.calls)}`);
    checks++;
    console.log('PASS ls --json: running, open, resumable (claude and codex), cold — worktrees with no open space included');
  }

  // --- filters ----------------------------------------------------------------------
  {
    for (const [args, state] of [[['ls', 'resumable'], 'resumable'], [['ls', '--state', 'cold'], 'cold'], [['list', 'running'], 'running']]) {
      const out = json(args);
      assert.equal(out.state, state);
      assert.ok(out.worktrees.length > 0 && out.worktrees.every(r => r.state === state), `${args.join(' ')}: ${JSON.stringify(out.worktrees)}`);
      assert.ok(out.workspaces.every(w => w.state === state));
      checks++;
    }
    const cold = run(['ls', 'cold']);
    assert.equal(cold.code, 0, cold.err);
    assert.match(cold.out, /Local · · cold/);
    assert.match(cold.out, /cold-one/);
    assert.ok(!cold.out.includes('claude-one') && !cold.out.includes('run-one'), cold.out);
    assert.match(cold.out, /4 cold of 9 worktrees · 1 running · 2 open · 2 resumable · 4 cold/);
    const res = run(['ls', 'resumable', '--path']);
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /◐ claude-one {2}b\/claude-one {2}claude \d+[smhd] ago/);
    assert.match(res.out, /◐ codex-one {2}b\/codex-one {2}codex \d+[smhd] ago/);
    // git spells the path it registered (on macOS, /private/var for /var)
    const lines = res.out.split('\n');
    const under = lines[lines.findIndex(l => l.includes('└─ ◐ codex-one')) + 1];
    assert.match(under, /^ {11}\//, `--path puts the checkout under the row:\n${res.out}`);
    assert.equal(realpathSync(under.trim()), realpathSync(wt('codex-one')));
    assert.match(res.out, /resume the newest \((claude|codex)-one\): cd \S+ && (claude --resume|codex resume) \S+\n$/);
    checks++;
    const plainLs = run(['ls']);
    assert.equal(plainLs.code, 0, plainLs.err);
    assert.match(plainLs.out, /3 workspaces · 2 repos · 2 worktrees · agents: maw herdr ls --agents\n/);
    assert.match(plainLs.out, /9 worktrees · 1 running · 2 open · 2 resumable · 4 cold · list one: maw herdr ls resumable\n/);
    assert.ok(!plainLs.out.includes(repo), 'plain ls still prints no paths');
    checks++;
    console.log('PASS ls <state> / --state <s> filter JSON and the listing; plain ls adds one tally line');
  }

  // --- every provider off: never resumable -----------------------------------------------
  {
    const off = { MAW_HERDR_RESUME_PROVIDERS: 'none' };
    const out = json(['ls'], off);
    assert.equal(stateOf(out, wt('claude-one')), 'cold');
    assert.equal(stateOf(out, wt('codex-one')), 'cold');
    assert.equal(stateOf(out, wt('run-one')), 'running');
    assert.equal(stateOf(out, wt('open-one')), 'open');
    assert.ok(!out.worktrees.some(r => r.state === 'resumable' || r.resume), 'nothing is resumable, and no session is claimed');
    assert.deepEqual(out.states, { running: 1, open: 2, resumable: 0, cold: 6 });
    assert.deepEqual(out.providers, []);
    checks++;
    const plainLs = run(['ls'], off);
    assert.match(plainLs.out, /9 worktrees · 1 running · 2 open · resumable off · 6 cold · no resume provider enabled: MAW_HERDR_RESUME_PROVIDERS=claude,codex maw herdr ls\n/);
    const res = run(['ls', 'resumable'], off);
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /every resume provider is off\n {2}MAW_HERDR_RESUME_PROVIDERS=claude,codex maw herdr ls resumable\n$/);
    checks++;
    // "" is off too; one provider on leaves the other's worktree cold
    assert.equal(json(['ls'], { MAW_HERDR_RESUME_PROVIDERS: '' }).states.resumable, 0);
    const claudeOnly = json(['ls'], { MAW_HERDR_RESUME_PROVIDERS: 'claude' });
    assert.equal(stateOf(claudeOnly, wt('claude-one')), 'resumable');
    assert.equal(stateOf(claudeOnly, wt('codex-one')), 'cold');
    checks++;
    console.log('PASS every provider off: running, open and cold still reported, resumable never claimed; one provider on is just that one');
  }

  // --- configurable roots -------------------------------------------------------------
  {
    // no MAW_HERDR_*_ROOTS: the defaults under HOME, then CLAUDE_CONFIG_DIR / CODEX_HOME
    const noRoots = { MAW_HERDR_CLAUDE_ROOTS: undefined, MAW_HERDR_CODEX_ROOTS: undefined };
    const empty = json(['ls'], noRoots);
    assert.equal(empty.states.resumable, 0);
    assert.deepEqual(empty.providers.map(p => p.roots), [[join(home, '.claude', 'projects')], [join(home, '.codex', 'sessions')]]);
    const moved = json(['ls'], { ...noRoots, CLAUDE_CONFIG_DIR: dirname(claudeRoot), CODEX_HOME: dirname(codexRoot) });
    assert.deepEqual(moved.providers.map(p => p.roots), [[join(temporary, 'projects')], [join(temporary, 'sessions')]]);
    mkdirSync(join(home, '.claude'), { recursive: true });
    symlinkSync(claudeRoot, join(home, '.claude', 'projects'));
    assert.equal(stateOf(json(['ls'], noRoots), wt('claude-one')), 'resumable', 'the default claude root is ~/.claude/projects');
    checks++;
    console.log('PASS provider roots: MAW_HERDR_*_ROOTS, else CLAUDE_CONFIG_DIR / CODEX_HOME, else ~/.claude/projects and ~/.codex/sessions');
  }

  // --- no ghq root: only the repos of open spaces ------------------------------------------
  {
    const out = json(['ls'], { GHQ_ROOT: undefined });
    // the open spaces' repo is still scanned in full, closed worktrees included
    assert.equal(stateOf(out, wt('claude-one')), 'resumable');
    assert.equal(out.worktrees.length, 9);
    checks++;
    console.log('PASS without a ghq root, the repos of open spaces are still scanned whole');
  }

  // --- a document past one pipe buffer arrives whole ---------------------------------
  {
    // Bun cut a single console.log at 65,536 bytes on a pipe; a real machine's
    // worktree list is ~130 KB. spawnSync reads through a pipe, as `| jq` does.
    const long = 'L'.repeat(80_000);
    useSnapshot({ ...snapshot, workspaces: snapshot.workspaces.map(w => (w.workspace_id === 'w3' ? { ...w, label: long } : w)) });
    const r = run(['ls', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.length > 160_000, `expected the whole document, got ${r.out.length} bytes`);
    assert.equal(JSON.parse(r.out).workspaces.find(w => w.id === 'w3').label, long);
    useSnapshot(snapshot);
    checks++;
    console.log('PASS ls --json over 64 KB arrives whole through a pipe');
  }

  // --- errors ----------------------------------------------------------------------------
  {
    const bad = run(['ls'], { MAW_HERDR_RESUME_PROVIDERS: 'claude,gemini' });
    assert.equal(bad.code, 1);
    assert.equal(bad.err, "maw herdr: unknown resume provider 'gemini' in MAW_HERDR_RESUME_PROVIDERS; built in: claude, codex\n  MAW_HERDR_RESUME_PROVIDERS=claude maw herdr ls\n");
    assert.deepEqual(bad.calls, [], 'a bad provider name fails before herdr is asked');
    const state = run(['ls', '--state', 'asleep']);
    assert.equal(state.code, 2);
    assert.equal(state.err, 'maw herdr: --state needs one of running, open, resumable, cold\n  maw herdr ls resumable\n');
    const stray = run(['ls', 'bogus']);
    assert.equal(stray.code, 2);
    assert.equal(stray.err, 'maw herdr: unknown argument: bogus\n  maw herdr ls --help\n');
    const mixed = run(['ls', 'running', '--agents']);
    assert.equal(mixed.code, 2);
    assert.equal(mixed.err, 'maw herdr: unknown argument: --agents\n  maw herdr ls --help\n');
    for (const r of [state, stray, mixed]) assert.deepEqual(r.calls, []);
    checks++;
    const help = run(['ls', 'resumable', '--help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /ls <running\|open\|resumable\|cold>/);
    assert.deepEqual(help.calls, []);
    checks++;
    console.log('PASS bad provider / bad --state / stray words are errors ending in the command that works, zero herdr calls');
  }

  console.log(`ok: ${checks} ls state checks (${entry === join(root, 'index.mjs') ? 'source' : entry})`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
