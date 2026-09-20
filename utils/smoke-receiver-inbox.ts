#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { writeReceiverInbox } from '../src/serve/bun/mod.writeReceiverInbox.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-receiver-inbox-')));
const now = new Date('2026-09-21T02:03:04.567Z');
const fixture = (name: string) => { const path = join(root, name); mkdirSync(path, { mode: 0o700 }); return path; };
try {
  const repo = fixture('format');
  const message = 'Hello WORLD! one two three four seven\nBody stays intact.';
  const path = writeReceiverInbox(repo, 'oracle', ' Node: Alice / B ', message, now);
  assert.equal(basename(path), '2026-09-21_02-03_Node-Alice-B_hello-world--one-two-three-four.md');
  assert.equal(readFileSync(path, 'utf8'), `---\nfrom:  Node: Alice / B \nto: oracle\ntimestamp: 2026-09-21T02:03:04.567Z\nread: false\n---\n\n${message}\n`);
  for (const dir of [join(repo, 'ψ'), join(repo, 'ψ', 'inbox')]) assert.equal(lstatSync(dir).mode & 0o777, 0o700);
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.equal(lstatSync(path).nlink, 1);
  assert.equal(basename(writeReceiverInbox(repo, 'oracle', ' Node: Alice / B ', message, now)), basename(path).replace('.md', '-2.md'));
  assert.equal(basename(writeReceiverInbox(repo, 'oracle', 'a'.repeat(100), 'B'.repeat(100), now)), `2026-09-21_02-03_${'a'.repeat(64)}_${'b'.repeat(48)}.md`);
  assert.equal(basename(writeReceiverInbox(repo, 'oracle', 'ไทย', 'ไทย', now)), '2026-09-21_02-03_unknown_unknown.md');
  assert.equal(basename(writeReceiverInbox(repo, 'oracle', 'a--b', 'K X', now)), '2026-09-21_02-03_a--b_x.md');
  assert.equal(readFileSync(writeReceiverInbox(repo, 'oracle', 'sender', '', now), 'utf8').endsWith('---\n\n\n'), true);
  const outside = fixture('outside');
  for (const segment of ['ψ', 'inbox']) {
    const unsafe = fixture(`symlink-${segment}`);
    if (segment === 'inbox') mkdirSync(join(unsafe, 'ψ'));
    symlinkSync(outside, join(unsafe, 'ψ', ...(segment === 'inbox' ? ['inbox'] : [])));
    assert.throws(() => writeReceiverInbox(unsafe, 'oracle', 'sender', 'hello', now), /real directory/);
  }
  assert.deepEqual(readdirSync(outside), []);
  const nonDirectory = fixture('file-child');
  writeFileSync(join(nonDirectory, 'ψ'), 'keep');
  assert.throws(() => writeReceiverInbox(nonDirectory, 'oracle', 'sender', 'hello', now), /real directory/);
  assert.equal(readFileSync(join(nonDirectory, 'ψ'), 'utf8'), 'keep');
  const invalid = fixture('invalid');
  for (const metadata of ['', ' ', 'x\ny', 'x\ry', 'x\0y', 'x'.repeat(1025), 'é'.repeat(513)]) {
    assert.throws(() => writeReceiverInbox(invalid, metadata, 'sender', 'ok', now), /metadata/);
    assert.throws(() => writeReceiverInbox(invalid, 'oracle', metadata, 'ok', now), /metadata/);
  }
  for (const body of ['x\0y', 'x'.repeat(65537), 'é'.repeat(32769)]) assert.throws(() => writeReceiverInbox(invalid, 'oracle', 'sender', body, now), /message/);
  assert.throws(() => writeReceiverInbox(invalid, 'oracle', 'sender', 'ok', new Date(NaN)), RangeError);
  assert.deepEqual(readdirSync(invalid), [], 'invalid input must not create directories');
  writeReceiverInbox(invalid, 'é'.repeat(512), 'é'.repeat(512), 'é'.repeat(32768), now);
  const full = fixture('collisions');
  const first = writeReceiverInbox(full, 'oracle', 'sender', 'hello', now);
  const inbox = join(full, 'ψ', 'inbox');
  for (let i = 2; i <= 1000; i++) writeFileSync(first.replace('.md', `-${i}.md`), `keep-${i}`);
  assert.throws(() => writeReceiverInbox(full, 'oracle', 'sender', 'hello', now), /collision limit/);
  assert.equal(readdirSync(inbox).length, 1000, 'failed publication cleans up its temporary file');
  assert.equal(readFileSync(first.replace('.md', '-1000.md'), 'utf8'), 'keep-1000');
  rmSync(first.replace('.md', '-1000.md'));
  assert.equal(writeReceiverInbox(full, 'oracle', 'sender', 'hello', now), first.replace('.md', '-1000.md'));
  const blocked = fixture('blocked-name');
  mkdirSync(join(blocked, 'ψ', 'inbox'), { recursive: true });
  const occupied = join(blocked, 'ψ', 'inbox', '2026-09-21_02-03_sender_hello.md');
  symlinkSync(join(outside, 'missing'), occupied);
  assert.equal(writeReceiverInbox(blocked, 'oracle', 'sender', 'hello', now), occupied.replace('.md', '-2.md'));
  assert.equal(lstatSync(occupied).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(readdirSync(join(repo, 'ψ', 'inbox')).some(name => name.endsWith('.tmp')), false);
  console.log('PASS receiver inbox: legacy format, UTC/ASCII naming, collisions through 1000, private modes, symlink refusal, metadata and UTF-8 byte limits, temporary cleanup');
} finally { rmSync(root, { recursive: true, force: true }); }
