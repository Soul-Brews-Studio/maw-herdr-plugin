// git in a repo, never prompting; a failure carries git's last stderr line as
// err.detail. gitLine is the same call as a command a person can paste.
import { execFile } from 'node:child_process';
import { shq } from './mod.target.mjs';

export function git(repo, args, { timeout = 30_000 } = {}) {
  return new Promise((ok, fail) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    execFile('git', ['-C', repo, ...args], { encoding: 'utf8', timeout, maxBuffer: 32 << 20, env }, (err, stdout, stderr) => {
      if (!err) return ok(stdout);
      err.detail = String(stderr || err.message || '').trim().split('\n').pop();
      fail(err);
    });
  });
}

export const gitLine = (repo, args) => ['git', '-C', repo, ...args].map(shq).join(' ');
