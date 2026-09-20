import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { readMawConfig } from './mod.readMawConfig.ts';
import { readRoster } from './mod.readRoster.ts';
import { resolveWakeIdentity } from './mod.resolveWakeIdentity.ts';
import { resolveInboxSender } from './mod.resolveInboxSender.ts';
import { writeReceiverInbox } from './mod.writeReceiverInbox.ts';
import { BackendError, type RunHerdr } from './types.ts';

export async function deliverReceiverInbox(run: RunHerdr, target: string, text: string, serverRoot: string, rawFrom: string, signal: AbortSignal): Promise<string> {
  const gate = (process.env.MAW_HEY_INBOX_AUTOWRITE ?? '').trim().toLowerCase();
  const enabled = ['1', 'true', 'yes', 'on'].includes(gate) ? true : ['0', 'false', 'no', 'off'].includes(gate) ? false : process.env.MAW_TEST_MODE !== '1';
  if (!enabled) throw new BackendError('backend_error', 'receiver inbox auto-write disabled');
  if (!target || Buffer.byteLength(target) > 1024) throw new BackendError('target_not_found', 'unknown or stale target');
  if (Buffer.byteLength(text) > 64 * 1024 || text.includes('\0')) throw new BackendError('backend_error', 'invalid inbox text');
  const fail = (): never => { throw new BackendError('backend_error', 'receiver inbox unavailable'); };
  const canonical = (path: string) => {
    if (!isAbsolute(path)) return fail();
    try { const resolved = realpathSync(path); if (!statSync(resolved).isDirectory()) return fail(); return resolved; }
    catch { return fail(); }
  };
  const normalize = (raw: unknown): string => {
    if (typeof raw !== 'string') return '';
    let value = raw.trim();
    if (value.includes(':')) { const parts = value.split(':').filter(Boolean); value = parts.length >= 3 ? parts[2] : parts[1] ?? parts[0] ?? value; }
    value = basename(value.replace(/\.[0-9]*$/, '')).replace(/-oracle$/, '').replace(/^[0-9]*-/, '');
    return value;
  };
  const pane = (await readRoster(run, signal)).targets.get(target);
  if (!pane) throw new BackendError('target_not_found', 'unknown or stale target');
  const cwd = canonical(pane.pane.cwd);
  const identity = await resolveWakeIdentity(cwd, pane.pane.workspaceLabel || pane.pane.label || pane.pane.title || pane.pane.id, signal);
  const oracle = normalize(identity.oracle);
  if (!oracle) return fail();
  const config = readMawConfig(serverRoot);
  let basePath = canonical(identity.basePath);
  if (normalize(config.oracle) === oracle && typeof config.psiPath === 'string' && config.psiPath.trim()) {
    let override = resolve(serverRoot, config.psiPath.trim());
    if (['ψ', 'psi'].includes(basename(override))) override = dirname(override);
    try { if (!statSync(override).isDirectory()) return fail(); basePath = canonical(override); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fail(); }
  }
  const from = await resolveInboxSender(rawFrom, config, serverRoot, signal);
  const fresh = (await readRoster(run, signal)).targets.get(target);
  if (!fresh || fresh.session !== pane.session || fresh.pane.id !== pane.pane.id || fresh.pane.workspace !== pane.pane.workspace || fresh.pane.workspaceLabel !== pane.pane.workspaceLabel || fresh.pane.label !== pane.pane.label || fresh.pane.title !== pane.pane.title || canonical(fresh.pane.cwd) !== cwd || signal.aborted) return fail();
  try { return writeReceiverInbox(basePath, oracle, from, text); }
  catch { return fail(); }
}
