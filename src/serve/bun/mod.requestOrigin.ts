import { loopbackHost } from './mod.loopbackHost.ts';
import { HTTPError } from './serverTypes.ts';

// Loopback pages and the original dashboard are allowed without asking. Any
// other site has to be named by the operator with --allow-origin, because an
// allowed origin can read every pane this server can see.
const BUILTIN = new Set(['https://god.buildwithoracle.com']);

export function requestOrigin(request: Request, allowed: readonly string[] = []): string {
  if (!request.headers.has('origin')) return '';
  const origin = request.headers.get('origin')!;
  const match = /^https?:\/\/([^/?#\s,@]+)$/.exec(origin);
  if (match && (BUILTIN.has(origin) || allowed.includes(origin) || loopbackHost(match[1]))) {
    try { new URL(origin); return origin; } catch { /* Invalid authority. */ }
  }
  throw new HTTPError(403, 'origin_not_allowed');
}

/**
 * Exact origins only: no wildcards, no paths, no query. A single trailing
 * slash is accepted because it is what a browser's address bar hands you.
 */
export function parseAllowedOrigin(value: string): string {
  const trimmed = value.trim();
  // A wildcard silently becomes an entry that can never match a real Origin,
  // so refusing it is the difference between "not supported" and a allowlist
  // the operator believes is working.
  if (trimmed.includes('*')) {
    throw new Error(`--allow-origin does not support wildcards, got "${value}"\n`
      + '  name each origin: --allow-origin https://bridge.buildwithoracle.com --allow-origin https://village.buildwithoracle.com');
  }
  const match = /^https?:\/\/([^/?#\s,@]+)\/?$/.exec(trimmed);
  if (!match) {
    throw new Error(`--allow-origin must be a bare scheme://host[:port], got "${value}"\n`
      + '  maw herdr serve --insecure-no-token --allow-origin https://bridge.buildwithoracle.com');
  }
  return new URL(trimmed).origin;
}
