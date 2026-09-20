#!/usr/bin/env node
// Run only against a native package. No daemon, credentials, network or Go required.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual(manifest.bundledArtifacts.map(item => item.path), ['bin/maw-herdr-serve']);
  for (const artifact of [manifest.artifact, ...manifest.bundledArtifacts]) {
    const digest = createHash('sha256').update(readFileSync(join(packaged, artifact.path))).digest('hex');
    assert.equal(artifact.sha256, `sha256:${digest}`);
  }
  assert.equal(existsSync(join(packaged, 'server')), false, 'package must not require server sources');
  const binary = join(packaged, 'bin', 'maw-herdr-serve');
  assert.equal(statSync(binary).mode & 0o777, 0o755);
  const env = { ...process.env, PATH: '/nonexistent', XDG_CACHE_HOME: join(temporary, 'cache') };
  delete env.MAW_HERDR_SERVE_BIN;
  const nativeHelp = run(binary, ['--help'], env);
  assert.equal(nativeHelp.status, 0, nativeHelp.stderr);
  assert.match(nativeHelp.stdout + nativeHelp.stderr, /token-file/);
  const entry = join(packaged, 'index.js');
  const help = run(bun, [entry, 'serve', '--help'], env);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /token-file/);
  const forwarded = run(bun, [entry, 'serve', '--runtime', 'native', '--listen', 'invalid address with spaces'], env);
  assert.equal(forwarded.status, 1, forwarded.stderr);
  assert.match(forwarded.stderr, /--listen must use a loopback/);
  assert.equal(existsSync(env.XDG_CACHE_HOME), false, 'prebuilt launch must not build sources');
  // A copied package allows corruption checks without changing the build output.
  writeFileSync(binary, Buffer.concat([readFileSync(binary), Buffer.from('tampered')]));
  const corrupted = run(bun, [entry, 'serve', '--runtime', 'native', '--listen', 'invalid'], env);
  assert.notEqual(corrupted.status, 0);
  assert.match(corrupted.stderr, /sha256|checksum|integrity|digest|hash/i);
  assert.doesNotMatch(corrupted.stderr, /--listen must use a loopback/);
  console.log('PASS: package hashes/mode, native help, source-free Bun help/argv without Go, tampered helper rejected');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
