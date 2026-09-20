import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HTTPError } from './serverTypes.ts';
import type { Backend } from './types.ts';
import { readJSON } from './mod.readJSON.ts';
import { runHerdr } from './mod.runHerdr.ts';

export async function serveWorktrees(request: Request, path: string, startupRoot: string, backend: Backend, signal: AbortSignal) {
  const cleanup = path === '/api/worktrees/cleanup';
  const safe = (value: string) => !!value && value.trim() === value && !value.startsWith('-') && !/[\x00-\x1f\x7f-\x9f]/.test(value);
  const canonical = (value: string) => { try { return realpathSync(value); } catch { return value; } };
  const within = (root: string, value: string) => { const child = relative(root, value); return child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child); };
  const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(gitEnvironment, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  const git = (args: string[]) => runHerdr('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', startupRoot, ...args], signal, gitEnvironment);
  const scan = async () => {
    const raw = await git(['worktree', 'list', '--porcelain', '-z']);
    if (!raw.endsWith('\0\0')) throw new Error('invalid worktree inventory');
    const groups = raw.slice(0, -2).split('\0\0');
    if (groups.length > 128) throw new Error('worktree count exceeds limit');
    const seen = new Set<string>();
    return groups.map(group => {
      const lines = group.split('\0');
      if (!lines[0].startsWith('worktree ')) throw new Error('invalid worktree inventory');
      const original = lines[0].slice(9);
      if (!isAbsolute(original) || seen.has(original)) throw new Error('invalid worktree inventory');
      seen.add(original);
      const branch = lines.find(line => line.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') || 'unknown';
      return { path: canonical(original), branch: safe(branch) ? branch : 'unknown', prunable: lines.some(line => line === 'prunable' || line.startsWith('prunable ')) };
    });
  };
  try {
    if (!safe(startupRoot)) throw new Error('invalid startup root');
    if (!cleanup) {
      const entries = await scan();
      return entries.map(entry => {
        const base = basename(entry.path), repo = safe(base) ? base : 'worktree';
        const rootName = basename(startupRoot), mainRepo = safe(rootName) ? rootName : repo;
        const separator = repo.indexOf('.wt-');
        return { path: entry.path, branch: entry.branch, repo, mainRepo, name: separator >= 0 ? repo.slice(separator + 4) : repo, status: entry.prunable ? 'orphan' : 'stale' };
      }).sort((left,right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    }
    const body = await readJSON(request, 8192, signal);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('path' in body) || typeof body.path !== 'string' || Object.keys(body).some(key => key !== 'path')) throw new Error('invalid cleanup request');
    const raw = body.path;
    if (!isAbsolute(raw) || !safe(raw) || raw.split(/[\/\\]/).some(segment => segment === '..' || segment === '.' || segment.startsWith('-'))) throw new Error('invalid cleanup path');
    const root = realpathSync(startupRoot), target = realpathSync(raw), parent = dirname(root);
    const validate = async () => {
      const entries = await scan();
      if (target === root || target === entries[0]?.path || !within(parent,target) || !existsSync(join(target,'.git')) || !entries.some(entry => entry.path === target) || realpathSync(raw) !== target) throw new Error('unregistered or unsafe target');
    };
    await validate();
    const sessions = await backend.sessions(signal);
    for (const session of sessions) for (const window of session.windows) {
      if (window.cwd && !isAbsolute(window.cwd)) throw new Error('unresolved active worktree');
      if (window.cwd && within(target,canonical(resolve(window.cwd)))) throw new Error('active worktree');
    }
    await validate();
    const output = (await git(['worktree', 'remove', '--', target])).trim();
    return { ok: true, path: target, log: output ? [output] : [] };
  } catch { throw new HTTPError(cleanup ? 400 : 500, cleanup ? 'worktree_cleanup_rejected' : 'worktrees_unavailable'); }
}
