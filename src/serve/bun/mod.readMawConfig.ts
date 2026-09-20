import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { HTTPError } from './serverTypes.ts';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read-only legacy layered configuration. Unknown fields remain private to callers. */
export function readMawConfig(cwd = process.cwd()): ObjectValue {
  const fail = (): never => { throw new HTTPError(503, 'config_unavailable'); };
  const safe = (path: string) => {
    const parts: string[] = [];
    for (let current = resolve(path);; current = dirname(current)) { parts.push(current); if (dirname(current) === current) break; }
    for (const part of parts.reverse()) {
      try { if (lstatSync(part).isSymbolicLink()) fail(); }
      catch (error) { if (error instanceof HTTPError) throw error; if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    }
  };
  const env = process.env;
  const singleton = join(env.XDG_CONFIG_HOME !== undefined && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(homedir(), '.config'), 'maw');
  const active = env.MAW_HOME !== undefined ? join(env.MAW_HOME, 'config') : env.MAW_CONFIG_DIR ?? singleton;
  type Layer = {path: string; weight: number; rank: number; local: boolean};
  const layers: Layer[] = [];
  const add = (layer: Layer) => { layers.push(layer); if (layers.length > 128) fail(); };
  const scan = (dir: string, rank: number, legacy: boolean) => {
    let handle: ReturnType<typeof opendirSync> | undefined;
    let numbered = false;
    try {
      safe(dir); if (!lstatSync(dir).isDirectory()) fail(); handle = opendirSync(dir); let count = 0;
      for (;;) {
        const entry = handle.readSync(); if (!entry) break;
        if (++count > 1024) fail();
        const match = /^maw\.config\.([0-9]+)(\.local)?\.json$/.exec(entry.name);
        if (!match || Number(match[1]) > 0xffffffff) continue;
        numbered = true; add({path: resolve(dir, entry.name), weight: Number(match[1]), rank, local: !!match[2]});
      }
    } catch (error) { if (error instanceof HTTPError) throw error; }
    finally { handle?.closeSync(); }
    if (legacy && !numbered) {
      const path = resolve(dir, 'maw.config.json');
      try { lstatSync(path); add({path, weight: 50, rank, local: false}); } catch (error) { if (error instanceof HTTPError) throw error; }
    }
  };
  scan(active, 20, true);
  const ancestors: string[] = [];
  for (let current = resolve(cwd); ancestors.length < 32; current = dirname(current)) { ancestors.push(current); if (dirname(current) === current) break; }
  ancestors.reverse().forEach((path, index) => scan(join(path, '.maw'), 30 + index, false));
  if (env.MAW_TEST_MODE !== '1' && env.MAW_HOME !== undefined && env.MAW_CONFIG_DIR === undefined && resolve(singleton) !== resolve(active)) scan(singleton, 10, true);
  layers.sort((a,b) => a.weight-b.weight || a.rank-b.rank || Number(a.local)-Number(b.local) || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  let bytes = 0;
  const read = (path: string): ObjectValue | undefined => {
    let fd: number | undefined;
    try {
      safe(path); const before = lstatSync(path);
      if (!before.isFile()) fail();
      if (before.size > 1024*1024) fail();
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) fail();
      const buffer = Buffer.alloc(1024*1024+1); let length = 0;
      while (length < buffer.length) { const n = readSync(fd, buffer, length, buffer.length-length, null); if (!n) break; length += n; }
      bytes += length; if (length > 1024*1024 || bytes > 4*1024*1024) fail();
      const raw = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(buffer.subarray(0,length));
      let depth = 0, quoted = false, escaped = false;
      for (const char of raw) {
        if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
        else if (char === '"') quoted = true;
        else if (char === '{' || char === '[') { if (++depth > 64) fail(); }
        else if (char === '}' || char === ']') depth--;
      }
      const value: unknown = JSON.parse(raw);
      return object(value) ? value : undefined;
    } catch (error) { if (error instanceof HTTPError) throw error; return undefined; }
    finally { if (fd !== undefined) closeSync(fd); }
  };
  const merge = (base: ObjectValue, layer: ObjectValue) => {
    for (const [key,value] of Object.entries(layer)) {
      if (value === null) { delete base[key]; continue; }
      if (object(value)) { if (!object(base[key])) base[key] = Object.create(null); merge(base[key] as ObjectValue,value); }
      else if (key === 'namedPeers' && Array.isArray(base[key]) && Array.isArray(value)) {
        const out = [...base[key] as unknown[]];
        for (const item of value) { const i = object(item) && typeof item.name === 'string' ? out.findIndex(old => object(old) && old.name === item.name) : -1; if (i < 0) out.push(item); else out[i] = item; }
        base[key] = out;
      } else base[key] = value;
    }
  };
  const result: ObjectValue = Object.create(null); let loaded = false;
  for (const layer of layers) { const value = read(layer.path); if (value) { merge(result,value); loaded = true; } }
  const fallback = resolve(active,'maw.config.json');
  if (!loaded && !layers.some(layer => layer.path === fallback)) { const value = read(fallback); if (value) merge(result,value); }
  return result;
}

export function projectMawConfig(value: ObjectValue) {
  const display = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
  let node = display(value.node) ? value.node : process.env.HOSTNAME !== undefined ? process.env.HOSTNAME.trim() || 'local' : hostname().split('.')[0] || 'local';
  if (!display(node)) node = 'local';
  const agents: Record<string,string> = Object.create(null);
  if (object(value.agents)) for (const [name,entry] of Object.entries(value.agents)) if (typeof entry === 'string') agents[name] = entry;
  let namedPeers: {name:string;url:string}[] | undefined;
  if (Object.hasOwn(value,'namedPeers')) {
    namedPeers = [];
    const entries = Array.isArray(value.namedPeers) ? value.namedPeers : object(value.namedPeers) ? Object.entries(value.namedPeers).sort(([a],[b]) => Buffer.compare(Buffer.from(a),Buffer.from(b))).map(([name,url]) => ({name,url})) : [];
    for (const entry of entries) {
      if (!object(entry) || typeof entry.name !== 'string' || typeof entry.url !== 'string') continue;
      try {
        const url = new URL(entry.url);
        if (!/^https?:\/\//i.test(entry.url) || !['http:','https:'].includes(url.protocol) || url.username || url.password || entry.url.split('://')[1]?.split(/[/?#]/)[0].includes('@') || /[\\?#\x00-\x20\x7f]/.test(entry.url) || url.port === '0') continue;
        namedPeers.push({name:entry.name,url:entry.url});
      } catch { /* Invalid display entries never become probe targets. */ }
    }
  }
  return {node,agents,namedPeers};
}
