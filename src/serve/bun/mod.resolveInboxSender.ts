import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { runHerdr } from './mod.runHerdr.ts';

/** Legacy display attribution, not a verified or signed sender identity. */
export async function resolveInboxSender(raw: string, config: Record<string, unknown>, serverRoot: string, signal: AbortSignal): Promise<string> {
  raw = raw.trim();
  if (raw) {
    const colon = raw.indexOf(':');
    if (colon >= 0) {
      const oracle = raw.slice(0, colon).trim(), node = raw.slice(colon + 1).trim();
      if (oracle && node) return `${node}:${oracle}`;
    }
    return raw;
  }
  const tmuxWindow = async (pane?: string) => {
    try { return (await runHerdr('tmux', ['display-message', ...(pane ? ['-t', pane] : []), '-p', '#{window_name}'], signal)).trim(); }
    catch { return ''; }
  };
  const windowOracle = (value: string) => {
    value = value.trim();
    const colon = value.indexOf(':');
    return (colon >= 0 ? value.slice(colon + 1) : value).trim().replace(/\.[0-9]+$/, '').trim();
  };
  const clean = (value: string) => {
    const first = value.trim().replace(/^["'`]+|["'`]+$/g, '').split(/[ \t@(\[]/, 1)[0].replace(/(?:\.git)+$/, '').replace(/(?:-oracle)+$/, '');
    return /^[A-Za-z0-9_-]+$/.test(first) ? first : '';
  };
  let oracle = process.env.TMUX_PANE?.trim() ? await tmuxWindow(process.env.TMUX_PANE) : '';
  if (!oracle) {
    for (let dir = serverRoot;; dir = dirname(dir)) {
      let fd: number | undefined;
      try {
        // Follow the ordinary CLAUDE.md -> AGENTS.md link, but never block on
        // a FIFO or trust a path stat before opening the actual descriptor.
        fd = openSync(join(dir, 'CLAUDE.md'), constants.O_RDONLY | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        if (stat.isFile() && stat.size <= 1024 * 1024) {
          const buffer = Buffer.alloc(1024 * 1024 + 1);
          let length = 0;
          while (length < buffer.length) {
            const n = readSync(fd, buffer, length, buffer.length - length, null);
            if (!n) break;
            length += n;
          }
          const text = length <= 1024 * 1024 ? new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)) : '';
          for (const line of text.split(/\r?\n/).slice(0, 120)) {
            const trimmed = line.trim().replace(/^[#*-]+/, '').trim();
            const prefix = /^(?:oracle:|oracle =|identity:|name:)/i.exec(trimmed);
            oracle = prefix ? clean(trimmed.slice(prefix[0].length)) : '';
            if (!oracle && trimmed.endsWith('-oracle')) oracle = clean(trimmed);
            if (oracle) break;
          }
        }
      } catch { /* Missing or unreadable markers do not establish identity. */ }
      finally { if (fd !== undefined) closeSync(fd); }
      if (oracle || dirname(dir) === dir) break;
    }
  }
  oracle ||= windowOracle(process.env.MAW_SESSION_WINDOW ?? '');
  oracle ||= typeof config.oracle === 'string' ? config.oracle.trim() : '';
  if (!oracle && process.env.TMUX?.trim()) oracle = `pane/${windowOracle(await tmuxWindow()) || 'mawjs'}`;
  if (!oracle) {
    for (let dir = serverRoot;; dir = dirname(dir)) {
      if (existsSync(join(dir, '.git'))) { oracle = `job/${basename(dir)}`; break; }
      if (dirname(dir) === dir) break;
    }
  }
  const node = typeof config.node === 'string' ? config.node : 'local';
  return `${node}:${oracle || 'pane/unknown'}`;
}
