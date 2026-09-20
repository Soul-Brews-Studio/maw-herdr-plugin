import { loopbackHost } from './mod.loopbackHost.ts';
import { HTTPError } from './serverTypes.ts';

export function requestOrigin(request: Request): string {
  if (!request.headers.has('origin')) return '';
  const origin = request.headers.get('origin')!;
  const match = /^https?:\/\/([^/?#\s,@]+)$/.exec(origin);
  if (match && (origin === 'https://god.buildwithoracle.com' || loopbackHost(match[1]))) {
    try { new URL(origin); return origin; } catch { /* Invalid authority. */ }
  }
  throw new HTTPError(403, 'origin_not_allowed');
}
