import type { createDeliveryFeed } from './mod.createDeliveryFeed.ts';
import type { Backend } from './types.ts';

export async function recordDelivery(history: ReturnType<typeof createDeliveryFeed> | undefined, backend: Backend, request: Request, target: string, text: string, route: string, state: string, signal: AbortSignal, extra: { from?: string; error?: string; lastLine?: string } = {}) {
  if (!history) return;
  let oracle = '';
  try {
    const sessions = await backend.sessions(signal);
    for (const session of sessions) for (const window of session.windows) if (`${session.name}:${window.index}` === target) oracle = window.name;
  } catch { /* Unknown identity must not turn accepted delivery into failure. */ }
  history.append({ timestamp: Math.floor(Date.now() / 1000), kind: state === 'failed' ? 'message' : 'context.message', direction: 'inbound', state, route, from: request.headers.get('X-Maw-From')?.trim() || extra.from || '', to: oracle, target, text, oracle, source: 'herdr',
    ...(extra.error === undefined ? {} : { error: extra.error }), ...(extra.lastLine === undefined ? {} : { lastLine: extra.lastLine }) });
}
