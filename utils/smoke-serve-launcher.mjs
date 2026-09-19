#!/usr/bin/env node
// Isolated process regressions: no real Go compiler, Herdr daemon, or network.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'maw-serve-launcher-')));
const env = { ...process.env };
delete env.MAW_HERDR_SERVE_BIN;
let signalChild;

function run(command, args, options = {}, status = 0) {
  const result = spawnSync(command, args, { env, cwd: temporary, encoding: 'utf8', timeout: 15_000, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, status, `${command}: ${result.stderr}`);
  return result.stdout;
}

function executable(path, body) {
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o700);
}

try {
  const bun = run('bun', ['-e', 'console.log(process.execPath)']).trim();
  const entry = join(root, 'index.mjs');
  const helpEnv = { ...env, PATH: '/nonexistent', MAW_HERDR_SERVE_BIN: '/nonexistent/server' };
  for (const runtime of [process.execPath, bun]) {
    assert.match(run(runtime, [entry, 'serve', '--help'], { env: helpEnv }), /token-file/);
  }

  const backend = join(temporary, 'backend');
  executable(backend, `console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })); process.exit(23);`);
  const args = ['--token-file', 'token path with spaces', '--listen', '127.0.0.1:3457'];
  for (const runtime of [process.execPath, bun]) {
    const output = run(runtime, [entry, 'serve', ...args], { env: { ...env, MAW_HERDR_SERVE_BIN: backend } }, 23);
    assert.deepEqual(JSON.parse(output), { args, cwd: temporary });
  }

  // Bundling relocates import.meta.url; root must follow the executable entry.
  const bundled = join(temporary, 'bundle', 'index.js');
  mkdirSync(dirname(bundled));
  run(bun, ['build', entry, '--target=bun', '--outfile', bundled]);
  assert.match(run(bun, [bundled, 'serve', '--help'], { env: helpEnv }), /token-file/);
  const prebuilt = join(dirname(bundled), 'server', 'bin', 'maw-herdr-serve');
  mkdirSync(dirname(prebuilt), { recursive: true });
  copyFileSync(backend, prebuilt);
  chmodSync(prebuilt, 0o700);
  assert.deepEqual(JSON.parse(run(bun, [bundled, 'serve', ...args], {}, 23)), { args, cwd: temporary });

  // Build only a minimal copied fixture, never the actual server module.
  const fixture = join(temporary, 'fixture');
  mkdirSync(join(fixture, 'src', 'serve'), { recursive: true });
  mkdirSync(join(fixture, 'server'));
  copyFileSync(entry, join(fixture, 'index.mjs'));
  copyFileSync(join(root, 'src', 'serve', 'mod.runServe.mjs'), join(fixture, 'src', 'serve', 'mod.runServe.mjs'));
  writeFileSync(join(fixture, 'server', 'go.mod'), 'module example.test/smoke\ngo 1.23\n');
  writeFileSync(join(fixture, 'server', 'main.go'), 'package main\nfunc main() {}\n');
  const tools = join(temporary, 'tools');
  mkdirSync(tools);
  const builtScript = `#!${process.execPath}\nconsole.log('built');\n`;
  executable(join(tools, 'go'), `
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.equal(process.env.GOWORK, 'off');
assert.equal(process.env.CGO_ENABLED, '0');
assert.equal(process.env.GOOS, process.platform);
assert.equal(process.argv.at(-1), '.');
const output = process.argv[process.argv.indexOf('-o') + 1];
fs.writeFileSync(output, ${JSON.stringify(builtScript)});
fs.chmodSync(output, 0o700);
fs.appendFileSync(process.env.BUILD_COUNT, 'build\\n');`);
  const cacheEnv = { ...env, PATH: tools, XDG_CACHE_HOME: join(temporary, 'cache'), BUILD_COUNT: join(temporary, 'build-count') };
  for (let i = 0; i < 3; i++) {
    if (i === 2) writeFileSync(join(fixture, 'server', 'main.go'), 'package main\nfunc main() { println("changed") }\n');
    assert.equal(run(bun, [join(fixture, 'index.mjs'), 'serve'], { env: cacheEnv }), 'built\n');
  }
  assert.equal(readFileSync(cacheEnv.BUILD_COUNT, 'utf8'), 'build\nbuild\n');
  assert.equal(existsSync(join(fixture, 'server', 'bin')), false);
  assert.equal(readdirSync(join(cacheEnv.XDG_CACHE_HOME, 'maw-herdr', 'serve')).some(name => name.startsWith('.build-')), false);

  executable(backend, `process.on('SIGTERM', () => process.exit(42)); console.log('ready'); setInterval(() => {}, 1000);`);
  signalChild = spawn(bun, [entry, 'serve'], { env: { ...env, MAW_HERDR_SERVE_BIN: backend }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((done, fail) => {
    let stdout = '';
    const timer = setTimeout(() => { signalChild.kill('SIGKILL'); fail(new Error('signal forwarding timed out')); }, 5000);
    signalChild.once('error', error => { clearTimeout(timer); fail(error); });
    signalChild.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes('ready') && !signalChild.killed) signalChild.kill('SIGTERM');
    });
    signalChild.once('exit', (code, signal) => {
      clearTimeout(timer);
      try { assert.equal(signal, null); assert.equal(code, 42); done(); } catch (error) { fail(error); }
    });
  });
  console.log('PASS: source/bundled help, argv/cwd/status, prebuilt lookup, source cache invalidation, temp cleanup, signal forwarding');
} finally {
  if (signalChild && signalChild.exitCode === null && signalChild.signalCode === null) signalChild.kill('SIGKILL');
  rmSync(temporary, { recursive: true, force: true });
}
