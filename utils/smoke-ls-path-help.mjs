#!/usr/bin/env node
// `ls --path` layout and `--help`/`-h` on every verb (#56), against the actual
// CLI process and an isolated fake Herdr first (and only) on PATH. The fake
// logs every call, so "help runs nothing" is checked, not assumed.
// MAW_LS_ENTRY=<bundle> runs the same checks against a built index.js.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(process.env.MAW_LS_ENTRY || join(root, 'index.mjs'));
const bun = process.versions.bun ? process.execPath : spawnSync('bun', ['-e', 'console.log(process.execPath)'], { encoding: 'utf8' }).stdout.trim();
assert.ok(bun && existsSync(bun), 'bun is required: curl -fsSL https://bun.sh/install | bash');

const temporary = mkdtempSync(join(tmpdir(), 'maw-herdr-ls-path-'));
const bin = join(temporary, 'bin');
const log = join(temporary, 'calls.jsonl');
mkdirSync(bin);
mkdirSync(join(temporary, 'home'));

const repo = join(temporary, 'code', 'alpha');
const snapshot = {
  workspaces: [
    { workspace_id: 'w1', label: 'alpha', worktree: { repo_name: 'alpha', checkout_path: repo, is_linked_worktree: false } },
    { workspace_id: 'w2', label: 'fix-one', worktree: { repo_name: 'alpha', checkout_path: join(repo, 'wt', 'fix-one'), is_linked_worktree: true } },
    { workspace_id: 'w3', label: 'fix-two', worktree: { repo_name: 'alpha', checkout_path: join(repo, 'wt', 'fix-two'), is_linked_worktree: true } },
    { workspace_id: 'w4', label: 'scratch' },   // no worktree block: path from the pane's cwd
    { workspace_id: 'w5', label: 'orphan' },    // no worktree block, no pane: no path at all
  ],
  panes: [
    { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', cwd: repo },
    { pane_id: 'w4:p1', workspace_id: 'w4', agent: null, cwd: join(temporary, 'scratch') },
  ],
};
writeFileSync(join(bin, 'herdr'), `#!${bun}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const verb = args[0] === '--session' ? args.slice(2) : args;
if (verb.join(' ') === 'session list --json') console.log(JSON.stringify({ sessions: [{ name: 'default', running: true, default: true }] }));
else if (verb.join(' ') === 'api snapshot') console.log(JSON.stringify({ result: { snapshot: ${JSON.stringify(snapshot)} } }));
else if (verb[0] === 'agent' && verb[1] === 'prompt') console.log('{"ok":true}');
else if (verb[0] === 'machine') process.exit(1);
else { console.error('fake herdr: unexpected', args); process.exit(8); }
`);
chmodSync(join(bin, 'herdr'), 0o700);

// PATH holds the fake and nothing else: no real herdr, no git, no maw.
// HERDR_FED_URL points at a closed port so no federation node is ever reached.
const env = { PATH: bin, HOME: join(temporary, 'home'), HERDR_FED_URL: 'http://127.0.0.1:9', MAW_ORACLES_JSON: join(temporary, 'absent.json') };
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const run = (...args) => {
  rmSync(log, { force: true });
  const r = spawnSync(bun, [entry, ...args], { env, cwd: temporary, encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, out: r.stdout, err: r.stderr, calls: calls() };
};
let checks = 0;
const USAGE = 'maw herdr <ls|';

try {
  // --- ls --path --------------------------------------------------------------
  {
    const r = run('ls', '--path');
    assert.equal(r.code, 0, r.err);
    const lines = r.out.split('\n');
    const at = text => lines.findIndex(l => l.includes(text));
    const expect = (row, path) => {
      const i = at(row);
      assert.ok(i >= 0, `row ${row} missing:\n${r.out}`);
      assert.equal(lines[i + 1], path, `line under ${row}`);
    };
    expect(' alpha  ', `      ${repo}`);
    expect('├─ ○ fix-one', `      │    ${join(repo, 'wt', 'fix-one')}`);
    expect('└─ ○ fix-two', `           ${join(repo, 'wt', 'fix-two')}`);
    expect(' scratch  ', `      ${join(temporary, 'scratch')}`);
    expect(' orphan  ', '      (no checkout path)');
    checks++;
    // the path sits at the label's column, so the tree still reads as a tree
    assert.equal(lines[at('fix-one') + 1].indexOf('/'), lines[at('fix-one')].indexOf('fix-one'));
    assert.equal(lines[at(' alpha  ') + 1].indexOf('/'), lines[at(' alpha  ')].indexOf('alpha'));
    checks++;
    console.log('PASS ls --path: absolute checkout under each row, label-aligned, tree rule continues, missing path said');
  }
  {
    const r = run('ls');
    assert.equal(r.code, 0, r.err);
    assert.ok(!r.out.includes(repo), 'plain ls must not print paths');
    const j = run('ls', '--json', '--path');
    assert.equal(j.code, 0, j.err);
    const out = JSON.parse(j.out);
    assert.equal(out.workspaces.find(w => w.label === 'fix-one').checkout, join(repo, 'wt', 'fix-one'));
    assert.equal(out.workspaces.find(w => w.label === 'orphan').checkout, null);
    checks++;
    console.log('PASS ls without --path is unchanged; --json --path is plain --json');
  }
  for (const mode of ['--agents', '--sessions', '--federation']) {
    const r = run('ls', mode, '--path');
    assert.equal(r.code, 2);
    assert.match(r.err, new RegExp(`--path applies to the workspace listing, not ${mode}\\n  maw herdr ls --path\\n$`));
    assert.equal(r.calls.length, 0);
    checks++;
  }
  console.log('PASS ls --path with another mode is a usage error ending in the command that works');

  // --- --help / -h on every verb ------------------------------------------------
  const asks = [
    ['ls'], ['list'], ['ls', '--agents'], ['a'], ['attach', 'default'], ['wake'], ['wake', 'alpha', '--dry-run'],
    ['hey'], ['hey', 'alpha'], ['hey', 'alpha', '--dry-run'], ['hey', '--session', 'default', 'alpha'],
    ['peek', 'alpha'], ['read'], ['peek', 'alpha', '--lines', '5'], ['federation'], ['fed'],
  ];
  for (const argv of asks) {
    for (const flag of ['--help', '-h']) {
      const r = run(...argv, flag);
      assert.equal(r.code, 0, `${argv.join(' ')} ${flag}: ${r.err}`);
      assert.ok(r.out.startsWith(USAGE), `${argv.join(' ')} ${flag} printed:\n${r.out}`);
      assert.equal(r.err, '');
      assert.deepEqual(r.calls, [], `${argv.join(' ')} ${flag} must not call herdr`);
      checks++;
    }
  }
  console.log(`PASS --help and -h print the usage on ${asks.length} verb shapes, exit 0, and call herdr zero times`);

  {
    const r = run('serve', '--help');
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.startsWith('maw herdr serve --token-file'), 'serve keeps its own help');
    assert.deepEqual(r.calls, []);
    checks++;
    console.log('PASS serve --help keeps its own, more specific usage');
  }

  // A message may say "-h". hey sends it; it is not a help request.
  {
    const r = run('hey', 'alpha', 'why', 'does', '-h', 'fail');
    assert.equal(r.code, 0, r.err);
    assert.ok(!r.out.startsWith(USAGE));
    const prompt = r.calls.find(c => c.includes('prompt'));
    assert.deepEqual(prompt, ['--session', 'default', 'agent', 'prompt', 'w1:p1', 'why does -h fail']);
    checks++;
    console.log('PASS hey <target> <message containing -h> still sends the message (fake herdr)');
  }
  // A flag value may be "-h": wake --prompt -h is a prompt, not a help request.
  {
    const r = run('wake', 'alpha', '--dry-run', '--prompt', '-h');
    assert.ok(!r.out.startsWith(USAGE), 'wake --prompt -h must not print usage');
    assert.notEqual(r.code, 0, 'no registry here, so wake fails on the oracle, past argument parsing');
    assert.ok(!r.calls.some(c => c.includes('create') || c.includes('start')), 'wake must not create anything');
    checks++;
    console.log('PASS wake --prompt -h treats -h as the prompt value');
  }

  // --- usage errors carry the fix -----------------------------------------------
  {
    const r = run('ls', '-v');
    assert.equal(r.code, 2);
    assert.equal(r.err, 'maw herdr: unknown argument: -v\n  maw herdr ls --help\n');
    const followed = run('ls', '--help');
    assert.equal(followed.code, 0);
    const u = run('bogus');
    assert.equal(u.code, 2);
    assert.equal(u.err, 'maw herdr: unknown command: bogus\n  maw herdr help\n');
    // an error that already names its fix is not given a second one
    const own = run('hey');
    assert.equal(own.code, 2);
    assert.ok(own.err.endsWith('\n  across the federation: maw herdr hey <node>:<pane> "…"\n'), own.err);
    assert.ok(!own.err.includes('maw herdr hey --help'), own.err);
    // a one-line usage error gets the fix line appended
    const bare = run('hey', 'alpha');
    assert.equal(bare.code, 2);
    assert.equal(bare.err, 'maw herdr: hey needs a message: maw herdr hey alpha "<message>"\n  maw herdr hey --help\n');
    checks++;
    console.log('PASS usage errors end with a runnable command: <verb> --help, or help for an unknown verb');
  }

  console.log(`ok: ${checks} ls --path / --help checks (${entry === join(root, 'index.mjs') ? 'source' : entry})`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
