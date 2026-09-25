#!/usr/bin/env bun
// The shared target grammar (#59), through the actual CLI process against a fake
// herdr and real Git worktrees. Covers every form — self, path, `.`, pane id, name
// (exact label, repo main worktree, unique substring) — plus the ambiguous and
// not-found cases, --dry everywhere, and hey/peek byte-for-byte against the
// pre-#59 index.mjs from origin/main.
//
// Isolation: PATH is only the fake bin dir plus /usr/bin:/bin, which hold no
// herdr; HOME, HERDR_SOCKET_PATH, HERDR_PANE_ID and HERDR_BIN_PATH are all
// replaced; the fake logs every call and the run fails if anything but a read
// reached it outside the explicit hey-to-the-fake comparison.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TargetError, callerFromEnv, classifyTarget, pickTier, requirePane, resolveTarget, sessionFromSocket, takeDry,
} from '../src/cli/mod.target.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'maw-target-grammar-')));
const runtime = process.execPath;
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.equal(a, b, msg ?? `${JSON.stringify(a)} !== ${JSON.stringify(b)} (check ${checks + 1} at ${new Error().stack.split("\n")[2].trim()})`); checks++; };

try {
  // --- real Git fixtures -------------------------------------------------------
  const ghqRoot = join(tmp, 'ghq');
  const code = join(ghqRoot, 'github.com', 'org');
  mkdirSync(code, { recursive: true });
  const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const repo = (name, linked) => {
    const main = join(code, name);
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'fixture');
    for (const wt of linked) git(main, 'worktree', 'add', '-q', join(main, 'wt', wt), '-b', wt);
    return main;
  };
  const alpha = repo('alpha-oracle', ['feat-one', 'feat-two']);
  const digger = repo('digger-oracle', ['digger-fix']);
  const deltaSrc = repo('delta-src', ['delta-wip']);
  repo('gamma', ['gamma-wip']);   // no open space anywhere: only ghq discovery finds it
  mkdirSync(join(alpha, 'wt', 'feat-one', 'sub'));

  // --- fake herdr + fake ghq ---------------------------------------------------
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  const log = join(tmp, 'calls.jsonl');
  const ws = (id, label, worktree, extra = {}) => ({ workspace_id: id, label, number: 1, pane_count: 1, tab_count: 1, agent_status: 'idle', focused: false, active_tab_id: `${id}:t1`, ...(worktree ? { worktree } : {}), ...extra });
  const wt = (path, repoName, linked, repoRoot) => ({ checkout_path: path, repo_name: repoName, repo_root: repoRoot, is_linked_worktree: linked });
  const pane = (id, cwd, agent, extra = {}) => ({ pane_id: id, workspace_id: id.split(':')[0], tab_id: `${id.split(':')[0]}:t1`, cwd, agent, agent_status: agent ? 'idle' : 'unknown', focused: false, ...extra });
  const snapshots = {
    default: {
      workspaces: [
        ws('wA', 'alpha-oracle', wt(alpha, 'alpha-oracle', false, alpha)),
        ws('wB', 'feat-one', wt(join(alpha, 'wt', 'feat-one'), 'alpha-oracle', true, alpha)),
        ws('wC', 'omp'),
        ws('wD', 'digger-oracle', wt(digger, 'digger-oracle', false, digger)),
        ws('wE', 'delta-main-space', wt(deltaSrc, 'delta', false, deltaSrc)),
        ws('wF', 'delta-wip', wt(join(deltaSrc, 'wt', 'delta-wip'), 'delta', true, deltaSrc)),
      ],
      panes: [
        pane('wA:p1', alpha, 'claude'),
        pane('wB:p1', join(alpha, 'wt', 'feat-one'), 'claude'),
        pane('wB:p2', join(alpha, 'wt', 'feat-one', 'sub'), 'codex'),
        pane('wC:p1', alpha, 'codex'),          // a plain space whose pane borrows alpha's checkout
        pane('wD:p1', digger, null),             // a bare shell
        pane('wE:p1', deltaSrc, 'claude'),
        pane('wF:p1', join(deltaSrc, 'wt', 'delta-wip'), 'claude'),
      ],
      agents: [{ pane_id: 'wE:p1', name: 'deltabot' }],
    },
    side: {
      workspaces: [
        ws('w1', 'digger-fix', wt(join(digger, 'wt', 'digger-fix'), 'digger-oracle', true, digger)),
        ws('wA', 'side-alpha'),
      ],
      panes: [
        pane('w1:p1', join(digger, 'wt', 'digger-fix'), 'claude'),
        pane('wA:p1', tmp, 'codex'),             // same pane id as default's wA:p1
      ],
      agents: [],
    },
  };
  const fake = join(bin, 'herdr');
  writeFileSync(fake, `#!${runtime}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const snaps = ${JSON.stringify(snapshots)};
const session = args[0] === '--session' ? args[1] : 'default';
const rest = args[0] === '--session' ? args.slice(2) : args;
const verb = rest.slice(0, 2).join(' ');
if (verb === 'session list') console.log(JSON.stringify({ sessions: [{ name: 'default', running: true, default: true }, { name: 'side', running: true }, { name: 'dead', running: false }] }));
else if (verb === 'api snapshot') console.log(JSON.stringify({ id: 1, result: { snapshot: snaps[session] } }));
else if (verb === 'pane read') process.stdout.write('fake viewport of ' + rest[2] + '\\n');
else if (verb === 'agent prompt') console.log('{"ok":true}');
else if (verb === 'machine list') process.exit(0);
else { console.error('fake herdr: unexpected', JSON.stringify(args)); process.exit(8); }
`);
  chmodSync(fake, 0o700);
  writeFileSync(join(bin, 'ghq'), `#!/bin/sh\n[ "$1" = root ] && echo ${JSON.stringify(ghqRoot)}\n`);
  chmodSync(join(bin, 'ghq'), 0o700);

  const home = join(tmp, 'home');
  mkdirSync(join(home, '.config', 'herdr', 'sessions', 'side'), { recursive: true });
  const defaultSock = join(home, '.config', 'herdr', 'herdr.sock');
  const sideSock = join(home, '.config', 'herdr', 'sessions', 'side', 'herdr.sock');
  const baseEnv = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: home, GIT_CONFIG_NOSYSTEM: '1',
    HERDR_BIN_PATH: fake, HERDR_FED_URL: 'http://127.0.0.1:9', NO_COLOR: '1',
  };
  const cli = (entry, args, { pane: paneId, socket = defaultSock, cwd = tmp } = {}) => {
    const env = { ...baseEnv, ...(paneId ? { HERDR_PANE_ID: paneId, HERDR_SOCKET_PATH: socket } : {}) };
    const r = spawnSync(runtime, [entry, ...args], { cwd, env, encoding: 'utf8', timeout: 30_000 });
    return { rc: r.status, out: r.stdout, err: r.stderr };
  };
  const entry = process.env.MAW_TARGET_ENTRY || join(root, 'index.mjs');   // or the bundle
  const run = (args, opts) => cli(entry, args, opts);
  const json = (args, opts) => { const r = run([...args, '--json'], opts); eq(r.rc, 0, `${args.join(' ')} --json: ${r.err}`); return JSON.parse(r.out).resolved; };
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const READS = new Set(['session list', 'api snapshot', 'pane read', 'machine list']);
  const verbOf = a => (a[0] === '--session' ? a.slice(2) : a).slice(0, 2).join(' ');

  // --- pure module checks ------------------------------------------------------
  eq(classifyTarget(undefined).form, 'self');
  eq(classifyTarget('self').form, 'self');
  for (const p of ['.', '..', '/abs', './x', '../x', '~', '~/x']) eq(classifyTarget(p).form, 'path', p);
  for (const p of ['w5D:p1', 'wD:pS', 'w1:p9']) eq(classifyTarget(p).form, 'pane', p);
  for (const n of ['digger-oracle', 'w5D', 'node:w5D:p1', 'selfish']) eq(classifyTarget(n).form, 'name', n);
  eq(sessionFromSocket(defaultSock), 'default');
  eq(sessionFromSocket(sideSock), 'side');
  eq(sessionFromSocket('/elsewhere/x.sock'), null);
  eq(callerFromEnv({}), null);
  assert.deepEqual(callerFromEnv({ HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: sideSock }), { pane: 'w1:p1', session: 'side' }); checks++;
  { const a = ['x', '--dry', 'y', '--dry-run']; eq(takeDry(a), true); assert.deepEqual(a, ['x', 'y']); checks++; }
  { const a = ['x']; eq(takeDry(a), false); }
  eq(pickTier([1, 2, 3], [['none', () => false], ['two', n => n === 2]]).how, 'two');
  eq(pickTier([1], [['none', () => false]]), null);
  assert.throws(() => pickTier([1, 2], [['all', () => true]], { ambiguous: h => new TargetError(`${h.length}`, 'ambiguous', h) }), e => e.code === 'ambiguous' && e.candidates.length === 2); checks++;

  // --- self --------------------------------------------------------------------
  let r = json(['resolve', 'self'], { pane: 'wB:p2' });
  eq(r.label, 'feat-one'); eq(r.pane, 'wB:p2'); eq(r.agent, 'codex'); eq(r.how, 'self'); eq(r.form, 'self');
  r = json(['resolve'], { pane: 'wB:p2' });
  eq(r.label, 'feat-one', 'no target means self');
  r = json(['resolve'], { pane: 'wA:p1', socket: sideSock });
  eq(r.label, 'side-alpha', 'the socket picks the session a colliding pane id belongs to'); eq(r.session, 'side');
  r = json(['resolve'], { pane: 'wA:p1' });
  eq(r.label, 'alpha-oracle'); eq(r.session, 'default');
  let x = run(['resolve']);
  eq(x.rc, 1, 'self outside a herdr pane fails');
  ok(x.err.includes('HERDR_PANE_ID is not set') && x.err.includes(`maw herdr resolve ${tmp}`), `self error names the real fix: ${x.err}`);
  x = run(['resolve'], { pane: 'wZ:p9' });
  eq(x.rc, 1); ok(x.err.includes('wZ:p9') && x.err.includes('maw herdr ls --agents'), x.err);

  // --- path and . --------------------------------------------------------------
  r = json(['resolve', join(alpha, 'wt', 'feat-two')]);
  eq(r.label, 'feat-two'); eq(r.state, 'closed'); eq(r.how, 'path'); eq(r.pane, null); eq(r.branch, 'feat-two'); eq(r.linked, true);
  r = json(['resolve', '.'], { cwd: join(alpha, 'wt', 'feat-one', 'sub') });
  eq(r.label, 'feat-one', '. inside a linked worktree is that worktree, not its main checkout'); eq(r.how, 'path, inside');
  r = json(['resolve', alpha]);
  eq(r.label, 'alpha-oracle', 'a worktree beats a plain space sitting in the same directory'); eq(r.kind, 'worktree');
  r = json(['resolve', `${alpha}/`]);
  eq(r.label, 'alpha-oracle', 'a trailing slash is the same path');
  r = json(['resolve', '../feat-two'], { cwd: join(alpha, 'wt', 'feat-one') });
  eq(r.label, 'feat-two', 'relative paths resolve against the cwd');
  x = run(['resolve', join(tmp, 'nowhere')]);
  eq(x.rc, 1); ok(x.err.includes('maw herdr resolve --list'), x.err);

  // --- pane id -----------------------------------------------------------------
  r = json(['resolve', 'wD:p1']);
  eq(r.label, 'digger-oracle'); eq(r.pane, 'wD:p1'); eq(r.agent, null); eq(r.how, 'pane id');
  x = run(['resolve', 'wA:p1']);
  eq(x.rc, 1, 'a pane id held in two sessions is ambiguous'); eq(x.out, '', 'ambiguity does nothing');
  ok(x.err.includes('matches 2') && x.err.includes(`maw herdr resolve --session default wA:p1`) && x.err.includes('maw herdr resolve --session side wA:p1'), x.err);
  r = json(['resolve', 'wA:p1', '--session', 'side']);
  eq(r.label, 'side-alpha');
  x = run(['resolve', 'wA:p1', '--session', 'dead']);
  eq(x.rc, 1); ok(x.err.includes('maw herdr ls --sessions'), x.err);

  // --- names -------------------------------------------------------------------
  r = json(['resolve', 'feat-one']);
  eq(r.how, 'exact label'); eq(r.paneChoices?.join(','), 'wB:p1,wB:p2', 'two agents, none focused: no pane is guessed'); eq(r.pane, null);
  r = json(['resolve', 'FEAT-ONE']);
  eq(r.label, 'feat-one', 'names are case-insensitive');
  r = json(['resolve', 'delta']);
  eq(r.label, 'delta-main-space', 'a repo name means its main worktree'); eq(r.how, 'repo main worktree');
  r = json(['resolve', 'gamma-w']);
  eq(r.label, 'gamma-wip', 'unique substring; found through ghq with no open space'); eq(r.how, 'substring'); eq(r.state, 'closed');
  r = json(['resolve', 'omp']);
  eq(r.kind, 'space'); eq(r.pane, 'wC:p1');
  r = json(['resolve', 'digger-fix']);
  eq(r.session, 'side');
  x = run(['resolve', 'feat']);
  eq(x.rc, 1, 'an ambiguous name exits non-zero'); eq(x.out, '');
  ok(x.err.includes("'feat' matches 2 worktrees") && x.err.includes(`maw herdr resolve ${join(alpha, 'wt', 'feat-one')}`) && x.err.includes(`maw herdr resolve ${join(alpha, 'wt', 'feat-two')}`), x.err);
  x = run(['resolve', 'zzz-nothing']);
  eq(x.rc, 1); ok(x.err.includes("no worktree matches 'zzz-nothing'") && x.err.includes('maw herdr resolve --list'), x.err);

  // --- --dry, --list, usage ----------------------------------------------------
  const plain = run(['resolve', 'omp']);
  const dry = run(['resolve', 'omp', '--dry']);
  eq(plain.rc, 0); eq(dry.out, plain.out, '--dry is accepted and changes nothing for a read');
  ok(plain.out.includes('matched by exact label'), plain.out);
  x = run(['resolve', '--list', '--json']);
  eq(x.rc, 0);
  const all = JSON.parse(x.out).targets;
  ok(all.some(t => t.label === 'gamma-wip' && t.state === 'closed') && all.some(t => t.label === 'side-alpha'), 'list holds open and closed targets');
  eq(all.filter(t => t.path === join(alpha, 'wt', 'feat-one')).length, 1, 'an open worktree is not listed again as closed');
  eq(run(['resolve', 'a', 'b']).rc, 2, 'two targets is a usage error');
  eq(run(['resolve', '--bogus']).rc, 2);

  // requirePane is what lifecycle verbs call before acting
  const loaded = JSON.parse(run(['resolve', '--list', '--json']).out).targets;
  const feat = resolveTarget(loaded, 'feat-one', { caller: null, cwd: tmp, verb: 'restart' });
  assert.throws(() => requirePane(feat, 'restart'), e => e.code === 'ambiguous' && e.message.includes('maw herdr restart --session default wB:p1') && e.message.includes('maw herdr restart --session default wB:p2')); checks++;
  const closed = resolveTarget(loaded, 'feat-two', { caller: null, cwd: tmp, verb: 'restart' });
  assert.throws(() => requirePane(closed, 'restart'), e => e.code === 'not-found' && e.message.includes(`herdr workspace create --cwd ${join(alpha, 'wt', 'feat-two')} --label feat-two`)); checks++;
  eq(requirePane(resolveTarget(loaded, 'alpha-oracle', { caller: null, cwd: tmp }), 'restart'), 'wA:p1');

  const beforeHey = calls();
  const mutating = beforeHey.filter(a => !READS.has(verbOf(a)));
  eq(mutating.length, 0, `resolve only ever read from herdr: ${JSON.stringify(mutating)}`);

  // --- hey / peek: byte-for-byte against origin/main ---------------------------
  let original;
  try {
    original = execFileSync('git', ['-C', root, 'show', 'origin/main:index.mjs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    original = null;
  }
  let compared = 0;
  if (original && !original.includes("src/cli/mod.target.mjs")) {
    const old = join(tmp, 'old');
    mkdirSync(old);
    writeFileSync(join(old, 'index.mjs'), original);
    symlinkSync(join(root, 'src'), join(old, 'src'));
    const cases = [
      ['peek', 'feat-one'],                          // two agent panes, none focused: legacy ambiguity text
      ['peek', 'alpha-oracle'],
      ['peek', 'alpha-oracle', '--json', '--lines', '5'],
      ['peek', 'wA:p1'],                             // one pane id in two sessions
      ['peek', 'wA:p1', '--session', 'side'],
      ['peek', 'deltabot'],                          // agent name tier
      ['peek', 'delta'],                             // prefix tier: two workspaces
      ['peek', 'mp'],                                // substring tier
      ['peek', 'nothing-here'],
      ['peek'],
      ['peek', 'omp', '--lines', '0'],
      ['peek', 'omp', '--session', 'dead'],
      ['hey'],
      ['hey', 'omp'],
      ['hey', 'feat-one', 'hello', '--dry-run'],
      ['hey', 'omp', 'hello', 'there', '--dry-run'],
      ['hey', 'nothing-here', 'hi'],
      ['hey', 'omp', 'a real prompt to the fake'],
    ];
    for (const c of cases) {
      const a = cli(join(old, 'index.mjs'), c), b = run(c);
      assert.deepEqual(b, a, `hey/peek changed for: ${c.join(' ')}`);
      checks++; compared++;
    }
    // The comparison is only worth something if the cases exercise real paths.
    const seen = c => run(c);
    x = seen(['peek', 'alpha-oracle']); eq(x.rc, 0); ok(x.out.includes('fake viewport of wA:p1'), x.out);
    x = seen(['peek', 'feat-one']); eq(x.rc, 1); ok(x.err.includes("'feat-one' matches 2 agent panes and none is focused") && x.err.includes('maw herdr peek wB:p1'), x.err);
    x = seen(['peek', 'deltabot']); eq(x.rc, 0); ok(x.out.includes('fake viewport of wE:p1'), x.out);
    x = seen(['peek', 'nothing-here']); eq(x.rc, 1); ok(x.err.includes("no agent 'nothing-here'"), x.err);
    x = seen(['peek']); eq(x.rc, 2, 'a missing target stays a usage error');
    x = seen(['hey', 'omp', 'hello', '--dry-run']); eq(x.rc, 0); ok(x.out.includes('agent prompt wC:p1') && x.out.includes('nothing was sent'), x.out);
    // --dry is the same flag as --dry-run for hey
    assert.deepEqual(run(['hey', 'omp', 'hello', '--dry']), cli(join(old, 'index.mjs'), ['hey', 'omp', 'hello', '--dry-run'])); checks++; compared++;
  } else {
    console.log('SKIP: origin/main already carries the shared resolver; byte-for-byte hey/peek comparison skipped');
  }

  // --- hey / peek: the new forms -----------------------------------------------
  x = run(['peek', 'self', '--dry'], { pane: 'wC:p1' });
  eq(x.rc, 0); ok(x.out.includes('wC:p1') && x.out.includes('matched by self') && x.out.includes('nothing was read'), x.out);
  x = run(['peek', 'self', '--dry', '--json'], { pane: 'wA:p1', socket: sideSock });
  eq(JSON.parse(x.out).session, 'side');
  x = run(['hey', 'self', 'hi', '--dry'], { pane: 'wE:p1' });
  eq(x.rc, 0); ok(x.out.includes('wE:p1') && x.out.includes('nothing was sent'), x.out);
  x = run(['peek', 'self']);
  eq(x.rc, 1); ok(x.err.includes('HERDR_PANE_ID is not set'), x.err);
  x = run(['peek', 'self'], { pane: 'wD:p1' });
  eq(x.rc, 1, 'self on a bare shell has no agent to peek'); ok(x.err.includes('holds no agent') && x.err.includes('maw herdr ls --agents'), x.err);
  x = run(['peek', join(deltaSrc, 'wt', 'delta-wip'), '--dry']);
  eq(x.rc, 0); ok(x.out.includes('wF:p1') && x.out.includes('matched by path'), x.out);
  x = run(['peek', '.', '--dry'], { cwd: join(alpha, 'wt', 'feat-one', 'sub') });
  eq(x.rc, 0); ok(x.out.includes('wB:p2') && x.out.includes('matched by path'), x.out);
  const readsBefore = calls().filter(a => verbOf(a) === 'pane read').length;
  x = run(['peek', 'omp', '--dry']);
  eq(calls().filter(a => verbOf(a) === 'pane read').length, readsBefore, 'peek --dry reads nothing');

  // Nothing but reads, plus the one explicit prompt to the fake in the comparison.
  const writes = calls().filter(a => !READS.has(verbOf(a)));
  ok(writes.every(a => verbOf(a) === 'agent prompt' && a.includes('a real prompt to the fake')), `only the expected prompt reached herdr: ${JSON.stringify(writes)}`);
  eq(writes.length, compared ? 2 : 0, 'one prompt from each implementation');

  console.log(`PASS target grammar: ${checks} assertions — self (env + socket session), path/./relative/inside, pane id (+cross-session ambiguity), exact label / repo main / substring, ambiguity lists and exits 1, --dry, --list, requirePane; hey/peek identical to origin/main on ${compared} cases`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
