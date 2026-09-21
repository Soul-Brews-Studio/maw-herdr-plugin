import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readMawConfig, projectMawConfig } from './mod.readMawConfig.ts';
import { loopbackHost } from './mod.loopbackHost.ts';
import type { ServeConfig } from './serverTypes.ts';

export function readServeConfig(args: string[]): ServeConfig {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const [key, ...inline] = args[i].split('=');
    const BARE = ['--engine', '--insecure-no-token'];
    if (![...BARE, '--listen', '--token-file', '--herdr', '--data-dir', '--wake-engine', '--demo-minutes'].includes(key) || flags.has(key)) {
      throw new Error(`serve: unknown or duplicate option ${key}`);
    }
    const value = BARE.includes(key) ? 'true' : inline.length ? inline.join('=') : args[++i];
    if (!value || (BARE.includes(key) && inline.length)) throw new Error(`serve: invalid ${key}`);
    flags.set(key, value);
  }
  const wakeEngine = flags.get('--wake-engine') || 'codex';
  if (!['pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp', 'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok', 'hermes', 'kilo', 'qodercli', 'qwen', 'maki', 'muse'].includes(wakeEngine)) throw new Error('--wake-engine must be a supported Herdr agent kind');
  let listen = flags.get('--listen') || '127.0.0.1:3457';
  let token: string;
  const engine = flags.has('--engine');
  if (engine) {
    if (flags.has('--listen') || flags.has('--token-file')) throw new Error('--engine cannot be combined with --listen or --token-file');
    token = (process.env.MAW_SERVE_TOKEN || '').trim();
    const port = process.env.MAW_ENGINE_SERVE_PORT || '';
    if (!/^[1-9][0-9]*$/.test(port) || Number(port) > 65535) throw new Error('--engine requires MAW_ENGINE_SERVE_PORT in 1..65535');
    if (process.env.PORT && process.env.PORT !== port) throw new Error('PORT must match MAW_ENGINE_SERVE_PORT');
    if (process.env.MAW_ENGINE_SERVE_PREFIX !== '/api/herdr') throw new Error('MAW_ENGINE_SERVE_PREFIX must be /api/herdr');
    listen = `127.0.0.1:${port}`;
  } else if (flags.has('--insecure-no-token')) {
    if (flags.has('--token-file')) throw new Error('--insecure-no-token cannot be combined with --token-file');
    token = '';
  } else {
    const path = flags.get('--token-file');
    if (!path) throw new Error('--token-file is required; never pass operator tokens on the command line\n'
      + '  test -e ~/.maw-herdr-token || (umask 077; openssl rand -hex 32 > ~/.maw-herdr-token)\n'
      + '  maw herdr serve --token-file ~/.maw-herdr-token --listen 127.0.0.1:3457\n'
      + '  maw herdr serve --insecure-no-token --listen 127.0.0.1:3457   (read-only demo, self-stopping)');
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077)) {
        throw new Error('must be a regular file <=4096 bytes, readable only by its owner\n'
          + `  chmod 600 ${path}`);
      }
      token = readFileSync(fd, 'utf8').trim();
    } catch (error) { throw new Error(`token file: ${(error as Error).message}`); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  if (!flags.has('--insecure-no-token') && (Buffer.byteLength(token) < 16 || Buffer.byteLength(token) > 4096)) throw new Error('operator token must contain 16..4096 bytes');
  const match = /^(?:\[([^\]]+)\]|([^:]+)):([0-9]+)$/.exec(listen);
  if (!match || !loopbackHost(match[1] || match[2]) || Number(match[3]) > 65535) {
    throw new Error('--listen must use a loopback IP or localhost and port');
  }
  const configHome = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const insecure = flags.has('--insecure-no-token');
  const rawMinutes = flags.get('--demo-minutes');
  if (rawMinutes !== undefined && !insecure) throw new Error('--demo-minutes only applies to --insecure-no-token');
  if (rawMinutes !== undefined && !/^[1-9][0-9]{0,3}$/.test(rawMinutes)) throw new Error('--demo-minutes must be 1..9999');
  // A tokenless listener that outlives the demo is the actual hazard, so it
  // always expires; the flag only moves the deadline.
  const demoMinutes = insecure ? Number(rawMinutes ?? 30) : 0;
  return { worktreeRoot: process.cwd(), hostname: match[1] || match[2], port: Number(match[3]), token, engine, insecure, demoMinutes, wakeEngine, explicitWakeEngine: flags.get('--wake-engine'), ...projectMawConfig(readMawConfig()),
    binary: flags.get('--herdr') || 'herdr', dataDir: flags.get('--data-dir') || join(configHome, 'maw-herdr', 'serve') };
}
