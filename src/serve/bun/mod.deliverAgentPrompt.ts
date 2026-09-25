import { readRoster } from './mod.readRoster.ts';
import { composerMatchesSent, lastNonEmptyLine, parseComposer, QUEUED_MARKER, visibleText } from './mod.parseComposer.ts';
import { BackendError, type RunHerdr, type SendReceipt } from './types.ts';

const SETTLE_MS = 250, POLLS = 4;

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new BackendError('backend_error', 'herdr operation aborted')); return; }
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); reject(new BackendError('backend_error', 'herdr operation aborted')); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Submit one prompt into an agent pane with the checks legacy maw-tmux
 * send_text made around a raw literal+Enter (maw-rs 76f1308
 * pane_text_send_methods.rs), rebuilt on herdr's own verbs:
 *
 * 1. Resolve the target from a fresh roster; refuse shells and blocked agents.
 * 2. Read the input box and refuse a draft someone is typing: herdr would
 *    append to it and submit both.
 * 3. Re-read the roster right before submitting. The pane, its agent and its
 *    cwd must be unchanged, so a pane that was closed and reused cannot
 *    receive a prompt meant for its predecessor.
 * 4. `herdr agent prompt` by exact pane id.
 * 5. Watch the box for a bounded moment: queued marker, emptied box, or our
 *    own text still sitting there (one extra Enter, as legacy retried).
 *
 * The receipt names what was observed and nothing more. `accepted` is herdr
 * taking the prompt; `delivered` is the box observed empty afterwards;
 * `queued` is the agent saying it queued it. None means the agent read it.
 */
export async function deliverAgentPrompt(run: RunHerdr, target: string, text: string, signal: AbortSignal): Promise<SendReceipt> {
  const pane = (await readRoster(run, signal)).targets.get(target);
  if (!pane) throw new BackendError('target_not_found', 'unknown or stale target');
  const { session, pane: { id } } = pane;
  const inspect = `herdr --session ${session} pane read ${id} --source visible`;
  if (!pane.pane.agent.trim()) throw new BackendError('target_not_agent', 'target is not an agent pane', `herdr --session ${session} agent list`);
  if (pane.pane.status === 'blocked') throw new BackendError('target_blocked', `agent in ${id} is blocked waiting for its own input`, inspect);
  const read = () => run(['--session', session, 'pane', 'read', id, '--source', 'visible', '--format', 'ansi'], signal);
  const before = parseComposer(await read());
  if (before.state === 'pending') throw new BackendError('composer_not_empty', `input box in ${id} already holds text; submit or clear it first`, inspect);
  const fresh = (await readRoster(run, signal)).targets.get(target);
  if (!fresh || fresh.session !== session || fresh.pane.id !== id || fresh.pane.agent !== pane.pane.agent || fresh.pane.cwd !== pane.pane.cwd) {
    throw new BackendError('target_changed', `pane ${id} changed between resolution and delivery`, `herdr --session ${session} agent list`);
  }
  if (fresh.pane.status === 'blocked') throw new BackendError('target_blocked', `agent in ${id} is blocked waiting for its own input`, inspect);
  await run(['--session', session, 'agent', 'prompt', id, text], signal);

  const evidence = ['herdr agent prompt accepted'];
  let state: SendReceipt['state'] = 'accepted', lastLine = '', retried = false;
  for (let poll = 0; poll < POLLS; poll++) {
    await sleep(SETTLE_MS, signal);
    let screen;
    try { screen = await read(); }
    catch { evidence.push('input box unreadable after submit; delivery not confirmed'); break; }
    lastLine = lastNonEmptyLine(screen);
    if (visibleText(screen, true).split('\n').slice(-8).some(line => line.includes(QUEUED_MARKER))) { state = 'queued'; evidence.push('agent shows the prompt as queued'); break; }
    const after = parseComposer(screen);
    if (after.state === 'empty') { state = 'delivered'; evidence.push('input box observed empty after submit'); break; }
    if (after.state === 'unknown') { evidence.push(before.state === 'unknown' ? 'no input box recognised; delivery not confirmed' : 'input box no longer recognised; delivery not confirmed'); break; }
    if (!composerMatchesSent(after.text, text)) { evidence.push('input box holds different text after submit; delivery not confirmed'); break; }
    if (poll === POLLS - 1) { evidence.push('sent text still in input box after Enter retry; delivery not confirmed'); break; }
    if (poll === 1 && !retried) {
      // Our own text is still in the box: the Enter was swallowed with the
      // paste. A second Enter submits exactly what we sent, nothing else.
      retried = true;
      await run(['--session', session, 'pane', 'send-keys', id, 'enter'], signal);
      evidence.push('Enter retried once');
    }
  }
  return { state, lastLine, evidence };
}
