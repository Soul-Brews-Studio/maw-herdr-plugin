/**
 * `maw herdr a <target>` (#82): bring a target to the front — the herdr form of
 * `maw tmux a`. tmux runs `switch-client` inside tmux and attaches outside it;
 * here the pane is focused over its session's socket (`pane.focus`, which also
 * raises its tab and workspace), and the session is attached only when the caller
 * is not already a client of it.
 *
 * Focusing never types into the pane, sends keys, or wakes anything.
 */
import { request } from './mod.herdrSocket.mjs';
import { describeResolved, requirePane, resolveLive, shq } from './mod.target.mjs';
import { sessionSocket } from './mod.watch.mjs';

/**
 * Resolve a target to the pane to bring forward, and say what bringing it means
 * from where the caller sits. Never acts.
 *   here  — the caller is a pane of the same herdr session: focusing is enough
 *   other — the caller is inside herdr, but a client shows one session at a time
 *   away  — the caller is outside herdr: focus, then attach the session
 */
export async function planFocus(raw, { caller = null, cwd = process.cwd(), session = null } = {}) {
  const r = await resolveLive(raw, { verb: 'a', cwd, session });
  const pane = requirePane(r, 'a');
  const where = !caller ? 'away' : caller.session === r.session ? 'here' : 'other';
  return { r, pane, session: r.session, where };
}

/** Make `pane` the active pane of `session`, through herdr's own socket API. */
export async function focusPane(session, pane, { socketFor = sessionSocket } = {}) {
  const socket = await socketFor(session);
  try {
    await request(socket, 'pane.focus', { pane_id: pane });
  } catch (err) {
    throw new Error(`herdr did not focus ${pane} in session '${session}': ${err.message}\n  maw herdr resolve --session ${shq(session)} ${pane}`);
  }
}

/** What `--dry` prints: the resolution, then exactly what `a` would do. */
export function describeFocus(plan, attachLine) {
  const lines = describeResolved(plan.r);
  const action = plan.where === 'here'
    ? `focus ${plan.pane} in this herdr session`
    : plan.where === 'other'
      ? `focus ${plan.pane} in session '${plan.session}', then print how to switch to it`
      : `focus ${plan.pane} in session '${plan.session}', then attach: ${attachLine}`;
  lines.push(`    would  ${action}`);
  return lines;
}
