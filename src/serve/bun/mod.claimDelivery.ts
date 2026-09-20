import { createDeliveryDedup } from './mod.createDeliveryDedup.ts';
import { readMawConfig } from './mod.readMawConfig.ts';
import { resolveInboxSender } from './mod.resolveInboxSender.ts';
import { HTTPError, type ServeConfig } from './serverTypes.ts';
import type { Backend } from './types.ts';

/** Correlation metadata under operator auth; these headers do not verify identity. */
export async function claimDelivery(request: Request, target: string, text: string, responseText: string, source: string, config: ServeConfig, backend: Backend, store: ReturnType<typeof createDeliveryDedup> | undefined, signal: AbortSignal) {
  const logical = request.headers.get('X-Maw-Timestamp')?.trim() || request.headers.get('X-Maw-Signed-At')?.trim();
  if (!logical) return { complete(_state: string) {}, cancel() {}, duplicate: undefined };
  const rawFrom = request.headers.get('X-Maw-From') || '';
  if (Buffer.byteLength(logical) > 1024 || Buffer.byteLength(rawFrom) > 1024) throw new HTTPError(400, 'invalid_delivery_metadata');
  if (!store) throw new HTTPError(503, 'delivery_store_unavailable');
  const sessions = await backend.sessions(signal);
  if (!sessions.some(session => session.windows.some(window => `${session.name}:${window.index}` === target))) throw new HTTPError(404, 'target_not_found');
  const from = rawFrom.trim() || await resolveInboxSender('', readMawConfig(config.worktreeRoot), config.worktreeRoot, signal);
  const key = store.key(from, target, logical, text)!;
  let claim;
  try { claim = store.claim(key); } catch { throw new HTTPError(429, 'delivery_capacity_reached'); }
  if (claim.duplicate !== undefined) {
    const reason = 'duplicate delivery dropped by idempotency key';
    return { complete(_state: string) {}, cancel() {}, duplicate: { ok: true, target, text: responseText, source, state: claim.duplicate, deduped: true, idempotent: true, reason, lastLine: reason, receipt: ['duplicate_dropped'] } };
  }
  return { complete: claim.complete, cancel: claim.cancel, duplicate: undefined };
}
