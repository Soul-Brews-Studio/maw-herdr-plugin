// herdr from PATH with --session when one is known; errors end in the command to
// run. The calls the layout verbs (#88) make, and the reads they verify with.
import { execFile } from 'node:child_process';
import { TargetError, shq } from './mod.target.mjs';

function run(file, args, { timeout = 15_000 } = {}) {
  return new Promise((ok, fail) => {
    execFile(file, args, { encoding: 'utf8', timeout, maxBuffer: 32 << 20 }, (err, stdout, stderr) => {
      if (err) {
        err.detail = String(stderr || err.message || '').trim().split('\n')[0];
        fail(err);
      } else ok(stdout);
    });
  });
}

export const withSessionFlag = (args, session) => (session ? ['--session', session, ...args] : args);
export const herdrLine = (args, session) => ['herdr', ...withSessionFlag(args, session)].map(shq).join(' ');

export async function herdr(args, session) {
  try {
    return await run('herdr', withSessionFlag(args, session));
  } catch (err) {
    if (err?.code === 'ENOENT') throw new TargetError('herdr is not on PATH\n  command -v herdr || echo "herdr not on PATH: $PATH"', 'not-found');
    throw new TargetError(`herdr ${args.slice(0, 2).join(' ')} failed — ${err.detail || err.message}\n  ${herdrLine(args, session)}`, 'herdr');
  }
}

export async function herdrJson(args, session) {
  const text = await herdr(args, session);
  try {
    return JSON.parse(text);
  } catch {
    throw new TargetError(`herdr ${args.slice(0, 2).join(' ')} returned something that is not JSON (${JSON.stringify(String(text).trim().slice(0, 60))}) — see what it prints:\n  ${herdrLine(args, session)}`, 'herdr');
  }
}

export async function paneInfo(pane, session) {
  const p = (await herdrJson(['pane', 'get', pane], session)).result?.pane;
  if (!p?.tab_id) throw new TargetError(`herdr has no pane ${pane}${session ? ` in session ${session}` : ''}\n  see every pane: maw herdr ls --agents`, 'not-found');
  return p;
}

export async function spaceList(session) {
  return (await herdrJson(['workspace', 'list'], session)).result?.workspaces ?? [];
}

export async function tabLayout(pane, session) {
  return (await herdrJson(['pane', 'layout', '--pane', pane], session)).result?.layout ?? null;
}
