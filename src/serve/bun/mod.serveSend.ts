import type { createDeliveryFeed } from './mod.createDeliveryFeed.ts';
import type { createDeliveryDedup } from './mod.createDeliveryDedup.ts';
import { claimDelivery } from './mod.claimDelivery.ts';
import { formatSenderMessage } from './mod.formatSenderMessage.ts';
import { readJSON } from './mod.readJSON.ts';
import { readMawConfig } from './mod.readMawConfig.ts';
import { recordDelivery } from './mod.recordDelivery.ts';
import { resolveInboxSender } from './mod.resolveInboxSender.ts';
import { validateCommand } from './mod.validateCommand.ts';
import { HTTPError, type ServeConfig } from './serverTypes.ts';
import { BackendError, type Backend } from './types.ts';

const STATUS: Record<string, number> = { target_not_found: 404, target_not_agent: 409, target_blocked: 409, composer_not_empty: 409, target_changed: 409 };

/** A herdr command with real values that lists what a dashboard target can name. */
function targetHint(target: string): string {
  const [session] = target.split('/', 1);
  let name = '';
  try { name = Buffer.from(session, 'base64url').toString('utf8'); } catch { /* not a dashboard target */ }
  return /^[A-Za-z0-9_.-]{1,128}$/.test(name) && Buffer.from(name).toString('base64url') === session ? `herdr --session ${name} agent list` : 'herdr session list';
}

/** Legacy-shaped delivery failure: ok/error/target/detail/state, plus the command that shows why. */
function refusal(error: unknown, target: string): HTTPError | unknown {
  if (!(error instanceof BackendError)) return error;
  const code = error.code === 'backend_error' ? 'herdr_unavailable' : error.code;
  const hint = error.hint ?? (error.code === 'target_not_found' ? targetHint(target) : 'herdr session list');
  return new HTTPError(STATUS[error.code] ?? 503, code, { ok: false, error: code, target, detail: error.message.slice(0, 1000), state: 'failed', hint });
}

/**
 * POST /api/send, restoring legacy maw-rs serve_deliver_send (76f1308):
 * literal attachments joined before the text, inbox delivery without pane
 * injection, the sender tag on normal delivery, timestamp idempotency and a
 * lifecycle record for every outcome. Operator auth is enforced before this
 * runs; `force` stays unsupported because legacy SendBody has no such field.
 */
export async function serveSend(request: Request, config: ServeConfig, backend: Backend, signal: AbortSignal, delivery?: ReturnType<typeof createDeliveryDedup>, history?: ReturnType<typeof createDeliveryFeed>): Promise<unknown> {
  let body;
  try { body = validateCommand(await readJSON(request, 64 << 10, signal)); }
  catch (error) { if (error instanceof HTTPError) throw error; throw new HTTPError(400, 'invalid_json'); }
  const originalText = body.text;
  if (body.attachments?.length) body.text = [...body.attachments, body.text ?? ''].join('\n');
  if (!body.target || /^\p{White_Space}*$/u.test(body.target)) {
    history?.append({timestamp:Math.floor(Date.now()/1000),kind:'message',direction:'inbound',state:'failed',route:'validate',target:body.target ?? '',text:body.text ?? '',from:'',to:'',oracle:'',source:'herdr',error:'empty-target'});
    throw new HTTPError(400, 'empty-target', {ok:false,error:'empty-target',state:'failed'});
  }
  if (body.inbox) {
    if (!backend.inbox) throw new HTTPError(501, 'send_options_not_supported');
    const claim = await claimDelivery(request, body.target, body.text ?? '', originalText ?? '', 'inbox', config, backend, delivery, signal);
    if (claim.duplicate) {
      await recordDelivery(history, backend, request, body.target, body.text ?? '', 'inbox', 'deduped', signal);
      return claim.duplicate;
    }
    try {
      const inbox = await backend.inbox(body.target, body.text ?? '', config.worktreeRoot, request.headers.get('X-Maw-From') ?? '', signal);
      claim.complete('queued');
      await recordDelivery(history, backend, request, body.target, body.text ?? '', 'inbox', 'queued', signal);
      return { ok: true, target: body.target, text: originalText ?? '', source: 'inbox', state: 'queued', inbox,
        reason: '--inbox requested; pane injection skipped', receipt: ['fallback_queued'] };
    } catch (error) {
      await recordDelivery(history, backend, request, body.target, body.text ?? '', 'inbox', 'failed', signal, { error: error instanceof BackendError ? error.code : 'inbox_failed' });
      throw error;
    } finally { claim.cancel(); }
  }
  // Legacy sends "[sender] " for empty text; an empty turn is not worth a
  // fabricated prompt, so empty text without attachments stays refused.
  if (!body.text) throw new HTTPError(400, 'target_and_text_required');
  if (body.force) throw new HTTPError(501, 'send_options_not_supported');
  const target = body.target, message = body.text;
  const rawFrom = request.headers.get('X-Maw-From') ?? '';
  if (Buffer.byteLength(rawFrom) > 1024) throw new HTTPError(400, 'invalid_delivery_metadata');
  const claim = await claimDelivery(request, target, message, message, 'local', config, backend, delivery, signal);
  if (claim.duplicate) {
    await recordDelivery(history, backend, request, target, message, 'local', 'deduped', signal);
    return claim.duplicate;
  }
  let local = '';
  try {
    const colon = rawFrom.indexOf(':');
    if (!(colon > 0 && colon < rawFrom.length - 1)) local = await resolveInboxSender('', readMawConfig(config.worktreeRoot), config.worktreeRoot, signal);
    const receipt = await backend.send(target, formatSenderMessage(message, rawFrom, local), signal);
    claim.complete(receipt.state);
    await recordDelivery(history, backend, request, target, message, 'local', receipt.state, signal, { from: local, lastLine: receipt.lastLine });
    return { ok: true, target, text: message, source: 'local', lastLine: receipt.lastLine, state: receipt.state, receipt: receipt.evidence,
      warning: 'The receipt reports what herdr and the input box showed; it does not mean the agent has read or completed the prompt. This path does not queue an inbox message.' };
  } catch (error) {
    await recordDelivery(history, backend, request, target, message, 'local', 'failed', signal, { from: local, error: error instanceof BackendError ? (error.code === 'backend_error' ? 'herdr_unavailable' : error.code) : 'send_failed' });
    throw refusal(error, target);
  } finally { claim.cancel(); }
}
