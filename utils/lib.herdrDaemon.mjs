import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;

/** Poll a read-only observation, bounded even when the expected state never arrives. */
export async function waitFor(read, label, timeout = 10_000) {
  const end = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < end);
  throw new Error(`${label} timed out`);
}

/**
 * await withHerdrDaemon(async daemon => { ... });
 *
 * Owns a detached headless server, unique named session and temporary HOME/config.
 * No inherited socket, remote, shell startup file or plugin config is used.
 * - directory, cwd, env: private fixture paths/environment (also for child servers).
 * - herdr(args): session-bound CLI, returns stdout; json(args) parses its envelope.
 * - createSpace(label): returns { workspace, tab, pane, cwd } in a new temp cwd.
 * - createPane(pane, direction): splits an owned pane, returning its new pane ID.
 * - readVisible(pane, ansi): reads only that pane's currently visible screen.
 * - client: guarded real-CLI executable for the plugin's --herdr option. Its only
 *   unbound verb is session list in the isolated HOME; all others require this
 *   session explicitly. It does not fake snapshots, prompts, reads or receipts.
 *
 * Both session stop and delete run on success, assertion failure and SIGINT/TERM.
 * Await all child work inside the callback; shut down HTTP/WS clients there first.
 * Requires the installed herdr CLI; uses no paid model or existing user session.
 */
export async function withHerdrDaemon(test) {
  // macOS TMPDIR is too long for sockaddr_un after Herdr adds its session path.
  const directory = realpathSync(mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'hds-')));
  const session = `smoke-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const cwd = join(directory, 'work');
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(HERDR_|MAW_|TMUX|XDG_|CLAUDE|CODEX|OMX_|SSH_)/.test(key) || ['PEERS_FILE', 'ENV', 'BASH_ENV', 'ZDOTDIR'].includes(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: directory, SHELL: '/bin/sh', XDG_CONFIG_HOME: join(directory, 'config'),
    XDG_DATA_HOME: join(directory, 'data'), XDG_STATE_HOME: join(directory, 'state'),
    XDG_CACHE_HOME: join(directory, 'cache'), XDG_RUNTIME_DIR: join(directory, 'run'),
    HERDR_CONFIG_PATH: join(directory, 'herdr.toml'), MAW_CONFIG_DIR: join(directory, 'maw-config'),
    MAW_TEST_MODE: '1', PEERS_FILE: join(directory, 'absent-peers.json'),
  });
  for (const path of [cwd, env.XDG_RUNTIME_DIR, env.MAW_CONFIG_DIR]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(env.HERDR_CONFIG_PATH, 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n');
  const raw = async args => (await execute('herdr', args, { env, cwd, timeout: 10_000, maxBuffer: 4 << 20 })).stdout;
  const herdr = args => raw(['--session', session, ...args]);
  const json = async args => JSON.parse(await herdr(args)).result;
  const fix = `env HOME=${quote(directory)} HERDR_CONFIG_PATH=${quote(env.HERDR_CONFIG_PATH)} herdr session stop ${quote(session)}; env HOME=${quote(directory)} HERDR_CONFIG_PATH=${quote(env.HERDR_CONFIG_PATH)} herdr session delete ${quote(session)}`;
  // Bound the backend's otherwise cross-session roster discovery to this HOME,
  // and fail closed if a caller tries to address any other session.
  const retry = `bun ${quote(fileURLToPath(new URL('./smoke-send-live.mjs', import.meta.url)))}`;
  const client = join(directory, 'herdr-client');
  const clientEnv = ['HOME', 'PATH', 'SHELL', 'HERDR_CONFIG_PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR']
    .map(key => `${key}=${quote(env[key] ?? '')}`).join(' ');
  writeFileSync(client, `#!/bin/sh\nif [ "$#" = 3 ] && [ "$1" = session ] && [ "$2" = list ] && [ "$3" = --json ]; then exec env -i ${clientEnv} herdr "$@"; fi\nif [ "$1" = --session ] && [ "$2" = ${quote(session)} ]; then exec env -i ${clientEnv} herdr "$@"; fi\nprintf '%s\\n' ${quote('Refused a command outside the test session. Run: ' + retry)} >&2\nexit 1\n`, { mode: 0o700 });
  let server, serverError, stopped;
  const cleanup = () => stopped ??= (async () => {
    const errors = [];
    // Do not skip delete if stop failed (including partial startup).
    for (const verb of ['stop', 'delete']) {
      try { await raw(['session', verb, session, '--json']); }
      catch (error) { errors.push(error); }
    }
    if (server?.exitCode === null && server?.signalCode === null) {
      try { await waitFor(() => server.exitCode !== null || server.signalCode !== null, 'daemon shutdown', 3000); }
      catch (error) {
        errors.push(error);
        try { process.kill(-server.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }
    }
    try {
      const list = JSON.parse(await raw(['session', 'list', '--json']));
      if ((list.result?.sessions ?? list.sessions).some(item => item.name === session)) errors.push(new Error('Session survived deletion'));
    } catch (error) { errors.push(error); }
    if (errors.length) throw new Error(`Isolated daemon cleanup failed (${errors.length} errors). Run: ${fix}`);
    rmSync(directory, { recursive: true, force: true });
  })();
  const interrupt = () => { cleanup().then(() => process.exit(130), error => { console.error(error.message); process.exit(1); }); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    // Verify isolation before starting anything. Never probe an inherited socket.
    const list = JSON.parse(await raw(['session', 'list', '--json']));
    if ((list.result?.sessions ?? list.sessions ?? []).some(item => item.running || item.name !== 'default')) throw new Error('Fixture HOME unexpectedly contains sessions');
    server = spawn('herdr', ['--session', session, 'server'], { cwd, env, detached: true, stdio: 'ignore' });
    server.once('error', error => { serverError = error; });
    await waitFor(async () => {
      if (serverError) throw serverError;
      if (server.exitCode !== null || server.signalCode !== null) throw new Error('Isolated daemon exited before readiness');
      try { return (await json(['api', 'snapshot']))?.snapshot; } catch { return false; }
    }, 'daemon startup');
    const panes = new Set();
    const own = pane => { if (!panes.has(pane)) throw new Error('Pane does not belong to this harness'); };
    return await test({ directory, cwd, env, session, client, herdr, json,
      async createSpace(label = 'fixture') {
        const path = mkdtempSync(join(cwd, 'space-'));
        const result = await json(['workspace', 'create', '--cwd', path, '--label', label, '--no-focus']);
        const pane = result.root_pane.pane_id;
        panes.add(pane);
        return { workspace: result.workspace.workspace_id, tab: result.tab.tab_id, pane, cwd: path };
      },
      async createPane(pane, direction = 'right') {
        own(pane);
        const result = await json(['pane', 'split', pane, '--direction', direction, '--cwd', cwd, '--no-focus']);
        panes.add(result.pane.pane_id);
        return result.pane.pane_id;
      },
      readVisible(pane, ansi = false) {
        own(pane);
        return herdr(['pane', 'read', pane, '--source', 'visible', '--format', ansi ? 'ansi' : 'text']);
      },
    });
  } catch (error) {
    error.message += `\nRun: ${retry}`;
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await cleanup();
  }
}
