#!/usr/bin/env node
// Build a source-independent plugin folder; never overwrite an existing output.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--os', '--arch', '--out'].includes(key) || options[key] || !process.argv[i + 1]) {
    throw new Error('usage: node utils/package-serve.mjs --os linux|darwin --arch amd64|arm64 --out ABSOLUTE_PATH');
  }
  options[key] = process.argv[i + 1];
}
const { '--os': os, '--arch': arch, '--out': out } = options;
if (!['linux', 'darwin'].includes(os) || !['amd64', 'arm64'].includes(arch) || !out || !isAbsolute(out)) {
  throw new Error('require --os linux|darwin --arch amd64|arm64 --out ABSOLUTE_PATH');
}
// Non-recursive mkdir is intentional: EEXIST rejects files, directories and symlinks.
mkdirSync(out, { mode: 0o755 });
mkdirSync(join(out, 'bin'));
function run(command, args, extra = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...extra });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}); incomplete package retained at ${out}`);
}
const binary = join(out, 'bin', 'maw-herdr-serve');
run('go', ['build', '-trimpath', '-o', binary, '.'], {
  cwd: join(root, 'server'),
  env: { ...process.env, GOWORK: 'off', GOFLAGS: '', CGO_ENABLED: '0', GOOS: os, GOARCH: arch },
});
chmodSync(binary, 0o755);
run('bun', ['build', join(root, 'index.mjs'), '--target=bun', '--outfile', join(out, 'index.js')]);
const hash = path => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
manifest.entry = 'index.js';
manifest.artifact = { path: 'index.js', sha256: hash(join(out, 'index.js')) };
manifest.bundledArtifacts = [{ path: 'bin/maw-herdr-serve', sha256: hash(binary) }];
writeFileSync(join(out, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(out, 'README.md'), `# Herdr plugin (${os}/${arch})\n\nThis platform-specific package includes a prebuilt dashboard server; no Go compiler is required.\nBun and Herdr are still runtime prerequisites.\n\nRun locally: \`bun index.js serve --help\`. After installing the plugin: \`maw herdr serve --help\`.\nUse \`maw herdr serve --token-file /absolute/path/to/token\` to start the loopback dashboard API.\nThe token file must be owner-only (chmod 600) and contain at least 16 bytes.\n\nThe command is **herdr**, not **herder**. This is a CI package, not a published release.\n`);
console.log(`Packaged ${manifest.name}@${manifest.version} for ${os}/${arch}: ${out}`);
