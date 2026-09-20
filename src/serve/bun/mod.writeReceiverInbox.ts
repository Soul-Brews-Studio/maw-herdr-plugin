import { randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** basePath is an existing, canonical, trusted receiver repository directory. */
export function writeReceiverInbox(basePath: string, oracle: string, from: string, message: string, now: Date = new Date()): string {
  for (const value of [oracle, from]) {
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 1024 || /[\r\n\0]/.test(value)) {
      throw new Error('invalid receiver inbox metadata');
    }
  }
  if (typeof message !== 'string' || Buffer.byteLength(message, 'utf8') > 64 * 1024 || message.includes('\0')) {
    throw new Error('invalid receiver inbox message');
  }
  const timestamp = now.toISOString();
  const safeSegment = (value: string) => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'unknown';
  // Rust's legacy helper lowercases ASCII only, before sanitizing the six-word slug.
  const slug = safeSegment(message.split(/\p{White_Space}+/u).filter(Boolean).slice(0, 6).join('-').replace(/[A-Z]/g, ch => ch.toLowerCase())).slice(0, 48);
  const stem = `${timestamp.slice(0, 10)}_${timestamp.slice(11, 16).replace(':', '-')}_${safeSegment(from)}_${slug}`;
  const body = `---\nfrom: ${from}\nto: ${oracle}\ntimestamp: ${timestamp}\nread: false\n---\n\n${message}\n`;
  let inbox = basePath;
  for (const segment of ['ψ', 'inbox']) {
    inbox = join(inbox, segment);
    try { mkdirSync(inbox, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!lstatSync(inbox).isDirectory()) throw new Error('receiver inbox path must be a real directory');
  }
  const temporary = join(inbox, `.receiver-${randomBytes(16).toString('hex')}.tmp`);
  // Do not clean up a temporary name unless this invocation created it.
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { fchmodSync(fd, 0o600); writeFileSync(fd, body, 'utf8'); }
    finally { closeSync(fd); }
    for (let attempt = 1; attempt <= 1000; attempt++) {
      const path = join(inbox, `${stem}${attempt === 1 ? '' : `-${attempt}`}.md`);
      try { linkSync(temporary, path); return path; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    throw new Error('receiver inbox filename collision limit reached');
  } finally { unlinkSync(temporary); }
}
