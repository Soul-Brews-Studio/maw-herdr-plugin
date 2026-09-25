// An nginx-style access line per request, written the moment the response is
// decided rather than buffered, so `maw herdr serve` shows traffic as it
// happens instead of at exit.
//
// Secrets never reach it. The query string is dropped except for a small
// allowlist of harmless keys, and no header is ever printed — an operator
// token arrives in Authorization and a socket ticket arrives in
// Sec-WebSocket-Protocol, so printing either class would leak the credential
// into a scrollback that outlives the process.

const SAFE_QUERY = new Set(['target', 'lines', 'since', 'limit']);

function stamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  return `${pad(now.getDate())}/${months[now.getMonth()]}/${now.getFullYear()}`
    + `:${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    + ` ${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`;
}

/** Path plus only the query keys that cannot carry a credential. */
export function safeTarget(url: URL): string {
  const kept = [...url.searchParams.entries()].filter(([key]) => SAFE_QUERY.has(key));
  const dropped = [...url.searchParams.keys()].some(key => !SAFE_QUERY.has(key));
  const query = new URLSearchParams(kept).toString();
  return `${url.pathname}${query ? `?${query}` : ''}${dropped ? (query ? '&…' : '?…') : ''}`;
}

export interface AccessEntry {
  ip: string;
  method: string;
  url: URL;
  status: number;
  bytes: number | null;
  ms: number;
  origin: string;
  note?: string;
}

export function formatAccess(entry: AccessEntry, now = new Date()): string {
  const size = entry.bytes === null ? '-' : String(entry.bytes);
  const origin = entry.origin ? ` "${entry.origin}"` : '';
  const note = entry.note ? ` ${entry.note}` : '';
  return `${entry.ip || '-'} [${stamp(now)}] "${entry.method} ${safeTarget(entry.url)}" `
    + `${entry.status} ${size} ${Math.round(entry.ms)}ms${origin}${note}`;
}

export function createAccessLog(enabled: boolean) {
  if (!enabled) return () => { /* logging off */ };
  return (entry: AccessEntry) => {
    // Straight to the descriptor: console.error goes through a stream that can
    // hold a partial line when the process is killed mid-demo.
    try { process.stderr.write(`${formatAccess(entry)}\n`); } catch { /* a closed pipe must not kill the server */ }
  };
}
