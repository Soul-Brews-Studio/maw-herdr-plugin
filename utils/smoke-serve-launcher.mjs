#!/usr/bin/env node
// Isolated process regressions: no Herdr daemon, no network, no PATH tools.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'maw-serve-launcher-')));
const env = { ...process.env };
delete env.MAW_HERDR_SERVE_BIN;

function run(command, args, options = {}, status = 0) {
  const result = spawnSync(command, args, { env, cwd: temporary, encoding: 'utf8', timeout: 15_000, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, status, `${command}: ${result.stderr}`);
  return result.stdout + result.stderr;
}

try {
  const bun = run('bun', ['-e', 'console.log(process.execPath)']).trim();
  const entry = join(root, 'index.mjs');
  // Help must need no PATH tools at all.
  const helpEnv = { ...env, PATH: '/nonexistent' };
  for (const runtime of [process.execPath, bun]) {
    const help = run(runtime, [entry, 'serve', '--help'], { env: helpEnv });
    assert.match(help, /token-file/);
    assert.doesNotMatch(help, /--runtime|--build/, 'help must not advertise removed native selection');
  }

  // Bundling relocates import.meta.url; the bundle must still serve help.
  const bundled = join(temporary, 'bundle', 'index.js');
  mkdirSync(dirname(bundled));
  run(bun, ['build', entry, '--target=bun', '--outfile', bundled]);
  assert.match(run(bun, [bundled, 'serve', '--help'], { env: helpEnv }), /token-file/);

  // Removed native selection must fail loudly, with the command that works.
  const token = ['--token-file', 'token path with spaces'];
  for (const removed of [['--runtime', 'native'], ['--runtime=native'], ['--build']]) {
    const output = run(bun, [entry, 'serve', ...removed, ...token], {}, 1);
    assert.match(output, /was removed; the server is always TypeScript on Bun/);
    assert.match(output, /maw herdr serve --token-file/, 'removal error must print the working command');
  }
  const supplied = run(bun, [entry, 'serve', ...token], { env: { ...env, MAW_HERDR_SERVE_BIN: '/nonexistent/server' } }, 1);
  assert.match(supplied, /MAW_HERDR_SERVE_BIN was removed/);
  assert.match(supplied, /unset MAW_HERDR_SERVE_BIN/);

  console.log('PASS: source/bundled help without PATH tools, removed native selection fails with a hint');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
