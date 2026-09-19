import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir, constants } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

// Resolve the executable entry, not import.meta.url: Bun installs a root bundle.
export async function runServe(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`maw herdr serve --token-file PATH [--listen 127.0.0.1:3457]
                [--herdr PATH] [--data-dir PATH] [--build]

Core dashboard API: sessions, live pane output and prompt submission.
The token file is required, including on loopback. Help needs no Go or Herdr.
Uses the checksum-pinned bin/maw-herdr-serve from a prebuilt plugin package.
No Go compiler is required for packaged installs. Source developers may use
--build to compile into a user cache, or MAW_HERDR_SERVE_BIN for an explicit binary.
Host-managed serving uses engine.serve (native --engine), not this launcher's build mode.`);
    return 0;
  }
  const build = args.includes('--build');
  if (build && args.includes('--engine')) throw new Error('serve: engine startup cannot build; install a prebuilt package');
  args = args.filter(arg => arg !== '--build');
  const root = dirname(realpathSync(process.argv[1]));
  const supplied = process.env.MAW_HERDR_SERVE_BIN;
  let binary = supplied ? resolve(supplied) : join(root, 'bin', 'maw-herdr-serve');
  const execute = (command, argv, options = {}) => new Promise((resolveExit, reject) => {
    const child = spawn(command, argv, { stdio: 'inherit', ...options });
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const handlers = signals.map(signal => () => { if (!child.killed) child.kill(signal); });
    signals.forEach((signal, i) => process.on(signal, handlers[i]));
    const cleanup = () => signals.forEach((signal, i) => process.off(signal, handlers[i]));
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolveExit(code ?? 128 + (constants.signals[signal] ?? 1)); });
  });
  if (!supplied && existsSync(binary)) {
    const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
    const pins = Array.isArray(manifest.bundledArtifacts) ? manifest.bundledArtifacts.filter(item => item.path === 'bin/maw-herdr-serve') : [];
    if (pins.length !== 1 || !/^sha256:[0-9a-f]{64}$/.test(pins[0].sha256)) throw new Error('serve: missing or invalid bundled helper checksum');
    if (!lstatSync(binary).isFile() || !realpathSync(binary).startsWith(root + sep)) throw new Error('serve: bundled helper must be a regular file inside the plugin');
    const observed = 'sha256:' + createHash('sha256').update(readFileSync(binary)).digest('hex');
    if (observed !== pins[0].sha256) throw new Error('serve: bundled helper sha256 mismatch; reinstall the prebuilt package');
  }
  if (!supplied && !existsSync(binary)) {
    if (!build) throw new Error('serve: install a prebuilt package, or use --build for source development; no implicit Go compilation');
    const source = join(root, 'server');
    if (!existsSync(join(source, 'go.mod'))) {
      throw new Error('serve: --build requires a complete source checkout; install a prebuilt package or set MAW_HERDR_SERVE_BIN');
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
