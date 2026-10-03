#!/usr/bin/env bun
// Real Bun HTTP server -> real isolated Herdr daemon -> unpaid raw-TTY stand-in.
// The stand-in reports as Claude; only its composer/queue behaviour is simulated.
// No CLI response, screen read, Enter, HTTP receipt or WS event is stubbed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withHerdrDaemon, waitFor } from './lib.herdrDaemon.mjs';

const self = fileURLToPath(import.meta.url);
const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;
const pause = ms => new Promise(done => setTimeout(done, ms));

// Run inside an owned pane, never spawn an installed model executable.
async function standIn(control, journal) {
  assert.ok(process.stdin.isTTY && process.stdout.isTTY);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  let seq = -1, mode = 'ready', composer = '', queued = '', echo = '', enters = 0;
  let input = '', pasting = false;
  const record = (kind, extra = {}) => appendFileSync(journal, JSON.stringify({ kind, seq, at: performance.now(), ...extra }) + '\n');
  const draw = () => {
    const rule = '─'.repeat(70);
    // Keep the queue marker in the bottom eight visible rows, as the real UI does.
    const lines = composer.split('\n');
    process.stdout.write('\x1b[2J\x1b[H' + `Echo: ${JSON.stringify(echo)}\r\n` +
      `\x1b[${process.stdout.rows - lines.length - 4};1H` + rule + '\r\n❯ ' +
      lines.join('\r\n  ') + '\r\n' + rule + '\r\n  Claude stand-in (no model)\r\n' +
      (queued ? '  Press up to edit queued messages' : ''));
  };
  const receive = text => { echo = text; record('received', { text }); };
  const enter = () => {
    record('enter', { text: composer });
    enters++;
    if (mode === 'stuck' || (mode === 'retry' && enters === 1)) { draw(); return; }
    if (mode === 'busy') { queued = composer; record('queued', { text: queued }); }
    else receive(composer);
    composer = '';
    draw();
  };
  process.stdout.write('\x1b[?1049h\x1b[?2004h');
  process.stdin.on('data', chunk => {
    input += chunk;
    while (input) {
      if (input.startsWith('\x1b')) {
        const marker = pasting ? '\x1b[201~' : '\x1b[200~';
        if (marker.startsWith(input) && input.length < marker.length) break;
        assert.ok(input.startsWith(marker), 'Unexpected terminal escape sequence');
        input = input.slice(marker.length); pasting = !pasting;
        if (!pasting) record('paste', { text: composer });
      } else {
        const char = input[0]; input = input.slice(1);
        if (!pasting && (char === '\r' || char === '\n')) enter();
        else composer += char;
      }
    }
    draw();
  });
  setInterval(() => {
    const next = JSON.parse(readFileSync(control, 'utf8'));
    if (next.seq === seq) return;
    seq = next.seq; mode = next.mode; enters = 0;
    if (mode === 'release') { receive(queued); queued = ''; }
    else { queued = ''; echo = ''; }
    composer = next.draft ?? '';
    draw();
    record('ready', { mode, columns: process.stdout.columns, rows: process.stdout.rows });
  }, 20);
}

async function smoke() {
  // Regression for harness teardown on an assertion failure, not just success.
  let failedHome;
  await assert.rejects(withHerdrDaemon(async daemon => {
    failedHome = daemon.directory;
    const space = await daemon.createSpace('cleanup-fixture');
    await daemon.createPane(space.pane, 'down');
    // Even an ambient caller environment cannot redirect the guarded client.
    const listed = spawnSync(daemon.client, ['session', 'list', '--json'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(listed.status, 0);
    assert.deepEqual(JSON.parse(listed.stdout).sessions.filter(item => item.running).map(item => item.name), [daemon.session]);
    const refused = spawnSync(daemon.client, ['--session', 'outside-fixture', 'api', 'snapshot'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /Refused a command outside the test session\. Run: bun /);
    assert.fail('intentional harness cleanup assertion');
  }), /intentional harness cleanup assertion/);
  assert.ok(!existsSync(failedHome), 'failed callback must stop/delete its session and remove its HOME');

  let successfulHome;
  const timings = {};
  await withHerdrDaemon(async daemon => {
    successfulHome = daemon.directory;
    const { directory, env } = daemon;
    const space = await daemon.createSpace('send-fixture');
    await daemon.herdr(['pane', 'rename', space.pane, 'send-fixture']);
    // report-agent alone does not satisfy Herdr's foreground-process guard.
    // A private copy of this JS runtime named claude does; no Claude binary runs.
    const agent = join(directory, 'claude');
    copyFileSync(process.execPath, agent);
    const control = join(directory, 'agent-control.json'), journal = join(directory, 'agent-journal.jsonl');
    writeFileSync(control, JSON.stringify({ seq: 0, mode: 'ready' }));
    writeFileSync(journal, '');
    await daemon.herdr(['pane', 'run', space.pane, `exec ${quote(agent)} ${quote(self)} --agent ${quote(control)} ${quote(journal)}`]);
    const events = () => readFileSync(journal, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    const ready = await waitFor(() => events().find(event => event.kind === 'ready'), 'stand-in startup');
    // Pane borders can reduce the usable 120×40 headless screen.
    assert.ok(ready.columns >= 100 && ready.columns <= 120);
    assert.ok(ready.rows >= 20 && ready.rows <= 40);
    let seq = 0;
    const report = async state => {
      await daemon.herdr(['pane', 'report-agent', space.pane, '--source', 'send-fixture', '--agent', 'claude', '--state', state]);
      await waitFor(async () => (await daemon.json(['agent', 'get', space.pane])).agent.agent_status === state, 'reported agent state');
    };
    const configure = async (mode, state = 'idle', draft = '') => {
      seq++;
      writeFileSync(control + '.next', JSON.stringify({ seq, mode, draft }));
      renameSync(control + '.next', control);
      await waitFor(() => events().some(event => event.kind === 'ready' && event.seq === seq), 'stand-in mode');
      await report(state);
      await waitFor(async () => (await daemon.readVisible(space.pane)).includes('Claude stand-in'), 'visible composer');
    };
    const recorded = kind => events().filter(event => event.seq === seq && event.kind === kind);
    await configure('ready');

    const token = randomBytes(24).toString('hex'), tokenFile = join(directory, 'token');
    writeFileSync(tokenFile, token, { mode: 0o600 });
    const entry = resolve(process.env.MAW_SEND_LIVE_ENTRY || 'index.mjs');
    const child = spawn(process.execPath, [entry, 'serve', '--token-file', tokenFile, '--listen', '127.0.0.1:0',
      '--herdr', daemon.client, '--data-dir', join(directory, 'ui')], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', spawnError;
    child.stdout.resume();
    child.stderr.on('data', data => { output = (output + data).slice(-16_384); });
    child.on('error', error => { spawnError = error; });
    const sockets = [];
    const interruptHTTP = () => {
      for (const { socket } of sockets) socket.close();
      child.kill('SIGTERM');
    };
    process.once('SIGINT', interruptHTTP);
    process.once('SIGTERM', interruptHTTP);
    try {
      const url = await waitFor(() => {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null) throw new Error('HTTP server exited: ' + output);
        return output.match(/http:\/\/[^\s]+/)?.[0];
      }, 'HTTP startup');
      const request = async (path, body, authenticated = true) => {
        const response = await fetch(url + path, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(15_000),
          headers: { Origin: url, 'Content-Type': 'application/json', 'X-Maw-From': 'sender:fixture',
            ...(authenticated ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: response.status, body: await response.json() };
      };
      const roster = await request('/api/sessions');
      assert.equal(roster.status, 200);
      assert.equal(roster.body.length, 1, 'roster discovery must see only the throwaway session');
      const window = roster.body[0].windows.find(window => window.name === 'send-fixture');
      assert.equal(window.agent, 'claude', 'Herdr must recognise the stand-in as an agent');
      const target = `${roster.body[0].name}:${window.index}`;
      const send = (text, authenticated = true) => request('/api/send', { target, text }, authenticated);
      const screen = () => daemon.readVisible(space.pane);

      // Two genuine dashboard subscribers, with origin-bound one-use tickets.
      for (let i = 0; i < 2; i++) {
        const ticket = await request('/api/auth/ws-ticket', { path: '/ws' });
        assert.equal(ticket.status, 200);
        const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws', { protocols: ['maw.ws.v1', ticket.body.ticket], headers: { Origin: url } });
        const messages = [];
        sockets.push({ socket, messages });
        socket.onmessage = event => messages.push(JSON.parse(event.data));
        await waitFor(() => messages.some(message => message.type === 'feed-history'), 'dashboard initial feed');
        socket.send(JSON.stringify({ type: 'select', target }));
        await waitFor(() => messages.some(message => message.type === 'capture'), 'dashboard initial capture');
      }
      const broadcast = async (state, after) => {
        for (let i = 0; i < sockets.length; i++) {
          const messages = sockets[i].messages;
          await waitFor(() => messages.slice(after[i]).some(message => message.type === 'sessions' &&
            message.sessions.some(session => session.windows.some(window => window.name === 'send-fixture' && window.status === state))), `dashboard ${state} roster`);
          const feed = await waitFor(() => messages.slice(after[i]).find(message => message.type === 'feed' && message.event.observedState === state), `dashboard ${state} feed`);
          assert.equal(feed.event.target, target);
          assert.equal(feed.event.oracle, 'send-fixture');
          assert.equal(feed.event.source, 'herdr-agent-status');
          assert.equal(feed.event.event, state === 'working' ? 'PreToolUse' : 'Stop');
          assert.match(feed.event.message, /status projection, not a tool hook/);
        }
      };
      const captureEcho = async text => {
        for (const { messages } of sockets) {
          await waitFor(() => messages.some(message => message.type === 'capture' && message.target === target &&
            message.content.includes(`Echo: ${JSON.stringify(text)}`)), 'broadcast echo capture');
        }
      };
      assert.equal((await send('unauthenticated', false)).status, 401);
      assert.equal(recorded('enter').length, 0);

      // Exact literal text (including multiline/Unicode/metacharacters), with sender tag.
      const text = 'hello λ\nsecond line; $(not-a-command)', tagged = '[fixture:sender] ' + text;
      let response = await send(text);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.state, 'delivered');
      assert.deepEqual(response.body.receipt, ['herdr agent prompt accepted', 'input box observed empty after submit']);
      assert.deepEqual(recorded('received').map(event => event.text), [tagged]);
      assert.equal(recorded('enter').length, 1);
      assert.ok((await screen()).includes(`Echo: ${JSON.stringify(tagged)}`));
      await captureEcho(tagged);

      // Busy is a working agent with an empty composer, not permission to overwrite a draft.
      let after = sockets.map(({ messages }) => messages.length);
      await configure('busy', 'working');
      await broadcast('working', after);
      response = await send('while busy');
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.state, 'queued');
      assert.ok(response.body.receipt.includes('agent shows the prompt as queued'));
      assert.deepEqual(recorded('queued').map(event => event.text), ['[fixture:sender] while busy']);
      assert.equal(recorded('received').length, 0, 'queued is not consumed');
      assert.equal(recorded('enter').length, 1);
      assert.match(await screen(), /Press up to edit queued messages/);
      for (const { messages } of sockets) await waitFor(() => messages.some(message => message.type === 'capture' &&
        message.content.includes('Press up to edit queued messages')), 'broadcast queued capture');
      after = sockets.map(({ messages }) => messages.length);
      await configure('release');
      assert.deepEqual(recorded('received').map(event => event.text), ['[fixture:sender] while busy']);
      await broadcast('idle', after);
      await captureEcho('[fixture:sender] while busy');

      // Swallow the initial Enter. The backend must wait two 250ms polls, then
      // send exactly one further Enter to the actual PTY, without repasting.
      await configure('retry');
      response = await send('retry once');
      assert.equal(response.body.state, 'delivered', JSON.stringify(response.body));
      assert.ok(response.body.receipt.includes('Enter retried once'));
      let keys = recorded('enter');
      assert.equal(keys.length, 2);
      timings.retryMs = Math.round(keys[1].at - keys[0].at);
      assert.ok(timings.retryMs >= 450 && timings.retryMs < 5000, `retry timing ${timings.retryMs}ms`);
      assert.deepEqual(keys.map(event => event.text), ['[fixture:sender] retry once', '[fixture:sender] retry once']);
      assert.deepEqual(recorded('received').map(event => event.text), ['[fixture:sender] retry once']);
      assert.equal(recorded('paste').length, 1, 'Enter retry must not paste twice');

      // Swallow both Enters: bounded accepted receipt, never fake delivery.
      await configure('stuck');
      const started = performance.now();
      response = await send('still pending');
      timings.acceptedMs = Math.round(performance.now() - started);
      assert.equal(response.body.state, 'accepted', JSON.stringify(response.body));
      assert.match(response.body.receipt.at(-1), /sent text still in input box after Enter retry; delivery not confirmed/);
      assert.ok(timings.acceptedMs >= 950 && timings.acceptedMs < 8000);
      await pause(300);
      assert.equal(recorded('enter').length, 2);
      assert.equal(recorded('received').length, 0);
      assert.ok((await screen()).includes('[fixture:sender] still pending'));

      // Refuse both a busy agent's draft and a blocked agent before ANY input.
      for (const [mode, state, draft, code] of [['draft', 'working', 'human draft untouched', 'composer_not_empty'], ['blocked', 'blocked', '', 'target_blocked']]) {
        const after = sockets.map(({ messages }) => messages.length);
        await configure(mode, state, draft);
        if (state === 'blocked') await broadcast('blocked', after);
        const before = await screen();
        response = await send('must not arrive');
        assert.equal(response.status, 409, JSON.stringify(response.body));
        assert.equal(response.body.error, code);
        assert.equal(response.body.state, 'failed');
        assert.equal(response.body.hint, `herdr --session ${daemon.session} pane read ${space.pane} --source visible`);
        assert.equal(recorded('paste').length, 0);
        assert.equal(recorded('enter').length, 0);
        assert.equal(recorded('received').length, 0);
        assert.equal(await screen(), before, 'refusal must leave the visible composer untouched');
      }

      // Lifecycle messages belong to GET /api/feed, not fake WS tool-hook events.
      const feed = await request('/api/feed');
      assert.equal(feed.status, 200);
      assert.equal(feed.body.events.length, 7);
      assert.equal(feed.body.events[0].event, 'auth-reject');
      assert.equal(feed.body.events[0].route, 'auth');
      assert.equal(feed.body.events[0].text, '');
      const deliveries = feed.body.events.slice(1);
      assert.deepEqual(deliveries.map(event => [event.text, event.state]), [
        [text, 'delivered'], ['while busy', 'queued'], ['retry once', 'delivered'], ['still pending', 'accepted'],
        ['must not arrive', 'failed'], ['must not arrive', 'failed'],
      ]);
      assert.deepEqual(feed.body.events.slice(-2).map(event => event.error), ['composer_not_empty', 'target_blocked']);
      for (const event of deliveries) {
        assert.equal(event.target, target); assert.equal(event.oracle, 'send-fixture');
        assert.equal(event.from, 'sender:fixture'); assert.equal(event.route, 'local');
        assert.equal(event.kind, event.state === 'failed' ? 'message' : 'context.message');
        assert.ok(Number.isInteger(event.timestamp));
      }
      assert.deepEqual(feed.body.active_oracles, ['', 'send-fixture']);
      assert.deepEqual((await request('/api/feed?limit=2')).body.events, feed.body.events.slice(-2));
      for (const { messages } of sockets) {
        assert.ok(!messages.some(message => message.type === 'sent' || message.type === 'error'));
        assert.ok(messages.filter(message => message.type === 'feed').every(message => message.event.source === 'herdr-agent-status'));
        assert.ok(!JSON.stringify(messages).includes(token));
      }
      assert.ok(!JSON.stringify(feed.body).includes(token));
      assert.ok(!output.includes(token));
    } finally {
      process.removeListener('SIGINT', interruptHTTP);
      process.removeListener('SIGTERM', interruptHTTP);
      interruptHTTP();
      try {
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'HTTP shutdown', 5000);
        assert.equal(child.exitCode, 0, 'HTTP server must exit cleanly');
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
  });
  assert.ok(!existsSync(successfulHome), 'successful callback must also remove its HOME');
  console.log(`PASS live send (${process.env.MAW_SEND_LIVE_ENTRY ? 'bundle/package' : 'source'}): isolated daemon cleanup, exact tagged text, queued/delivered/accepted receipts, retry ${timings.retryMs}ms, bounded watch ${timings.acceptedMs}ms, draft/blocked refusals, two dashboard WS subscribers and lifecycle feed`);
}

try {
  if (process.argv[2] === '--agent') await standIn(process.argv[3], process.argv[4]);
  else await smoke();
} catch (error) {
  console.error(`${error.stack}\nRun: bun ${quote(self)}`);
  process.exitCode = 1;
}
