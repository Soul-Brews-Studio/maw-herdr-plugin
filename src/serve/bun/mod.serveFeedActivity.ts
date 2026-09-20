import type { Backend } from './types.ts';
import { HTTPError } from './serverTypes.ts';

// Legacy feed POST acknowledges non-JSON/missing oracle without injecting events.
export async function serveFeedActivity(request: Request, backend: Backend, signal: AbortSignal) {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    if (reader) while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > (64 << 10)) throw new HTTPError(400, 'invalid_feed_body');
      chunks.push(value);
    }
  } catch { throw new HTTPError(400, 'invalid_feed_body'); }
  finally { signal.removeEventListener('abort', abort); void reader?.cancel().catch(() => {}); }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { return { ok: true }; }
  if (typeof body?.oracle === 'string' && body.oracle.trim()) {
    if (Buffer.byteLength(body.oracle) > 1024) throw new HTTPError(400, 'invalid_feed_oracle');
    if (!backend.observedFeed.markActivity(body.oracle)) throw new HTTPError(429, 'feed_activity_capacity_reached');
  }
  return { ok: true };
}
