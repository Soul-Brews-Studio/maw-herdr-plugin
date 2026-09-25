import { HTTPError } from './serverTypes.ts';

/**
 * An over-limit body. Still 400 invalid_json, so every existing route answers
 * exactly as documented; /mcp tells it apart to answer 413 with the real reason.
 */
export class BodyTooLargeError extends HTTPError {
  constructor(public limit: number) { super(400, 'invalid_json'); }
}

export async function readJSON(request: Request, limit: number, signal: AbortSignal): Promise<unknown> {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get('content-type') || '')) throw new HTTPError(415, 'application_json_required');
  const reader = request.body?.getReader();
  if (!reader) throw new HTTPError(400, 'invalid_json');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > limit) throw new BodyTooLargeError(limit);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { throw error instanceof BodyTooLargeError ? error : new HTTPError(400, 'invalid_json'); }
  finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); }
}
