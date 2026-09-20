import { isIP } from 'node:net';

export function loopbackHost(authority: string): boolean {
  const match = /^(?:\[([^\]]+)\]|([^:]+))(?::([0-9]+))?$/.exec(authority);
  const host = match ? (match[1] || match[2]) : authority;
  if (host === 'localhost') return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  if (isIP(host) !== 6) return false;
  const normalized = new URL(`http://[${host}]`).hostname;
  return normalized === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(normalized);
}
