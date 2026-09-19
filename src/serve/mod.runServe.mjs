import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir, constants } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Resolve the executable entry, not import.meta.url: Bun installs a root bundle.
export async function runServe(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`maw herdr serve --token-file PATH [--listen 127.0.0.1:3457]
                [--herdr PATH] [--data-dir PATH]

Core dashboard API: sessions, live pane output and prompt submission.
The token file is required, including on loopback. Help needs no Go or Herdr.
Uses MAW_HERDR_SERVE_BIN or server/bin/maw-herdr-serve when supplied;
otherwise builds the bundled server source with Go into your user cache.`);
    return 0;
  }
  const root = dirname(realpathSync(process.argv[1]));
  const supplied = process.env.MAW_HERDR_SERVE_BIN;
  let binary = supplied ? resolve(supplied) : join(root, 'server', 'bin', 'maw-herdr-serve');
  const execute = (command, argv, options = {}) => new Promise((resolveExit, reject) => {
    const child = spawn(command, argv, { stdio: 'inherit', ...options });
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const handlers = signals.map(signal => () => { if (!child.killed) child.kill(signal); });
    signals.forEach((signal, i) => process.on(signal, handlers[i]));
    const cleanup = () => signals.forEach((signal, i) => process.off(signal, handlers[i]));
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolveExit(code ?? 128 + (constants.signals[signal] ?? 1)); });
  });
  if (!supplied && !existsSync(binary)) {
    const source = join(root, 'server');
    if (!existsSync(join(source, 'go.mod'))) {
      throw new Error('serve: bundled server source is missing; reinstall the complete plugin or set MAW_HERDR_SERVE_BIN');
    }
    const digest = createHash('sha256').update(`${process.platform}/${process.arch}\0`);
    const pending = [''];
    while (pending.length) {
      const relative = pending.pop();
      for (const name of readdirSync(join(source, relative)).sort()) {
        if (!relative && (name === 'bin' || name.startsWith('.'))) continue;
        const path = join(relative, name);
        const stat = lstatSync(join(source, path));
        if (stat.isSymbolicLink()) throw new Error(`serve: source symlink is not supported: ${path}`);
        if (stat.isDirectory()) pending.push(path);
        else if (stat.isFile()) digest.update(path).update('\0').update(readFileSync(join(source, path))).update('\0');
      }
    }
    const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'maw-herdr', 'serve');
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    binary = join(cache, digest.digest('hex'));
    if (!existsSync(binary)) {
      const temporary = mkdtempSync(join(cache, '.build-'));
      try {
        const output = join(temporary, 'maw-herdr-serve');
        const arch = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' }[process.arch];
        if (!arch || !['linux', 'darwin'].includes(process.platform)) throw new Error('serve: automatic builds support Linux/macOS; set MAW_HERDR_SERVE_BIN');
        console.error('maw herdr: building dashboard server into user cache');
        const code = await execute('go', ['build', '-trimpath', '-o', output, '.'], {
          cwd: source,
          env: { ...process.env, GOWORK: 'off', GOFLAGS: '', CGO_ENABLED: '0', GOOS: process.platform, GOARCH: arch },
        });
        if (code !== 0) return code;
        renameSync(output, binary);
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error('serve: Go is required for source installs; install Go or set MAW_HERDR_SERVE_BIN');
        throw error;
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
  }
  return execute(binary, args);
}
