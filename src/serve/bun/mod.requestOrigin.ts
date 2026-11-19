import { loopbackHost } from './mod.loopbackHost.ts';
import { HTTPError } from './serverTypes.ts';

// Loopback pages and the original dashboard are allowed without asking. Any
// other site has to be named by the operator with --allow-origin, because an
// allowed origin can read every pane this server can see.
const BUILTIN = new Set(['https://god.buildwithoracle.com']);

// A Chrome extension id is 32 letters a-p. Its Origin is the whole
// `chrome-extension://<id>`, with no port and no path. `new URL()` gives a
// non-special scheme the origin "null", so this kind is compared as a string.
const EXTENSION = /^chrome-extension:\/\/[a-p]{32}$/;

export function requestOrigin(request: Request, allowed: readonly string[] = []): string {
  if (!request.headers.has('origin')) return '';
  const origin = request.headers.get('origin')!;
  // An extension is never built in and never "loopback": only an exact
  // --allow-origin entry lets one in, since it can read every pane.
  if (EXTENSION.test(origin) && allowed.includes(origin)) return origin;
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
  const extension = trimmed.replace(/\/$/, '');
  if (extension.startsWith('chrome-extension:')) {
    if (EXTENSION.test(extension)) return extension;
    throw new Error(`--allow-origin chrome-extension:// needs the 32-letter id from chrome://extensions, got "${value}"\n`
      + '  maw herdr serve --token-file ~/.maw-herdr-token --allow-origin chrome-extension://ialmjihoifgnkncbgbppcfnfjcclkoef');
  }
  const match = /^https?:\/\/([^/?#\s,@]+)\/?$/.exec(trimmed);
  if (!match) {
    throw new Error(`--allow-origin must be a bare scheme://host[:port], got "${value}"\n`
      + '  maw herdr serve --insecure-no-token --allow-origin https://bridge.buildwithoracle.com');
  }
  return new URL(trimmed).origin;
}
