// The caller (checked against the process tree: HERDR_PANE_ID goes stale when a pane
// moves) and the panes a join/break target names (#88).
import { TargetError, callerFromEnv, classifyTarget, resolveAgent } from './mod.target.mjs';
import { verifyCaller } from './mod.verifyCaller.mjs';
import { paneInfo } from './mod.herdrCall.mjs';

export function here(verb) {
  const env = callerFromEnv();
  if (!env?.pane) {
    throw new TargetError(`${verb} works on the tab you are in, and HERDR_PANE_ID is not set here — this is not a herdr pane\n  open herdr and run it inside: herdr`, 'no-self');
  }
  return verifyCaller(env);
}

export async function resolveMovable(all, raw, verb, me, session) {
  const form = classifyTarget(raw);
  // a pane id names any pane, a shell included; the roster lists agents only
  if (form.form === 'pane' && !all.some(a => a.pane === form.value)) {
    const p = await paneInfo(form.value, session);
    return { pane: p.pane_id, agent: p.agent ?? null, name: null, session, cwd: p.cwd ?? null, how: 'pane id' };
  }
  // self may be a shell too
  if (form.form === 'self' && !all.some(a => a.pane === me.pane)) {
    const p = await paneInfo(me.pane, session);
    return { pane: p.pane_id, agent: p.agent ?? null, name: null, session, cwd: p.cwd ?? null, how: 'self' };
  }
  return resolveAgent(all, raw, verb, { caller: me });
}
