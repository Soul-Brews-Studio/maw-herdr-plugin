#!/usr/bin/env bun
// #92: real git checkouts, an isolated fake herdr, and the actual CLI process.
// MAW_SCRATCH_ENTRY=<bundle> runs the same checks against a built index.js.
// PATH contains only our fakes and git; no live herdr session can be reached.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(process.env.MAW_SCRATCH_ENTRY || join(root, 'index.mjs'));
const bun = process.versions.bun ? process.execPath : execFileSync('bun', ['-e', 'console.log(process.execPath)'], { encoding: 'utf8' }).trim();
const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'maw-scratch-repos-')));
let checks = 0;

try {
  const bin = join(tmp, 'bin');
  const home = join(tmp, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  symlinkSync(gitBin, join(bin, 'git'));
  const ghq = join(tmp, 'code');
  const env = {
    PATH: bin, HOME: home, GHQ_ROOT: ghq,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    MAW_HERDR_RESUME_PROVIDERS: 'none', MAW_ORACLES_JSON: join(tmp, 'absent.json'),
    HERDR_FED_URL: 'http://127.0.0.1:9',
  };
  const git = (cwd, ...args) => execFileSync(gitBin, [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', cwd, ...args,
  ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const repo = path => {
    mkdirSync(path, { recursive: true });
    git(path, 'init', '-q', '-b', 'main');
    git(path, 'commit', '-q', '--allow-empty', '-m', 'fixture');
    return path;
  };
  const main = repo(join(ghq, 'github.com', 'org', 'alpha'));
  const linked = join(main, 'wt', 'feature-one');
  git(main, 'worktree', 'add', '-q', '-b', 'feature-one', linked);
  const hiddenLinked = join(main, '.cache', 'real-linked');
  git(main, 'worktree', 'add', '-q', '-b', 'real-linked', hiddenLinked);
  const scratch = repo(join(linked, '.tmp', 'scratch-repo'));
  mkdirSync(join(scratch, 'src'));
  const scratchLinked = join(tmp, 'scratch-linked');
  git(scratch, 'worktree', 'add', '-q', '-b', 'scratch-linked', scratchLinked);
  const cache = repo(join(linked, '.cache', 'deep', 'cache-repo'));
  const hidden = repo(join(linked, '.experiment'));
  const mainScratch = repo(join(main, '.fixtures', 'main-scratch'));
  const outside = repo(join(tmp, '.cache', 'intentional'));
  const nested = repo(join(linked, 'examples', 'intentional-nested'));
  const alias = join(tmp, 'scratch-alias');
  symlinkSync(scratch, alias);
  const plain = join(tmp, 'plain');
  mkdirSync(plain);

  const space = (id, label, checkout, repoRoot = checkout, cwd = checkout) => ({
    workspace: {
      workspace_id: id, label,
      ...(repoRoot ? { worktree: {
        checkout_path: checkout, repo_root: repoRoot, repo_key: join(repoRoot, '.git'),
        repo_name: basename(repoRoot), is_linked_worktree: checkout !== repoRoot,
      } } : {}),
    },
    pane: { pane_id: `${id}:p1`, workspace_id: id, cwd, agent: null },
  });
  const kept = [
    space('w1', 'feature-one', linked, main),
    space('w2', 'intentional', outside),
    space('w3', 'intentional-nested', nested),
    space('w4', 'real-linked', hiddenLinked, main),
    space('w5', 'plain', plain, null),
  ];
  const excluded = [
    space('w6', 'feature-one', scratch, scratch, join(scratch, 'src')),
    space('w7', 'cache-repo', cache),
    space('w8', 'experiment', hidden),
    space('w9', 'main-scratch', mainScratch),
    space('wA', 'scratch-alias', alias),
    space('wB', 'scratch-linked', scratchLinked, scratch),
  ];
  const snapshot = join(tmp, 'snapshot.json');
  const useSpaces = spaces => writeFileSync(snapshot, JSON.stringify({
    workspaces: spaces.map(s => s.workspace), panes: spaces.map(s => s.pane),
  }));
  useSpaces([...kept, ...excluded]);
  const callsFile = join(tmp, 'calls.jsonl');
  writeFileSync(callsFile, '');
  const fake = (name, source) => {
    const path = join(bin, name);
    writeFileSync(path, `#!${bun}\n${source}\n`);
    chmodSync(path, 0o700);
  };
  fake('herdr', `
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
const verb = args[0] === '--session' ? args.slice(2) : args;
if (verb.join(' ') === 'session list --json') console.log(JSON.stringify({ sessions: [{ name: 'fixture', running: true }] }));
else if (verb.join(' ') === 'api snapshot') console.log(JSON.stringify({ result: { snapshot: JSON.parse(readFileSync(${JSON.stringify(snapshot)}, 'utf8')) } }));
else if (verb.join(' ') === 'machine list') console.log('[]');
else { console.error('unexpected fake herdr command: ' + JSON.stringify(args)); process.exit(8); }
`);
  fake('ghq', `console.log(${JSON.stringify(ghq)});`);
  const run = (args, cwd = tmp) => {
    const r = spawnSync(bun, [entry, ...args], { env, cwd, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr || r.error}`);
    return r;
  };
  const json = (args, cwd) => JSON.parse(run([...args, '--json'], cwd).stdout);
  const absent = rows => {
    for (const path of [scratch, scratchLinked, cache, hidden, mainScratch, alias]) {
      assert.ok(!rows.some(r => r.path === path), `scratch checkout must not count: ${path}`);
    }
    checks++;
  };

  // Reproduce the exact-label collision before asserting the listing fix.
  const resolved = json(['resolve', 'feature-one']).resolved;
  assert.equal(resolved.path, linked);
  assert.equal(resolved.workspace, 'w1');
  assert.equal(resolved.how, 'exact label');
  checks++;

  const listing = json(['ls']);
  absent(listing.worktrees);
  assert.deepEqual(listing.unreadable, []);
  assert.deepEqual(listing.states, { running: 0, open: 5, resumable: 0, cold: 1 });
  assert.equal(listing.worktrees.length, 6, 'main, two linked checkouts, two intentional repos, plain space');
  assert.deepEqual(listing.workspaces.map(w => w.id).sort(), kept.map(s => s.workspace.workspace_id).sort());
  const targets = json(['resolve', '--list']).targets;
  absent(targets);
  assert.equal(targets.length, 6);
  for (const path of [main, linked, hiddenLinked, outside, nested, plain]) {
    assert.ok(listing.worktrees.some(w => w.path === path), `ls must keep ${path}`);
    assert.ok(targets.some(t => t.path === path), `resolve must keep ${path}`);
  }
  checks++;
  for (const [name, path] of [['intentional', outside], ['intentional-nested', nested], ['real-linked', hiddenLinked], ['plain', plain]]) {
    assert.equal(json(['resolve', name]).resolved.path, path);
    checks++;
  }
  const text = run(['ls', '--path']).stdout;
  assert.ok(!text.includes(scratch) && !text.includes(cache) && !text.includes('scratch-alias'));
  assert.ok(text.includes(outside) && text.includes(nested));
  absent(json(['ls', 'open']).worktrees);
  absent(json(['resolve', '--list'], join(scratch, 'src')).targets);
  assert.equal(json(['resolve', join(scratch, 'src')]).resolved.path, linked, 'a scratch path falls within its fleet checkout, not a scratch repo target');
  checks++;

  // A closed parent still resolves by its directory name; the scratch space
  // must not be reintroduced as an unclaimed row, even with no other spaces.
  useSpaces(excluded);
  const closed = json(['resolve', 'feature-one']).resolved;
  assert.equal(closed.path, linked);
  assert.equal(closed.state, 'closed');
  const scratchOnly = json(['ls']);
  absent(scratchOnly.worktrees);
  assert.deepEqual(scratchOnly.workspaces, []);
  assert.equal(scratchOnly.worktrees.length, 3);
  assert.deepEqual(scratchOnly.states, { running: 0, open: 0, resumable: 0, cold: 3 });
  checks++;

  // A deleted scratch repo still present in the snapshot causes no warning and
  // does not return through either the unclaimed-space or closed-target path.
  useSpaces(excluded.filter(s => s.workspace.workspace_id !== 'wA'));
  rmSync(scratch, { recursive: true, force: true });
  const deleted = run(['ls', '--json']);
  assert.deepEqual(JSON.parse(deleted.stdout).unreadable, []);
  assert.equal(deleted.stderr, '');
  absent(JSON.parse(deleted.stdout).worktrees);
  assert.equal(json(['resolve', 'feature-one']).resolved.path, linked);
  checks++;

  const reads = new Set(['session list --json', 'api snapshot', 'machine list']);
  for (const args of readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse)) {
    assert.ok(reads.has((args[0] === '--session' ? args.slice(2) : args).join(' ')), `read-only scan: ${JSON.stringify(args)}`);
  }
  checks++;
  console.log(`ok: ${checks} scratch-repo checks (${entry === join(root, 'index.mjs') ? 'source' : 'bundle/package'})`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
