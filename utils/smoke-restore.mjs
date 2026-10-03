#!/usr/bin/env bun
// restore / ls restorable (#90), through the actual CLI process, against a REAL git
// origin and repo in a temp dir and FAKE Claude and Codex transcript roots. No herdr
// is reached: listing never asks it, and the resume hand-off is checked by injecting
// it in-process. One worktree per case:
//   gone-local      removed with `git worktree remove`; branch local          → restorable
//   registered      folder rm'd, git still registers it (prunable)           → add -f
//   husky           removed, then a file written into its path (no .git)     → moved aside, copied back
//   remote-only     branch only on origin                                     → --track -b
//   renamed-folder  folder name ≠ branch; the transcript recorded feat/renamed → that branch
//   codex-gone      only a Codex rollout knows it; branch = folder name       → restorable
//   held            its branch is checked out in another, existing worktree  → refused
//   nobranch        no branch anywhere                                        → refused
//   exists-ok       folder and checkout present                               → not listed (resume's)
// Every refusal and --dry is checked to change nothing on disk or in git.
// Then a speed budget on a synthetic fixture (Neo's review of #90): 300 Claude
// project dirs and 2,000 Codex rollouts must list well inside a few seconds.
// Run: bun utils/smoke-restore.mjs    (MAW_RESTORE_ENTRY=<bundle> for the bundle)
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { worktreeOf } from '../src/cli/mod.worktreeOf.mjs';
import { parseWorktrees } from '../src/cli/mod.parseWorktrees.mjs';
import { huskStamp } from '../src/cli/mod.husk.mjs';
import { claudeProvider, codexProvider, encodeClaudeDir } from '../src/cli/mod.resumeProviders.mjs';
import { TargetError } from '../src/cli/mod.target.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.env.MAW_RESTORE_ENTRY || join(root, 'index.mjs');
const runtime = process.execPath;
const T = realpathSync(mkdtempSync(join(tmpdir(), 'maw-restore-')));
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg ?? `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); checks++; };

const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', '-c', 'init.defaultBranch=main', '-C', cwd, ...args], { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] });
const pad = n => 'x'.repeat(n);

try {
  // --- pure ---------------------------------------------------------------------------
  eq(worktreeOf('/c/org/alpha/wt/feat-x/ψ/writing'), { repo: '/c/org/alpha', name: 'feat-x', path: '/c/org/alpha/wt/feat-x' }, 'a cwd inside a worktree names the worktree');
  eq(worktreeOf('/c/org/alpha'), null, 'no /wt/: not a worktree');
  const wl = parseWorktrees('worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /r/wt/a\nHEAD 2\nbranch refs/heads/feat/a\nprunable gitdir file points to non-existent location\n\nworktree /r/wt/d\nHEAD 3\ndetached\n');
  eq([...wl.byPath.keys()], ['/r', '/r/wt/a', '/r/wt/d'], 'every worktree block');
  eq(wl.byPath.get('/r/wt/a'), { branch: 'feat/a', prunable: true }, 'prunable is read');
  eq(wl.byBranch.get('feat/a'), '/r/wt/a', 'branch → path');
  ok(/^\d{8}-\d{4}$/.test(huskStamp()), `husk stamp is local yyyymmdd-hhmm: ${huskStamp()}`);

  // --- a real origin and repo ------------------------------------------------------------
  const origin = join(T, 'origin.git');
  git(T, 'init', '-q', '--bare', origin);
  const seed = join(T, 'seed');
  git(T, 'clone', '-q', origin, seed);
  writeFileSync(join(seed, 'README'), 'alpha\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'main');
  for (const b of ['gone-local', 'registered', 'husky', 'remote-only', 'feat/renamed', 'codex-gone', 'held', 'exists-ok']) git(seed, 'push', '-q', 'origin', `main:refs/heads/${b}`);
  const repo = join(T, 'code', 'github.com', 'org', 'alpha');
  mkdirSync(dirname(repo), { recursive: true });
  git(T, 'clone', '-q', origin, repo);
  const wt = name => join(repo, 'wt', name);
  for (const b of ['gone-local', 'registered', 'husky', 'feat/renamed', 'codex-gone', 'held', 'exists-ok']) git(repo, 'branch', '-q', b, `origin/${b}`);
  git(repo, 'worktree', 'add', '-q', wt('gone-local'), 'gone-local');
  git(repo, 'worktree', 'remove', wt('gone-local'));
  git(repo, 'worktree', 'add', '-q', wt('registered'), 'registered');
  rmSync(wt('registered'), { recursive: true, force: true });              // git still registers it
  git(repo, 'worktree', 'add', '-q', wt('husky'), 'husky');
  git(repo, 'worktree', 'remove', wt('husky'));
  mkdirSync(join(wt('husky'), 'ψ', 'memory', 'logs'), { recursive: true });
  writeFileSync(join(wt('husky'), 'ψ', 'memory', 'logs', 'launchd.err'), 'a log someone kept writing\n');
  git(repo, 'worktree', 'add', '-q', wt('held-elsewhere'), 'held');      // `held` lives here, not at wt/held
  git(repo, 'worktree', 'add', '-q', wt('exists-ok'), 'exists-ok');

  // --- transcripts ------------------------------------------------------------------------
  const claudeRoot = join(T, 'claude');
  const codexRoot = join(T, 'codex');
  const claude = (path, branch, id, ago = 0) => {
    const dir = join(claudeRoot, encodeClaudeDir(path));
    mkdirSync(dir, { recursive: true });
    const lines = [{ type: 'summary', summary: 'x' }, { type: 'user', cwd: path, gitBranch: branch, sessionId: id, message: pad(1200) }];
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    const t = new Date(Date.now() - ago * 3600_000);
    execFileSync('touch', ['-t', `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}`, file]);
  };
  claude(wt('gone-local'), 'gone-local', '11111111-1111-1111-1111-111111111111', 1);
  claude(wt('gone-local'), 'gone-local', '11111111-1111-1111-1111-111111111112', 30);
  claude(wt('registered'), 'registered', '22222222-2222-2222-2222-222222222222', 2);
  claude(join(wt('husky'), 'ψ', 'writing'), 'husky', '33333333-3333-3333-3333-333333333333', 3);   // started deeper inside
  claude(wt('remote-only'), 'remote-only', '44444444-4444-4444-4444-444444444444', 4);
  claude(wt('renamed-folder'), 'feat/renamed', '55555555-5555-5555-5555-555555555555', 5);
  claude(wt('held'), 'held', '66666666-6666-6666-6666-666666666666', 6);
  claude(wt('nobranch'), 'nobranch', '77777777-7777-7777-7777-777777777777', 7);
  claude(wt('exists-ok'), 'exists-ok', '88888888-8888-8888-8888-888888888888', 8);
  const rollouts = join(codexRoot, '2026', '10', '01');
  mkdirSync(rollouts, { recursive: true });
  const codexId = '01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
  writeFileSync(join(rollouts, `rollout-2026-10-01T00-00-00-${codexId}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id: codexId, cwd: wt('codex-gone'), source: 'cli' } })}\n${pad(1500)}\n`);

  const env = { PATH: process.env.PATH, HOME: join(T, 'home'), MAW_HERDR_CLAUDE_ROOTS: claudeRoot, MAW_HERDR_CODEX_ROOTS: codexRoot };
  mkdirSync(env.HOME);
  const cli = (args, extra = {}) => {
    const r = spawnSync(runtime, [entry, ...args], { cwd: T, encoding: 'utf8', timeout: 60_000, env: { ...env, ...extra } });
    return { rc: r.status, out: r.stdout, err: r.stderr };
  };
  const snapshot = () => JSON.stringify({ wt: readdirSync(join(repo, 'wt')).sort(), list: git(repo, 'worktree', 'list', '--porcelain'), refs: git(repo, 'for-each-ref', '--format=%(refname)') });

  // --- providers: all() sees what sessions() cannot be asked for ----------------------------
  ok(claudeProvider([claudeRoot]).all({ contains: '/wt/' }).has(wt('gone-local')), 'claude all(): a gone folder, by its cwd');
  eq(claudeProvider([claudeRoot]).all({ contains: '/wt/' }).get(wt('renamed-folder'))[0].branch, 'feat/renamed', 'claude all(): the recorded branch');
  ok(codexProvider([codexRoot]).all({ contains: '/wt/' }).has(wt('codex-gone')), 'codex all(): a gone folder, by its cwd');
  eq(codexProvider([codexRoot]).sessions([wt('codex-gone')]).get(wt('codex-gone'))[0].id, codexId, 'codex sessions(paths) still answers for a named path');

  // --- the list ------------------------------------------------------------------------------
  let r = cli(['restore', '--json']);
  eq(r.rc, 0, r.err);
  const rows = JSON.parse(r.out);
  const row = n => rows.find(x => x.name === n);
  eq(rows.map(x => x.name).sort(), ['codex-gone', 'gone-local', 'held', 'husky', 'nobranch', 'registered', 'remote-only', 'renamed-folder'], 'every gone worktree, never one whose checkout exists');
  eq([row('gone-local').restorable, row('gone-local').local, row('gone-local').registered, row('gone-local').sessions], [true, true, false, 2], 'gone-local: local branch, both sessions');
  eq([row('registered').restorable, row('registered').registered], [true, true], 'registered: still in git');
  eq([row('husky').restorable, row('husky').husk], [true, 1], 'husky: a leftover file and no .git');
  eq([row('remote-only').restorable, row('remote-only').local, row('remote-only').remote], [true, false, 'origin/remote-only'], 'remote-only: from origin');
  eq(row('renamed-folder').branch, 'feat/renamed', 'the recorded branch beats the folder name');
  eq([row('codex-gone').restorable, row('codex-gone').newest.provider, row('codex-gone').branch], [true, 'codex', 'codex-gone'], 'codex-only: branch = folder name');
  eq([row('held').restorable, row('held').heldBy], [false, wt('held-elsewhere')], 'held: checked out elsewhere');
  eq(row('nobranch').restorable, false, 'nobranch: nothing to check out');
  eq(rows.slice(0, 6).every(x => x.restorable), true, 'restorable rows come first');
  r = cli(['restore']);
  ok(r.out.includes('↺ restorable') && r.out.includes('✗ not restorable (2)') && r.out.includes('bring one back: maw herdr restore'), r.out);
  r = cli(['ls', 'restorable', '--json']);
  eq(JSON.parse(r.out).map(x => x.name).sort(), rows.map(x => x.name).sort(), 'ls restorable is the same list');
  r = cli(['ls', '--restorable']);
  eq(r.rc, 2, 'a state in flag shape is a usage error');
  ok(r.err.includes('maw herdr ls restorable'), `naming the word that works: ${r.err}`);
  r = cli(['ls', '--resumable', '--json']);
  ok(r.err.includes('maw herdr ls resumable --json'), r.err);

  // --- refusals and --dry change nothing --------------------------------------------------------
  const before = snapshot();
  r = cli(['restore', 'gone-local', '--dry']);
  eq(r.rc, 0, r.err);
  ok(r.out.includes(`worktree add ${wt('gone-local')} gone-local`) && r.out.includes('--dry: nothing was done'), r.out);
  r = cli(['restore', 'husky', '--dry']);
  ok(r.out.includes('husk') && r.out.includes('.husk-'), r.out);
  r = cli(['restore', 'held']);
  eq(r.rc, 1, 'held is refused');
  ok(r.err.includes(`maw herdr resume ${wt('held-elsewhere')}`), r.err);
  r = cli(['restore', 'nobranch']);
  eq(r.rc, 1, 'no branch is refused');
  ok(r.err.includes(`worktree add -b nobranch ${wt('nobranch')}`), r.err);
  r = cli(['restore', 'e']);
  eq(r.rc, 1, 'an ambiguous substring is refused');
  ok(/matches \d+ worktrees whose folder is gone/.test(r.err), r.err);
  r = cli(['restore', 'a', 'b']);
  eq(r.rc, 2, 'two targets is a usage error');
  eq(snapshot(), before, 'no refusal and no --dry touched the folders, the worktrees or the refs');
  ok(existsSync(join(wt('husky'), 'ψ', 'memory', 'logs', 'launchd.err')), 'the husk is untouched by --dry');

  // --- restore for real (--no-resume: no herdr in this smoke) -------------------------------------
  r = cli(['restore', 'gone-local', '--no-resume']);
  eq(r.rc, 0, r.err);
  eq(git(wt('gone-local'), 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'gone-local', 'back at the SAME path on its branch');
  ok(r.out.includes(`maw herdr resume ${wt('gone-local')}`), r.out);
  r = cli(['restore', 'remote-only', '--no-resume']);
  eq(r.rc, 0, r.err);
  eq(git(wt('remote-only'), 'rev-parse', '--abbrev-ref', 'remote-only@{upstream}').trim(), 'origin/remote-only', 'a local branch tracking origin');
  r = cli(['restore', 'registered', '--no-resume']);
  eq(r.rc, 0, r.err);
  ok(r.out.includes('add -f') && existsSync(join(wt('registered'), 'README')), r.out);
  r = cli(['restore', 'husky', '--no-resume']);
  eq(r.rc, 0, r.err);
  ok(existsSync(join(wt('husky'), '.git')), 'the husk became a checkout');
  eq(readFileSync(join(wt('husky'), 'ψ', 'memory', 'logs', 'launchd.err'), 'utf8'), 'a log someone kept writing\n', 'its leftover file was copied back');
  const backup = readdirSync(join(repo, 'wt')).find(n => n.startsWith('husky.husk-'));
  ok(backup && existsSync(join(repo, 'wt', backup, 'ψ', 'memory', 'logs', 'launchd.err')), `the backup stays: ${backup}`);
  r = cli(['restore', '--json']);
  eq(JSON.parse(r.out).map(x => x.name).sort(), ['codex-gone', 'held', 'nobranch', 'renamed-folder'], 'restored ones leave the list');

  // --- the resume hand-off, in-process --------------------------------------------------------------
  Object.assign(process.env, { MAW_HERDR_CLAUDE_ROOTS: claudeRoot, MAW_HERDR_CODEX_ROOTS: codexRoot });
  const { cmdRestore } = await import('../src/cli/mod.cmdRestore.mjs');
  const calls = [];
  const quiet = async fn => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
  await quiet(() => cmdRestore(['renamed-folder'], { resume: async a => { calls.push(a); } }));
  eq(calls.pop(), [wt('renamed-folder')], 'after the worktree is back, resume gets its exact path');
  eq(git(wt('renamed-folder'), 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feat/renamed', 'on the recorded branch');
  await quiet(() => cmdRestore(['exists-ok', '--dry', '--session', 's1'], { resume: async a => { calls.push(a); } }));
  eq(calls.pop(), ['exists-ok', '--dry', '--session', 's1'], 'a folder that exists is handed to resume, flags and all');
  let thrown = null;
  try { await quiet(() => cmdRestore(['nothing-here'], { resume: async () => { throw new TargetError('no worktree', 'not-found'); } })); } catch (e) { thrown = e; }
  ok(thrown?.message.includes('see what can come back: maw herdr restore'), `${thrown?.message}`);

  // --- speed budget (Neo, #90): 300 Claude dirs + 2,000 Codex rollouts ----------------------------------
  const bigClaude = join(T, 'big-claude');
  const bigCodex = join(T, 'big-codex', '2026', '09', '30');
  mkdirSync(bigCodex, { recursive: true });
  for (let i = 0; i < 300; i++) {
    const p = i % 3 ? join(T, 'code', 'gone', `repo${i}`, 'wt', `w${i}`) : join(T, 'code', 'plain', `repo${i}`);
    const dir = join(bigClaude, encodeClaudeDir(p));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000.jsonl`), `${JSON.stringify({ type: 'user', cwd: p, gitBranch: `w${i}` })}\n${pad(2000)}\n`);
  }
  for (let i = 0; i < 2000; i++) {
    const id = `01a0${String(i).padStart(4, '0')}-0000-7000-8000-000000000000`;
    writeFileSync(join(bigCodex, `rollout-2026-09-30T00-00-00-${id}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: join(T, 'code', 'x', `r${i % 50}`, 'wt', `c${i}`), source: 'cli' } })}\n${pad(2000)}\n`);
  }
  const t0 = performance.now();
  r = cli(['restore', '--json'], { MAW_HERDR_CLAUDE_ROOTS: bigClaude, MAW_HERDR_CODEX_ROOTS: join(T, 'big-codex') });
  const ms = Math.round(performance.now() - t0);
  eq(r.rc, 0, r.err);
  ok(ms < 4000, `300 Claude dirs + 2,000 Codex rollouts listed in ${ms} ms (budget 4000, process start included)`);

  console.log(`ok — restore / ls restorable: ${checks} checks · speed fixture listed in ${ms} ms`);
} finally {
  rmSync(T, { recursive: true, force: true });
}
