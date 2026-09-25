/**
 * The smallest client for herdr's socket API that `watch` needs, and nothing more.
 *
 * Wire facts (herdr 0.9.1, protocol 22, measured and read in src/api/server.rs):
 *   - newline-delimited JSON over a unix socket; a request is {id, method, params}
 *     and the reply carries the same id plus `result` or `error: {code, message}`
 *   - ONE request per connection — a second request on the same socket gets
 *     ECONNRESET — except `events.subscribe`, which answers
 *     {"id", "result": {"type": "subscription_started"}} and then keeps streaming
 *   - a subscription line is {"event": <kind>, "data": {...}} with no id;
 *     pane.agent_status_changed arrives as event "pane.agent_status_changed",
 *     generic events (pane.closed, workspace.closed …) as "pane_closed" etc.
 *   - subscribing to pane.agent_status_changed PROBES the pane first: a pane that
 *     does not exist answers {"error": {"code": "pane_not_found"}} and the
 *     connection ends, before any subscription_started
 *   - a generic event subscription (pane.closed …) starts at sequence 0, so it
 *     REPLAYS up to 512 past events first; a consumer must verify, not trust
 *
 * The socket path is the `socket_path` that `herdr session list --json` reports
 * for the session, never HERDR_SOCKET_PATH (herdr exports that into every pane, so
 * a test run inside a pane would reach the live server) and never a guess.
 */
import { connect } from 'node:net';

export class HerdrSocketError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

let seq = 0;
const nextId = tag => `maw-herdr:${tag}:${process.pid}:${++seq}`;

/** Split a byte stream into JSON lines; unparseable lines are skipped, not fatal. */
function lineReader(onLine) {
  let buf = '';
  return chunk => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      onLine(msg);
    }
  };
}

/** One request, one connection, one reply. Resolves `result`; rejects HerdrSocketError. */
export function request(socketPath, method, params, { timeout = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId(method);
    const s = connect(socketPath);
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.destroy();
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new HerdrSocketError(`herdr ${method} did not answer within ${timeout} ms`, 'timeout')), timeout);
    s.on('connect', () => s.write(`${JSON.stringify({ id, method, params })}\n`));
    s.on('data', lineReader(msg => {
      if (msg?.id !== id) return;
      if (msg.error) finish(new HerdrSocketError(msg.error.message ?? String(msg.error.code), msg.error.code ?? 'error'));
      else finish(null, msg.result);
    }));
    s.on('error', err => finish(new HerdrSocketError(`cannot reach herdr at ${socketPath}: ${err.code ?? err.message}`, err.code ?? 'unreachable')));
    s.on('close', () => finish(new HerdrSocketError(`herdr closed ${socketPath} before answering ${method}`, 'closed')));
  });
}

/**
 * Open one events.subscribe connection. `ready` resolves on subscription_started
 * and rejects with the herdr error (pane_not_found …) or a transport error.
 * `onEvent(msg)` gets every event line after that; `onClose()` fires once when
 * the stream ends for any reason after it started. `close()` ends it quietly.
 */
export function subscribe(socketPath, subscriptions, { onEvent, onClose, timeout = 10_000 } = {}) {
  const id = nextId('subscribe');
  const s = connect(socketPath);
  let started = false;
  let closedByUs = false;
  let settle;
  const ready = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const timer = setTimeout(() => {
    if (started) return;
    settle.reject(new HerdrSocketError(`herdr did not start the subscription within ${timeout} ms`, 'timeout'));
    closedByUs = true;
    s.destroy();
  }, timeout);
  s.on('connect', () => s.write(`${JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions } })}\n`));
  s.on('data', lineReader(msg => {
    if (!started) {
      if (msg?.id !== id) return;
      clearTimeout(timer);
      if (msg.error) {
        settle.reject(new HerdrSocketError(msg.error.message ?? String(msg.error.code), msg.error.code ?? 'error'));
        closedByUs = true;
        s.destroy();
        return;
      }
      started = true;
      settle.resolve();
      return;
    }
    if (msg && typeof msg.event === 'string') onEvent?.(msg);
  }));
  s.on('error', err => {
    if (!started) {
      clearTimeout(timer);
      settle.reject(new HerdrSocketError(`cannot reach herdr at ${socketPath}: ${err.code ?? err.message}`, err.code ?? 'unreachable'));
    }
  });
  s.on('close', () => {
    clearTimeout(timer);
    if (!started) settle.reject(new HerdrSocketError(`herdr closed ${socketPath} before the subscription started`, 'closed'));
    else if (!closedByUs) onClose?.();
  });
  return {
    ready,
    close() {
      closedByUs = true;
      s.destroy();
    },
  };
}
