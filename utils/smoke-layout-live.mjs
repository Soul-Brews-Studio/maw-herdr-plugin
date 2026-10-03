#!/usr/bin/env bun
// Actual CLI -> isolated Herdr daemon: join/break/layout geometry and identity,
// then restore a real git worktree and resume an unpaid local Claude stand-in.
// No Herdr response is stubbed; no installed model or user's session is used.
// Run: bun utils/smoke-layout-live.mjs (MAW_LAYOUT_LIVE_ENTRY selects a bundle/package).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeClaudeDir } from '../src/cli/mod.resumeProviders.mjs';
import { withHerdrDaemon, waitFor } from './lib.herdrDaemon.mjs';

const self = fileURLToPath(import.meta.url);
const entry = resolve(process.env.MAW_LAYOUT_LIVE_ENTRY || join(dirname(self), '..', 'index.mjs'));
const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;
const retry = `${process.env.MAW_LAYOUT_LIVE_ENTRY ? `MAW_LAYOUT_LIVE_ENTRY=${quote(entry)} ` : ''}bun ${quote(self)}`;

// Launched by real `herdr agent start`, through a private PATH launcher. Its
// foreground executable is a copy of Bun named claude, not a model executable.
function standIn(configPath, args) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.ok(process.stdin.isTTY && process.stdout.isTTY);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('Claude restore fixture (no model)\r\n❯ ');
  execFileSync(config.client, ['--session', config.session, 'pane', 'report-agent', process.env.HERDR_PANE_ID,
    '--source', 'layout-fixture', '--agent', 'claude', '--state', 'idle'], { timeout: 10_000, stdio: 'pipe' });
  writeFileSync(config.journal, JSON.stringify({ cwd: process.cwd(), args, pane: process.env.HERDR_PANE_ID }));
  setInterval(() => {}, 1000);
}

async function smoke() {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'maw-layout-live-')));
  const originalEnv = { ...process.env };
  // The daemon's SIGINT/TERM handler exits after stop/delete, bypassing finally.
  const removeFixture = () => rmSync(fixture, { recursive: true, force: true });
  process.once('exit', removeFixture);
  let home;
  try {
    const bin = join(fixture, 'bin'), runtime = join(fixture, 'runtime');
    mkdirSync(bin);
    mkdirSync(runtime);
    const agent = join(runtime, 'claude'), configPath = join(fixture, 'agent.json');
    copyFileSync(process.execPath, agent);
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec ${quote(agent)} ${quote(self)} --agent ${quote(configPath)} "$@"\n`, { mode: 0o700 });
    // The daemon must inherit the stand-in PATH before it creates shell panes.
    // Git config/env must not redirect the disposable repo to a real checkout.
    for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
    Object.assign(process.env, { PATH: `${bin}:${originalEnv.PATH}`, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
    await withHerdrDaemon(async daemon => {
      home = daemon.directory;
      const anchor = await daemon.createSpace('layout-anchor');
      const first = await daemon.createSpace('layout-first');
      const second = await daemon.createSpace('layout-second');
      const sessionList = JSON.parse(await daemon.herdr(['session', 'list', '--json'])).sessions;
      const socket = sessionList.find(item => item.name === daemon.session).socket_path;
      assert.deepEqual(sessionList.filter(item => item.running).map(item => item.name), [daemon.session]);

      // CLI verbs use herdr from PATH. Forward them through Lane A's guarded
      // client, whose captured PATH does NOT include this directory (no recursion).
      const cliBin = join(home, 'cli-bin');
      mkdirSync(cliBin);
      symlinkSync(daemon.client, join(cliBin, 'herdr'));
      const env = { ...daemon.env, PATH: `${cliBin}:${daemon.env.PATH}`, HERDR_PANE_ID: anchor.pane,
        HERDR_SOCKET_PATH: socket, GHQ_ROOT: join(home, 'code'), MAW_HERDR_RESUME_PROVIDERS: 'claude',
        MAW_HERDR_CLAUDE_ROOTS: join(home, 'transcripts'), MAW_HERDR_CODEX_ROOTS: join(home, 'absent-codex') };
      const cli = (args, status = 0) => {
        const result = spawnSync(process.execPath, [entry, ...args, '--session', daemon.session], {
          env, cwd: daemon.cwd, encoding: 'utf8', timeout: 60_000,
        });
        assert.ifError(result.error);
        assert.equal(result.status, status, `${args[0]}: ${result.stdout}\n${result.stderr}`);
        return result;
      };
      const snapshot = async () => (await daemon.json(['api', 'snapshot'])).snapshot;
      const layout = async () => (await daemon.json(['pane', 'layout', '--pane', anchor.pane])).layout;
      const rects = lay => lay.panes.map(p => [p.pane_id, p.rect.x, p.rect.y, p.rect.width, p.rect.height]);
      const identity = state => state.panes.map(p => [p.terminal_id, p.cwd]).sort();
      // Exclude agent-detection counters, scroll and process titles: only topology
      // and rectangles decide whether a refused command left everything in place.
      const topology = state => ({
        spaces: state.workspaces.map(w => [w.workspace_id, w.label]).sort(),
        tabs: state.tabs.map(t => [t.tab_id, t.workspace_id]).sort(),
        panes: state.panes.map(p => [p.pane_id, p.tab_id, p.workspace_id, p.terminal_id, p.cwd]).sort(),
        layouts: state.layouts.map(l => [l.tab_id, rects(l)]).sort(),
      });
      const initial = await snapshot();
      const beforeIds = initial.panes.map(p => p.pane_id);
      assert.equal(beforeIds.length, 3, 'exactly three owned shell panes');
      assert.ok(initial.panes.every(p => !p.agent), 'layout uses shells, not real agents');
      assert.deepEqual((await layout()).area, { x: 0, y: 0, width: 120, height: 40 });

      cli(['join', first.pane, second.pane]);
      let state = await snapshot();
      assert.deepEqual(state.workspaces.map(w => w.workspace_id), [anchor.workspace], 'both emptied source spaces close');
      assert.deepEqual(state.tabs.map(t => t.tab_id), [anchor.tab], 'source tabs close too');
      assert.deepEqual(identity(state), identity(initial), 'join preserves terminal processes and cwd');
      const joined = [anchor, first, second].map(space => state.panes.find(p => p.cwd === space.cwd).pane_id);
      assert.equal(joined[0], anchor.pane);
      assert.ok(!beforeIds.includes(joined[1]) && !beforeIds.includes(joined[2]), 'cross-workspace moves allocate new IDs');
      assert.deepEqual(rects(await layout()), joined.map((id, i) => [id, i * 40, 0, 40, 40]), 'join: three equal columns');

      for (const [mode, expected] of [
        ['main', [[joined[0], 0, 0, 40, 40], [joined[1], 40, 0, 80, 20], [joined[2], 40, 20, 80, 20]]],
        ['rows', [[joined[0], 0, 0, 120, 13], [joined[1], 0, 13, 120, 14], [joined[2], 0, 27, 120, 13]]],
      ]) {
        cli(['layout', mode]);
        assert.deepEqual(rects(await layout()), expected, `${mode}: exact geometry and unchanged pane IDs`);
        state = await snapshot();
        assert.deepEqual(state.tabs.map(t => t.tab_id), [anchor.tab], `${mode}: scratch tab closes`);
        assert.deepEqual(identity(state), identity(initial), `${mode}: same terminals and cwd`);
      }

      cli(['break', joined[1], '--label', 'alpha']);
      state = await snapshot();
      const alpha = state.workspaces.find(w => w.label === 'alpha');
      assert.ok(alpha && alpha.workspace_id !== anchor.workspace, 'break opens the requested new space');
      const moved = state.panes.find(p => p.cwd === first.cwd);
      assert.equal(moved.workspace_id, alpha.workspace_id);
      assert.ok(!joined.includes(moved.pane_id), 'break changes the moved pane ID');
      assert.deepEqual(identity(state), identity(initial), 'break keeps every terminal and cwd');
      const beforeRefusal = topology(state);
      const refused = cli(['break', joined[2], '--label', 'alpha'], 1);
      assert.match(refused.stderr, /a space named 'alpha' already exists/);
      assert.ok(refused.stderr.trim().endsWith(`maw herdr break ${joined[2]} --label alpha-2`), 'refusal ends with a runnable fix');
      assert.deepEqual(topology(await snapshot()), beforeRefusal, 'duplicate label moves nothing');
      console.log('PASS live layout: join columns, source closure, main/rows geometry, stable terminal identities, break and duplicate-label refusal');

      // A real local repo plus a removed worktree, with only synthetic history.
      const repo = join(env.GHQ_ROOT, 'example.invalid', 'fixture', 'repo');
      mkdirSync(repo, { recursive: true });
      const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', '-C', cwd, ...args], { env, encoding: 'utf8', timeout: 10_000, stdio: 'pipe' }).trim();
      git(repo, 'init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'tracked.txt'), 'restored content\n');
      git(repo, 'add', 'tracked.txt');
      git(repo, 'commit', '-q', '-m', 'fixture');
      const restored = join(repo, 'wt', 'restore-fixture'), transcriptId = randomUUID();
      git(repo, 'worktree', 'add', '-q', '-b', 'restore-fixture', restored);
      git(repo, 'worktree', 'remove', restored);
      assert.ok(!existsSync(restored));
      const transcriptDir = join(env.MAW_HERDR_CLAUDE_ROOTS, encodeClaudeDir(restored));
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(join(transcriptDir, `${transcriptId}.jsonl`), JSON.stringify({ type: 'user', cwd: restored,
        gitBranch: 'restore-fixture', sessionId: transcriptId, message: 'synthetic transcript '.repeat(100) }) + '\n');
      const journal = join(home, 'resume-journal.json');
      writeFileSync(configPath, JSON.stringify({ client: daemon.client, session: daemon.session, journal }));
      const beforeRestore = topology(await snapshot());
      cli(['restore', restored, '--no-resume']);
      assert.equal(git(restored, 'rev-parse', '--show-toplevel'), restored, 'restore uses the original path');
      assert.equal(git(restored, 'branch', '--show-current'), 'restore-fixture');
      assert.equal(readFileSync(join(restored, 'tracked.txt'), 'utf8'), 'restored content\n');
      assert.deepEqual(topology(await snapshot()), beforeRestore, '--no-resume opens no panes or spaces');
      assert.ok(!existsSync(journal), '--no-resume starts no agent');

      cli(['resume', restored]);
      const launched = await waitFor(() => existsSync(journal) && JSON.parse(readFileSync(journal, 'utf8')), 'resume stand-in');
      assert.equal(launched.cwd, restored, 'resumed process really runs at the restored path');
      assert.deepEqual(launched.args, ['--resume', transcriptId], 'resume launches the synthetic transcript');
      state = await snapshot();
      const pane = state.panes.find(p => p.pane_id === launched.pane);
      assert.ok(pane, 'resumed pane exists in the isolated daemon');
      assert.equal(pane.cwd, restored);
      assert.equal(pane.agent, 'claude', 'Herdr recognises the stand-in');
      const workspace = state.workspaces.find(w => w.workspace_id === pane.workspace_id);
      assert.equal(workspace.worktree.checkout_path, restored, 'space is bound to the restored worktree, not a plain shell space');
      assert.equal(workspace.worktree.repo_root, repo);
      assert.equal(workspace.worktree.is_linked_worktree, true);
      // worktree open may also create the repo's primary shell workspace.
      assert.equal(state.panes.filter(p => p.cwd === restored).length, 1, 'one pane at the restored path');
      assert.deepEqual(state.panes.filter(p => p.agent).map(p => p.pane_id), [launched.pane], 'exactly one stand-in agent');
      const oldTerminals = new Set(initial.panes.map(p => p.terminal_id));
      assert.deepEqual(identity({ panes: state.panes.filter(p => oldTerminals.has(p.terminal_id)) }), identity(initial), 'resume preserves the layout fixture terminals');
      console.log('PASS live restore/resume: same-path checkout, no-resume leaves topology unchanged, real worktree space and unpaid stand-in argv/cwd');
    });
    assert.ok(!existsSync(home), 'daemon stop/delete and temporary HOME cleanup completed');
    console.log(`PASS live layout cleanup (${process.env.MAW_LAYOUT_LIVE_ENTRY ? 'bundle/package' : 'source'})`);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    removeFixture();
    process.removeListener('exit', removeFixture);
  }
}

try {
  if (process.argv[2] === '--agent') standIn(process.argv[3], process.argv.slice(4));
  else await smoke();
} catch (error) {
  console.error(`${error.stack}\nRun: ${retry}`);
  process.exitCode = 1;
}
