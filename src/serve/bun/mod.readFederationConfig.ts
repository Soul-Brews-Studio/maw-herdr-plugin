import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readMawConfig } from './mod.readMawConfig.ts';
import { HTTPError } from './serverTypes.ts';

export interface FederationPeer { name: string; url: string; node: string | null; oracle: string | null; auth_ok: boolean | null }
export function readFederationConfig(signing = true) {
  const fail = (): never => { throw new HTTPError(503, 'federation_unavailable'); };
  const read = (path: string, limit: number) => {
    let fd: number | undefined;
    try {
      let current = resolve(path);
      const ancestors: string[] = [];
      for (;;) { ancestors.push(current); const parent=dirname(current); if(parent===current)break; current=parent; }
      for (const component of ancestors.reverse()) if (lstatSync(component).isSymbolicLink()) fail();
      const before=lstatSync(path);
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.dev!==before.dev || stat.ino!==before.ino || stat.size > limit) fail();
      const buffer = Buffer.alloc(limit + 1); let length = 0;
      while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count; }
      if (length > limit) fail();
      return new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; return fail(); }
    finally { if (fd !== undefined) closeSync(fd); }
  };
  const env = process.env;
  const home = homedir();
  const xdg = ['1','true','yes','on'].includes((env.MAW_XDG || '').toLowerCase());
  const state = env.MAW_HOME || env.MAW_STATE_DIR || (xdg ? join(env.XDG_STATE_HOME || join(home,'.local','state'),'maw') : join(home,'.maw'));
  let path = resolve(env.PEERS_FILE || join(state,'peers.json'));
  let raw = read(path, 1024 * 1024);
  if (raw === undefined && !env.PEERS_FILE && !env.MAW_HOME) {
    path = resolve(home,'.maw','peers.json');
    raw = read(path,1024*1024);
  }
  let store: unknown = {version:1,peers:{}};
  if (raw !== undefined) { try { store = JSON.parse(raw); } catch { fail(); } }
  if (!store || typeof store !== 'object' || Array.isArray(store) || !('version' in store) || store.version !== 1 || !('peers' in store) || !store.peers || typeof store.peers !== 'object' || Array.isArray(store.peers)) fail();
  const entries = Object.entries((store as {peers:Record<string,unknown>}).peers);
  if (entries.length > 32) fail();
  const peers: FederationPeer[] = entries.sort(([a],[b])=>a<b?-1:a>b?1:0).map(([name,value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('url' in value) || typeof value.url !== 'string') return fail();
    let url: URL;
    try { url = new URL(value.url); } catch { return fail(); }
    if (!/^https?:\/\//i.test(value.url) || !['http:','https:'].includes(url.protocol) || url.username || url.password || value.url.split('://')[1]?.split(/[/?#]/)[0].includes('@') || value.url.includes('\\') || url.port === '0' || url.search || url.hash || value.url.includes('?') || value.url.includes('#') || /[\x00-\x20\x7f]/.test(value.url)) fail();
    const node = 'node' in value ? value.node : null;
    const auth = 'authOk' in value ? value.authOk : null;
    const identity = 'identity' in value ? value.identity : null;
    if (node !== null && typeof node !== 'string' || auth !== null && typeof auth !== 'boolean' || identity !== null && (!identity || typeof identity !== 'object' || Array.isArray(identity))) fail();
    const oracle = identity && typeof identity === 'object' && 'oracle' in identity ? identity.oracle : null;
    if (oracle !== null && typeof oracle !== 'string') fail();
    return {name,url:value.url,node:node as string|null,auth_ok:auth as boolean|null,oracle:oracle ? String(oracle) : null};
  });
  const merged = signing ? readMawConfig() : {};
  const oracle = typeof merged.oracle === 'string' ? merged.oracle.trim() : '';
  const configuredSender = typeof merged.node === 'string' && merged.node && oracle ? `${merged.node}:${oracle}` : '';
  const sender = signing ? env.MAW_SENDER ?? configuredSender : '';
  const fleet = signing ? (env.MAW_FEDERATION_TOKEN || '').trim() || (typeof merged.federationToken === 'string' ? merged.federationToken.trim() : '') : '';
  const key = signing ? env.MAW_PEER_KEY || (read(resolve(state,'peer-key'),4096) || '').trim() : '';
  const fingerprint = createHash('sha256').update(JSON.stringify([path,raw,sender,fleet,key])).digest('hex');
  return { peers, sender, fleet, key, fingerprint };
}
