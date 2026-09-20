import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { HTTPError } from './serverTypes.ts';
import { readJSON } from './mod.readJSON.ts';

export async function serveState(request: Request, pathname: string, directory: string, signal: AbortSignal): Promise<unknown> {
  if (!directory) throw new HTTPError(503, 'state_directory_required');
  const asks = pathname === '/api/asks';
  const path = join(directory, asks ? 'asks.json' : 'ui-state.json');
  let value: unknown;
  if (request.method === 'GET') {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 256 << 10) throw new Error('invalid state file');
      const bytes = Buffer.alloc((256 << 10) + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > 256 << 10) throw new Error('invalid state file');
      value = JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes.subarray(0, length)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return asks ? [] : {};
      throw new HTTPError(500, 'state_read_failed');
    } finally { if (fd !== undefined) closeSync(fd); }
  } else value = await readJSON(request, 256 << 10, signal);
  if (asks ? !Array.isArray(value) : !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HTTPError(request.method === 'GET' ? 500 : 400, request.method === 'GET' ? 'state_read_failed' : 'state_shape_invalid');
  }
  if (request.method === 'GET') return value;
  const temporary = join(directory, `.state-${randomBytes(16).toString('hex')}`);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch { throw new HTTPError(500, 'state_write_failed'); }
  finally { try { unlinkSync(temporary); } catch { /* Renamed or never created. */ } }
  return { ok: true };
}
