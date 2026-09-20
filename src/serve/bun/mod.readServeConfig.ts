import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loopbackHost } from './mod.loopbackHost.ts';
import type { ServeConfig } from './serverTypes.ts';

export function readServeConfig(args: string[]): ServeConfig {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const [key, ...inline] = args[i].split('=');
    if (!['--engine', '--listen', '--token-file', '--herdr', '--data-dir', '--wake-engine'].includes(key) || flags.has(key)) {
      throw new Error(`serve: unknown or duplicate option ${key}`);
    }
    const value = key === '--engine' ? 'true' : inline.length ? inline.join('=') : args[++i];
    if (!value || (key === '--engine' && inline.length)) throw new Error(`serve: invalid ${key}`);
    flags.set(key, value);
  }
  const wakeEngine = flags.get('--wake-engine') || 'claude';
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
  } else {
    const path = flags.get('--token-file');
    if (!path) throw new Error('--token-file is required; never pass operator tokens on the command line');
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077)) {
        throw new Error('must be a regular file <=4096 bytes, readable only by its owner (chmod 600)');
      }
      token = readFileSync(fd, 'utf8').trim();
    } catch (error) { throw new Error(`token file: ${(error as Error).message}`); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  if (Buffer.byteLength(token) < 16 || Buffer.byteLength(token) > 4096) throw new Error('operator token must contain 16..4096 bytes');
  const match = /^(?:\[([^\]]+)\]|([^:]+)):([0-9]+)$/.exec(listen);
  if (!match || !loopbackHost(match[1] || match[2]) || Number(match[3]) > 65535) {
    throw new Error('--listen must use a loopback IP or localhost and port');
  }
  const configHome = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return { worktreeRoot: process.cwd(), hostname: match[1] || match[2], port: Number(match[3]), token, engine, wakeEngine, node: 'herdr',
    binary: flags.get('--herdr') || 'herdr', dataDir: flags.get('--data-dir') || join(configHome, 'maw-herdr', 'serve') };
}
