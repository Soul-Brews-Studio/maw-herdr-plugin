#!/usr/bin/env bun
// The shared target grammar (#59), through the actual CLI process against a fake
// herdr and real Git worktrees. Covers every form — self, path, `.`, pane id, name
// (exact label, repo main worktree, unique substring) — plus the ambiguous and
// not-found cases, --dry everywhere, and hey/peek byte-for-byte against the
// pre-#59 index.mjs (commit 2001b9b), recorded in utils/target-grammar-legacy.json
// so the comparison can never skip — not after merge, not in a shallow CI clone.
// Re-record after changing the fixture below (needs 2001b9b in the local repo):
//   bun utils/smoke-target-grammar.mjs --record
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
  const gamma = repo('gamma', ['gamma-wip']);   // no open space anywhere: only ghq discovery finds it
  git(gamma, 'worktree', 'add', '-q', join(gamma, 'wt', 'gamma wip2'), '-b', 'gamma-wip2');   // a path with a space
  git(gamma, 'worktree', 'add', '-q', join(gamma, 'wt', 'gone-wt'), '-b', 'gone-wt');
  rmSync(join(gamma, 'wt', 'gone-wt'), { recursive: true, force: true });                  // prunable: directory gone
  const beta = repo('beta', ['omega-one', 'omega-two']);   // agents only in linked worktrees, none in main
  mkdirSync(join(alpha, 'wt', 'feat-one', 'sub'));
  mkdirSync(join(deltaSrc, 'wt', 'delta-wip', 'src'));
  mkdirSync(join(tmp, 'scratch'));
  mkdirSync(join(tmp, 'home', 'proj'), { recursive: true });

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
        ws('wG', 'omega-one', wt(join(beta, 'wt', 'omega-one'), 'beta', true, beta)),
        ws('wH', 'omega-two', wt(join(beta, 'wt', 'omega-two'), 'beta', true, beta)),
        ws('wI', 'selfcheck-oracle'),            // a label that contains "self"
        ws('wJ', 'white.local'),                 // a label that contains "."
      ],
      panes: [
        pane('wA:p1', alpha, 'claude'),
        pane('wB:p1', join(alpha, 'wt', 'feat-one'), 'claude'),
        pane('wB:p2', join(alpha, 'wt', 'feat-one', 'sub'), 'codex'),
        pane('wC:p1', alpha, 'codex'),          // a plain space whose pane borrows alpha's checkout
        pane('wD:p1', digger, null),             // a bare shell
        pane('wE:p1', deltaSrc, 'claude'),
        pane('wF:p1', join(deltaSrc, 'wt', 'delta-wip'), 'claude'),
        pane('wG:p1', join(beta, 'wt', 'omega-one'), 'claude'),
        pane('wH:p1', join(beta, 'wt', 'omega-two'), 'claude'),
        pane('wI:p1', join(tmp, 'scratch'), 'codex'),
        pane('wJ:p1', join(tmp, 'home', 'proj'), 'claude', { focused: true }),   // the one pane the operator looks at
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
        pane('wA:p1', tmp, 'codex', { focused: true }),   // same pane id as default's wA:p1, and focused
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
const weird = process.env.FAKE_WEIRD === '1';
if (weird) snaps.weird = { workspaces: 'not-an-array', panes: 5 };
const session = args[0] === '--session' ? args[1] : 'default';
const rest = args[0] === '--session' ? args.slice(2) : args;
const verb = rest.slice(0, 2).join(' ');
if (verb === 'session list') console.log(JSON.stringify({ sessions: [{ name: 'default', running: true, default: true }, { name: 'side', running: true }, { name: 'dead', running: false }, ...(weird ? [{ name: 'weird', running: true }] : [])] }));
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
  const cli = (entry, args, { pane: paneId, socket = defaultSock, cwd = tmp, env: extra = {} } = {}) => {
    const env = { ...baseEnv, ...(paneId ? { HERDR_PANE_ID: paneId, HERDR_SOCKET_PATH: socket } : {}), ...extra };
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

  // --- hey / peek: byte-for-byte against the pre-#59 index.mjs -----------------
  // Recorded from commit LEGACY_REF (main + #56 on the integration branch, so the
  // `<verb> --help` fix line #56 adds is baseline) against this exact fixture, with the temp
  // dir normalised to <TMP>. The case list must match the recording, so editing a
  // case without re-recording fails here instead of silently comparing less.
  const LEGACY_REF = '4c30beb9eb1d2161f344468f1ecd74e6e61cccd6';
  const FIXTURE = join(root, 'utils', 'target-grammar-legacy.json');
  const norm = res => JSON.parse(JSON.stringify(res).split(tmp).join('<TMP>'));
  const cases = [
    ['peek', 'feat-one'],                          // two agent panes in ONE workspace, none focused
    ['peek', 'alpha-oracle'],
    ['peek', 'alpha-oracle', '--json', '--lines', '5'],
    ['peek', 'wA:p1', '--session', 'side'],
    ['peek', 'deltabot'],                          // agent name tier
    ['peek', 'delta'],                             // prefix tier: two workspaces, none focused
    ['peek', 'om'],                                // prefix tier: three workspaces, none focused
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
  let compared = 0;
  if (process.argv.includes('--record')) {
    let original;
    try {
      original = execFileSync('git', ['-C', root, 'show', `${LEGACY_REF}:index.mjs`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      throw new Error(`--record needs commit ${LEGACY_REF} in this repo\n  git -C ${root} fetch origin main`);
    }
    const old = join(tmp, 'old');
    mkdirSync(old);
    writeFileSync(join(old, 'index.mjs'), original);
    symlinkSync(join(root, 'src'), join(old, 'src'));
    const recorded = cases.map(args => ({ args, ...norm(cli(join(old, 'index.mjs'), args)) }));
    writeFileSync(FIXTURE, `${JSON.stringify({ ref: LEGACY_REF, cases: recorded }, null, 2)}\n`);
    console.log(`recorded ${recorded.length} cases from ${LEGACY_REF.slice(0, 7)} into ${FIXTURE}`);
    rmSync(tmp, { recursive: true, force: true });   // process.exit skips the finally below
    process.exit(0);
  }
  const legacy = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  eq(legacy.ref, LEGACY_REF);
  assert.deepEqual(legacy.cases.map(c => c.args), cases, `the case list changed; re-record: bun utils/smoke-target-grammar.mjs --record`); checks++;
  for (const c of legacy.cases) {
    const { args, ...want } = c;
    assert.deepEqual(norm(run(args)), want, `hey/peek changed for: ${args.join(' ')}`);
    checks++; compared++;
  }
  // --dry is the same flag as --dry-run for hey
  assert.deepEqual(norm(run(['hey', 'omp', 'hello', 'there', '--dry'])), (({ args, ...w }) => w)(legacy.cases.find(c => c.args.join(' ') === 'hey omp hello there --dry-run'))); checks++; compared++;
  // The comparison is only worth something if the cases exercise real paths.
  x = run(['peek', 'alpha-oracle']); eq(x.rc, 0); ok(x.out.includes('fake viewport of wA:p1'), x.out);
  x = run(['peek', 'feat-one']); eq(x.rc, 1); ok(x.err.includes("'feat-one' matches 2 agent panes and none is focused") && x.err.includes('maw herdr peek wB:p1'), x.err);
  x = run(['peek', 'deltabot']); eq(x.rc, 0); ok(x.out.includes('fake viewport of wE:p1'), x.out);
  x = run(['peek', 'nothing-here']); eq(x.rc, 1); ok(x.err.includes("no agent 'nothing-here'"), x.err);
  x = run(['peek']); eq(x.rc, 2, 'a missing target stays a usage error');
  x = run(['hey', 'omp', 'hello', '--dry-run']); eq(x.rc, 0); ok(x.out.includes('agent prompt wC:p1') && x.out.includes('nothing was sent'), x.out);

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

  // --- review regressions: each of these picked a pane it must not pick --------
  // Collected rather than thrown one at a time, so a run shows every one at once.
  const fails = [];
  const check = (name, fn) => { try { fn(); } catch (e) { fails.push(`  ✗ ${name}\n      ${String(e.message).split('\n').slice(0, 3).join('\n      ')}`); } checks++; };
  const noPick = r => !r.out.includes('would run') && !r.out.includes('"dry":true');

  // self and path never fall through to substring matching
  check('hey self from a bare shell does not substring-match a "selfcheck" workspace', () => {
    const r = run(['hey', 'self', 'hi', '--dry'], { pane: 'wD:p1' });
    eq(r.rc, 1, r.out); ok(noPick(r) && r.err.includes('holds no agent'), r.err);
  });
  check('peek . from a directory with no agent does not substring-match "white.local"', () => {
    const r = run(['peek', '.', '--dry'], { cwd: join(tmp, 'home') });
    eq(r.rc, 1, r.out); ok(noPick(r) && r.err.includes(`maw herdr resolve ${join(tmp, 'home')}`), r.err);
  });
  // a path means the worktree CONTAINING it, never agents below it
  check('hey <main checkout> does not reach agents in its linked worktrees', () => {
    const r = run(['hey', beta, 'hi', '--dry']);
    eq(r.rc, 1, r.out); ok(noPick(r) && !r.err.includes('wG:p1 ') && r.err.includes(`maw herdr resolve ${beta}`), r.err);
  });
  check('hey . from a main checkout does not reach a linked worktree agent', () => {
    const r = run(['hey', '.', 'hi', '--dry'], { cwd: beta });
    eq(r.rc, 1, r.out); ok(noPick(r), r.out);
  });
  check('hey ~ does not pick the focused pane under $HOME', () => {
    const r = run(['hey', '~', 'hi', '--dry', '--session', 'default']);
    eq(r.rc, 1, r.out); ok(noPick(r) && !r.out.includes('wJ:p1'), r.out);
  });
  check('peek . from a subdirectory finds the agent at the worktree root', () => {
    const r = run(['peek', '.', '--dry'], { cwd: join(deltaSrc, 'wt', 'delta-wip', 'src') });
    eq(r.rc, 0, r.err); ok(r.out.includes('wF:p1') && r.out.includes('matched by path, worktree'), r.out);
  });
  check('hey <worktree>/src reaches that worktree\'s agent', () => {
    const r = run(['hey', join(deltaSrc, 'wt', 'delta-wip', 'src'), 'hi', '--dry']);
    eq(r.rc, 0, r.err); ok(r.out.includes('agent prompt wF:p1'), r.out);
  });
  check('a path held by agents in two workspaces lists both and does nothing', () => {
    const r = run(['hey', alpha, 'hi there', '--dry']);
    eq(r.rc, 1, r.out); ok(noPick(r), r.out);
    ok(r.err.includes("maw herdr hey --session default wA:p1 'hi there'") && r.err.includes("maw herdr hey --session default wC:p1 'hi there'"), r.err);
  });
  // across workspaces the focused pane is not a tie-break
  check('a pane id in two sessions is ambiguous even when one copy is focused', () => {
    const r = run(['peek', 'wA:p1']);
    eq(r.rc, 1, r.out); ok(r.out === '' && r.err.includes('maw herdr peek --session default wA:p1') && r.err.includes('maw herdr peek --session side wA:p1'), r.err);
  });
  check('self with an unreadable socket is ambiguous across sessions, never narrowed to focus', () => {
    const r = run(['peek', 'self', '--dry'], { pane: 'wA:p1', socket: join(tmp, 'elsewhere', 'x.sock') });
    eq(r.rc, 1, r.out); ok(noPick(r) && r.err.includes('maw herdr peek --session default wA:p1') && r.err.includes('maw herdr peek --session side wA:p1'), r.err);
  });
  // a plain space's candidate line is its pane, not the checkout it borrows
  check('an ambiguous name lists a plain space by its pane, and that line resolves back to it', () => {
    const r = run(['resolve', 'om']);
    eq(r.rc, 1, r.out);
    const line = r.err.split('\n').find(l => l.includes('# ') && l.includes('wC:p1'));
    ok(line && line.includes('maw herdr resolve --session default wC:p1') && !line.includes(alpha), r.err);
    const again = json(line.split('#')[0].trim().split(/\s+/).slice(2));
    eq(again.label, 'omp'); eq(again.pane, 'wC:p1');
  });
  // printed commands survive paste: quoted paths, prunable worktrees, usage lines
  check('candidate lines quote a path with a space', () => {
    const r = run(['resolve', 'wip']);
    eq(r.rc, 1, r.out); ok(r.err.includes(`maw herdr resolve '${join(gamma, 'wt', 'gamma wip2')}'`), r.err);
  });
  const loaded2 = JSON.parse(run(['resolve', '--list', '--json']).out).targets;
  check('requirePane quotes --cwd and --label', () => {
    const t = resolveTarget(loaded2, 'gamma wip2', { caller: null, cwd: tmp, verb: 'restart' });
    assert.throws(() => requirePane(t, 'restart'), e => e.message.includes(`herdr workspace create --cwd '${join(gamma, 'wt', 'gamma wip2')}' --label 'gamma wip2' --no-focus`) || assert.fail(e.message));
  });
  check('requirePane on a prunable worktree prints git worktree prune', () => {
    const t = resolveTarget(loaded2, 'gone-wt', { caller: null, cwd: tmp, verb: 'restart' });
    eq(t.prunable, true);
    assert.throws(() => requirePane(t, 'restart'), e => e.message.includes(`git -C ${gamma} worktree prune`) || assert.fail(e.message));
  });
  check('resolve usage errors end in runnable commands, not a synopsis', () => {
    let r = run(['resolve', 'a', 'b']);
    eq(r.rc, 2); ok(r.err.includes('\n  maw herdr resolve a\n  maw herdr resolve b') && !r.err.includes('<target>'), r.err);
    r = run(['resolve', '--bogus']);
    eq(r.rc, 2); ok(r.err.includes('maw herdr resolve --list') && !r.err.includes('<target>'), r.err);
    r = run(['resolve', '--session']);
    eq(r.rc, 2); ok(r.err.includes('maw herdr ls --sessions') && !r.err.includes('<name>'), r.err);
  });
  // herdr missing or answering garbage
  check('no herdr on PATH prints a PATH diagnostic, not a command that fails the same way', () => {
    const r = cli(entry, ['resolve', 'omp'], { env: { PATH: '/usr/bin:/bin' } });
    eq(r.rc, 1); ok(r.err.includes('command -v herdr') && !r.err.includes('check herdr answers'), r.err);
  });
  check('a session whose snapshot is not arrays is skipped with a note, not a TypeError', () => {
    const r = run(['resolve', 'omp', '--json'], { env: { FAKE_WEIRD: '1' } });
    eq(r.rc, 0, r.err); eq(JSON.parse(r.out).resolved.pane, 'wC:p1');
    ok(r.err.includes('weird') && r.err.includes('herdr --session weird api snapshot') && !r.err.includes('TypeError'), r.err);
  });
  if (fails.length) throw new Error(`${fails.length} review regression(s):\n${fails.join('\n')}`);

  // Nothing but reads, plus the one explicit prompt to the fake in the comparison.
  const writes = calls().filter(a => !READS.has(verbOf(a)));
  ok(writes.every(a => verbOf(a) === 'agent prompt' && a.includes('a real prompt to the fake')), `only the expected prompt reached herdr: ${JSON.stringify(writes)}`);
  eq(writes.length, 1, 'exactly the one prompt from the byte-for-byte case');

  console.log(`PASS target grammar: ${checks} assertions — self (env + socket session), path/./relative/containing worktree, pane id (+cross-session ambiguity), exact label / repo main / substring, ambiguity lists and exits 1, --dry, --list, requirePane, quoting, herdr missing/garbage; hey/peek identical to ${LEGACY_REF.slice(0, 7)} on ${compared} recorded cases`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
