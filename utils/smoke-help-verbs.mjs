#!/usr/bin/env bun
// Help/dispatch/manifest drift (#93), reading the REAL source and manifest and
// running the actual CLI process. A FAKE herdr is the only executable on PATH:
// it records every call and fails. HOME and cwd are temporary; no live session.
// Run: bun utils/smoke-help-verbs.mjs (MAW_HELP_ENTRY=<bundle> for the bundle).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(root, 'index.mjs');
const manifestPath = join(root, 'plugin.json');
const entry = resolve(process.env.MAW_HELP_ENTRY || sourcePath);
const temporary = mkdtempSync(join(tmpdir(), 'maw-help-verbs-'));
const bin = join(temporary, 'bin');
const home = join(temporary, 'home');
const log = join(temporary, 'herdr-calls.jsonl');
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };

// Internal entry points are not user verbs and do not implement user-facing help.
// Keep exceptions explicit and reasoned; a removed dispatch must remove its entry.
const hidden = new Map([
  ['__watch-run', 'Detached watch subprocess entry; takes a watch file, not user arguments or --help.'],
]);

try {
  const source = readFileSync(sourcePath, 'utf8');
  const dispatched = new Set([...source.matchAll(/\bcommand\s*===\s*(['"])([^'"\r\n]+)\1/g)].map(match => match[2]));
  ok(dispatched.size > 0, 'index.mjs must have command === dispatches');
  const firstLine = source.match(/^const HELP = `([^\r\n]+)/m)?.[1];
  const verbsIn = (line, label) => {
    const list = line?.match(/^maw herdr <([^>]+)>/)?.[1];
    ok(list, `${label} must start with maw herdr <verb|...>`);
    const verbs = list.split('|');
    ok(verbs.every(verb => /^[a-z][a-z0-9-]*$/.test(verb)), `${label} must contain nonempty verb names`);
    eq(new Set(verbs).size, verbs.length, `${label} must not repeat verbs`);
    return verbs;
  };
  const help = verbsIn(firstLine, 'first HELP line');
  for (const [verb, reason] of hidden) {
    ok(reason.trim(), `${verb} needs an allowlist reason`);
    ok(dispatched.has(verb), `stale hidden-verb allowlist entry: ${verb}`);
    ok(!help.includes(verb), `hidden verb is advertised: ${verb}`);
  }
  eq([...dispatched].filter(verb => !hidden.has(verb) && !help.includes(verb)), [], 'dispatched verbs missing from HELP');
  eq(help.filter(verb => !dispatched.has(verb)), [], 'HELP advertises verbs with no dispatch');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const manifestHelp = verbsIn(manifest.cli?.help, 'plugin.json cli.help');
  eq([...manifestHelp].sort(), [...help].sort(), 'plugin.json cli.help and HELP must name the same verbs');

  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(97);
`, { mode: 0o755 });
  // Do not inherit Herdr sockets, session IDs, registry paths or other caller config.
  const env = { PATH: bin, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), TMPDIR: temporary };
  // Prove the trap is executable before trusting an empty call log.
  const trap = spawnSync('herdr', ['help-smoke-trap'], { cwd: temporary, env, encoding: 'utf8', timeout: 10_000 });
  eq(trap.status, 97, 'fake herdr must fail when invoked');
  eq(readFileSync(log, 'utf8'), '["help-smoke-trap"]\n', 'fake herdr must record its argv');
  rmSync(log);

  const run = (...args) => spawnSync(process.execPath, [entry, ...args], {
    cwd: temporary, env, encoding: 'utf8', timeout: 10_000,
  });
  const printedHelp = run('--help');
  ok(!existsSync(log), 'top-level --help must not call herdr');
  eq(printedHelp.status, 0, `top-level --help must exit 0: ${printedHelp.error?.message || printedHelp.stderr}`);
  eq(printedHelp.stdout.split(/\r?\n/)[0], firstLine, 'executed entry must print the current HELP line (including bundles)');
  eq(printedHelp.stderr, '', 'top-level --help must not print errors');

  // Derive the probes from dispatch, not a second hand-maintained verb list.
  for (const verb of dispatched) {
    if (hidden.has(verb)) continue;
    for (const flag of ['--help', '-h']) {
      const result = run(verb, flag);
      const label = `${verb} ${flag}`;
      ok(!existsSync(log), `${label} called herdr: ${existsSync(log) ? readFileSync(log, 'utf8') : ''}`);
      eq(result.status, 0, `${label} must exit 0: ${result.error?.message || result.stderr}`);
      ok(result.stdout.includes('maw herdr '), `${label} must print usage, not silently succeed`);
      eq(result.stderr, '', `${label} must not print errors`);
    }
  }
  console.log(`ok — help verbs: ${checks} checks · ${help.length} public verbs/aliases · source dispatch + manifest + CLI help`);
} catch (error) {
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  console.error(`help verbs: ${error.message}\n  \${EDITOR:-vi} ${[sourcePath, manifestPath, fileURLToPath(import.meta.url)].map(quote).join(' ')}`);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
