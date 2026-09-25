#!/usr/bin/env bun
// deliverAgentPrompt with a scripted in-process herdr: what happens AFTER
// `herdr agent prompt` succeeded. The prompt is typed at that point, so no
// later abort, timeout or failed Enter may turn the receipt into a failure
// (that would release the idempotency key and let a retry type it again).
// Also: an already-visible queued marker is not evidence for this prompt, and
// hints quote roster values that are not shell-safe. No herdr is spawned.
import assert from 'node:assert/strict';
import { deliverAgentPrompt, shellWord } from '../src/serve/bun/mod.deliverAgentPrompt.ts';
import { readRoster } from '../src/serve/bun/mod.readRoster.ts';
import { BackendError, type RunHerdr } from '../src/serve/bun/types.ts';

const rule = '─'.repeat(30);
const box = (text = '', extra: string[] = []) => ['● reply', '', rule, `❯ ${text}`, rule, '  🖥  footer', ...extra].join('\n');
const QUEUED = '  Press up to edit queued messages';
type Script = { session?: string; panes?: Record<string, unknown>[]; before?: string; after?: string[]; onPrompt?: () => void; onRead?: (n: number) => void; failEnter?: boolean; failRead?: 'before' };
const pane = (id = 'wD:p4', extra = {}) => ({ pane_id: id, workspace_id: 'wD', agent: 'claude', label: '', title: 'claude', cwd: '/repo', focused: false, agent_status: 'idle', ...extra });

function fake(script: Script) {
  const calls: string[][] = [];
  let prompted = false, reads = 0;
  const after = [...(script.after ?? [])];
  const run: RunHerdr = async (args, signal) => {
    calls.push(args);
    if (signal.aborted) throw new BackendError('backend_error', 'herdr operation aborted');
    const session = script.session ?? 'main';
    const v = args[0] === '--session' ? args.slice(2) : args;
    if (v[0] === 'session') return JSON.stringify({ result: { sessions: [{ name: session, running: true }] } });
    if (v[0] === 'api') return JSON.stringify({ result: { snapshot: { protocol: 22, workspaces: [{ workspace_id: 'wD', label: 'demo' }], panes: script.panes ?? [pane()] } } });
    if (v[0] === 'pane' && v[1] === 'read') {
      script.onRead?.(reads++);
      if (!prompted) { if (script.failRead === 'before') throw new BackendError('backend_error', 'herdr exited 1'); return script.before ?? box(); }
      return after.length > 1 ? after.shift()! : after[0] ?? box();
    }
    if (v[0] === 'agent' && v[1] === 'prompt') { prompted = true; script.onPrompt?.(); return '{"ok":true}'; }
    if (v[0] === 'pane' && v[1] === 'send-keys') { if (script.failEnter) throw new BackendError('backend_error', 'herdr exited 1'); return ''; }
    throw new Error('unexpected ' + JSON.stringify(args));
  };
  return { run, calls, prompts: () => calls.filter(c => c[2] === 'agent' && c[3] === 'prompt').length, enters: () => calls.filter(c => c[3] === 'send-keys').length };
}
const target = Buffer.from('main').toString('base64url') + '/' + Buffer.from('wD').toString('base64url') + ':4';

// 1. Abort while the watch sleeps (client gone, 10s operation timer, shutdown):
//    the prompt was typed, so the receipt is accepted and says why unconfirmed.
{
  const controller = new AbortController();
  const f = fake({ onPrompt: () => setTimeout(() => controller.abort(), 10), after: [box('[x] hi')] });
  const receipt = await deliverAgentPrompt(f.run, target, '[x] hi', controller.signal);
  assert.equal(receipt.state, 'accepted', JSON.stringify(receipt));
  assert.equal(receipt.evidence.at(-1), 'watch interrupted after submit; delivery not confirmed');
  assert.equal(f.prompts(), 1);
}
// 2. The Enter retry itself fails: still accepted, never thrown.
{
  const f = fake({ after: [box('[x] stuck')], failEnter: true });
  const receipt = await deliverAgentPrompt(f.run, target, '[x] stuck', new AbortController().signal);
  assert.equal(receipt.state, 'accepted', JSON.stringify(receipt));
  assert.deepEqual(receipt.evidence, ['herdr agent prompt accepted', 'watch interrupted after submit; delivery not confirmed']);
  assert.equal(f.enters(), 1);
}
// 3. The pane cannot be read BEFORE submit: a draft cannot be ruled out, so
//    nothing is typed, and the error names the read that failed.
{
  const f = fake({ failRead: 'before' });
  await assert.rejects(deliverAgentPrompt(f.run, target, 'x', new AbortController().signal), (error: BackendError) =>
    error.code === 'backend_error' && /unreadable before submit/.test(error.message) && error.hint === 'herdr --session main pane read wD:p4 --source visible');
  assert.equal(f.prompts(), 0);
}
// 4. Someone else's prompt is already queued: the marker alone does not speak
//    for ours; our text still in the box gets the Enter retry.
{
  const f = fake({ before: box('', [QUEUED]), after: [box('[x] mine', [QUEUED]), box('[x] mine', [QUEUED]), box('', [QUEUED])] });
  const receipt = await deliverAgentPrompt(f.run, target, '[x] mine', new AbortController().signal);
  assert.equal(f.enters(), 1, JSON.stringify(receipt));
  assert.equal(receipt.state, 'queued', 'box emptied under a queued marker');
  assert.ok(receipt.evidence.includes('Enter retried once'));
}
// ...while a marker that appears only after our submit is queued at once.
{
  const f = fake({ after: [box('', [QUEUED])] });
  assert.equal((await deliverAgentPrompt(f.run, target, '[x] busy', new AbortController().signal)).state, 'queued');
  assert.equal(f.enters(), 0);
}
// 5. Hints quote roster values that a shell would split or run.
assert.equal(shellWord('main'), 'main');
assert.equal(shellWord('wD:p4'), 'wD:p4');
assert.equal(shellWord("my session; rm -rf ~"), "'my session; rm -rf ~'");
assert.equal(shellWord("it's"), "'it'\\''s'");
{
  const session = 'team a;b';
  const t = Buffer.from(session).toString('base64url') + '/' + Buffer.from('wD').toString('base64url') + ':4';
  const f = fake({ session, before: box('draft') });
  await assert.rejects(deliverAgentPrompt(f.run, t, 'x', new AbortController().signal), (error: BackendError) =>
    error.code === 'composer_not_empty' && error.hint === "herdr --session 'team a;b' pane read wD:p4 --source visible");
}
// 6. Base-36 pane ids: the roster key is the decimal window index the
//    dashboard shows, so `:12` is pane pC and `:38` is pane p12.
{
  const f = fake({ panes: [pane('wD:p12'), pane('wD:pC', { agent: 'codex' })] });
  const roster = await readRoster(f.run, new AbortController().signal);
  const space = Buffer.from('main').toString('base64url') + '/' + Buffer.from('wD').toString('base64url');
  assert.deepEqual([...roster.targets].map(([key, value]) => [key, value.pane.id]).sort(), [[space + ':12', 'wD:pC'], [space + ':38', 'wD:p12']]);
  for (const window of roster.sessions[0].windows) assert.equal(roster.targets.get(`${roster.sessions[0].name}:${window.index}`)?.pane.agent, window.agent, 'dashboard index and roster key name the same pane');
}
console.log('PASS send watch: post-submit abort and failed Enter stay accepted, pre-submit read failure refuses, stale queued marker, quoted hints, base-36 pane keys');
