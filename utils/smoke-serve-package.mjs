#!/usr/bin/env node
// Run only against a built package. No daemon, credentials or network required.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

assert.equal(process.argv.length, 3, 'usage: node utils/smoke-serve-package.mjs PACKAGE_PATH');
const source = resolve(process.argv[2]);
const temporary = mkdtempSync(join(tmpdir(), 'maw-herdr-package-'));
const packaged = join(temporary, 'plugin');
function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: temporary, env, encoding: 'utf8', timeout: 15_000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}
try {
  const bunLookup = run('bun', ['-e', 'console.log(process.execPath)'], process.env);
  assert.equal(bunLookup.status, 0, bunLookup.stderr);
  const bun = bunLookup.stdout.trim();
  cpSync(source, packaged, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(packaged, 'plugin.json'), 'utf8'));
  assert.equal(manifest.entry, 'index.js');
  assert.equal(manifest.artifact.path, 'index.js');
  assert.equal(manifest.bundledArtifacts, undefined, 'Bun-only packages bundle no native helper');
  assert.equal(manifest.engine.serve.command, 'bun index.mjs serve --engine');
  const digest = createHash('sha256').update(readFileSync(join(packaged, manifest.artifact.path))).digest('hex');
  assert.equal(manifest.artifact.sha256, `sha256:${digest}`);
  assert.equal(existsSync(join(packaged, 'server')), false, 'package must not ship server sources');
  assert.equal(existsSync(join(packaged, 'bin')), false, 'package must not ship a native helper');
  const env = { ...process.env, PATH: '/nonexistent', XDG_CACHE_HOME: join(temporary, 'cache') };
  delete env.MAW_HERDR_SERVE_BIN;
  const entry = join(packaged, 'index.js');
  const help = run(bun, [entry, 'serve', '--help'], env);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /token-file/);
  const removed = run(bun, [entry, 'serve', '--runtime', 'native', '--token-file', 'unused'], env);
  assert.equal(removed.status, 1);
  assert.match(removed.stderr, /was removed; the server is always TypeScript on Bun/);
  assert.equal(existsSync(env.XDG_CACHE_HOME), false, 'launch must never build anything');
  console.log('PASS: package hash/shape, no native helper or sources, Bun help without PATH tools, removed selection rejected');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
