import { createDeliveryFeed } from './mod.createDeliveryFeed.ts';
import { createDeliveryDedup } from './mod.createDeliveryDedup.ts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServerWebSocket } from 'bun';
import { createHerdrBackend } from './mod.createHerdrBackend.ts';
import { BackendError } from './types.ts';
import { HTTPError } from './serverTypes.ts';
import { readServeConfig } from './mod.readServeConfig.ts';
import { loopbackHost } from './mod.loopbackHost.ts';
import { requestOrigin } from './mod.requestOrigin.ts';
import { createAccessLog } from './mod.accessLog.ts';
import { readJSON } from './mod.readJSON.ts';
import { serveAPI } from './mod.serveAPI.ts';
import { serveMCP } from './mod.serveMCP.ts';
import { createPtySession } from './mod.createPtySession.ts';
import { createSocketSession, type SocketData } from './mod.createSocketSession.ts';

export async function runBunServe(args: string[]): Promise<number> {
  const config = readServeConfig(args);
  const tokenHash = createHash('sha256').update(config.token).digest();
  const tokenConfigured = config.token.length > 0;
  config.token = '';
  const backend = createHerdrBackend(config.binary, config.wakeEngine, config.explicitWakeEngine);
  const shutdown = new AbortController();
  const started = Date.now();
  const delivery = createDeliveryDedup();
  const deliveryHistory = createDeliveryFeed();
  const tickets = new Map<string, { origin: string; path: string; expires: number; readOnly?: boolean }>();
  const sockets = new Set<ServerWebSocket<SocketData>>();
  let connections = 0, requests = 0;
  const access = createAccessLog(!!config.accessLog);

  const server = Bun.serve<SocketData>({
    hostname: config.hostname, port: config.port, development: false,
    maxRequestBodySize: 257 << 10, idleTimeout: 20,
    async fetch(request, instance) {
      const startedAt = performance.now();
      const requestURL = new URL(request.url);
      const clientIP = instance.requestIP(request)?.address || '';
      // Wrapped rather than logged at each return: there are a dozen early
      // exits in here and a log line attached to only some of them is worse
      // than none, because the gaps look like requests that never arrived.
      const logged = (response: Response, note?: string) => {
        const length = response.headers.get('content-length');
        access({
          ip: clientIP,
          method: request.method,
          url: requestURL,
          status: response.status,
          bytes: length === null ? null : Number(length),
          ms: performance.now() - startedAt,
          origin: request.headers.get('origin') || '',
          note,
        });
        return response;
      };
      const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      const json = (value: unknown, status = 200, note?: string) => logged(Response.json(value, { status, headers }), note);
      const failure = (status: number, error: string) => json({ error }, status, error);
      let path = new URL(request.url).pathname;
      if (shutdown.signal.aborted || requests >= 64) return failure(503, 'server_busy');
      requests++;
      const deadline = new AbortController();
      const timeout = setTimeout(() => deadline.abort(), 15_000);
      const signal = AbortSignal.any([shutdown.signal, request.signal, deadline.signal]);
      try {
        let origin = '';
        if (config.engine) {
          if (!loopbackHost(request.headers.get('host') || '') || !loopbackHost(instance.requestIP(request)?.address || '')) return failure(403, 'engine_loopback_required');
          if (request.headers.has('origin')) return failure(403, 'engine_origin_not_allowed');
          if (path !== '/api/herdr' && !path.startsWith('/api/herdr/')) return failure(404, 'not_found');
          const suffix = path.slice('/api/herdr'.length);
          if (suffix === '/auth/ws-ticket') return failure(501, 'engine_ws_ticket_not_supported');
          path = !suffix || suffix === '/' ? '/api/identity' : suffix === '/ws' || suffix === '/ws/pty' || suffix === '/health' ? suffix : '/api' + suffix;
        } else {
          if (!loopbackHost(request.headers.get('host') || '')) return failure(403, 'host_not_allowed');
          origin = requestOrigin(request, config.allowOrigins ?? []);
          if (origin) { headers.set('Access-Control-Allow-Origin', origin); headers.set('Vary', 'Origin'); }
          if (request.method === 'OPTIONS') {
            headers.append('Vary', 'Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network');
            if (!origin || !['GET', 'POST'].includes(request.headers.get('Access-Control-Request-Method') || '')) return failure(403, 'preflight_not_allowed');
            const requested = request.headers.get('Access-Control-Request-Headers');
            const names = requested === null ? [] : requested.split(',').map(name => name.trim().toLowerCase());
            const allowedHeaders = config.mcp && path === '/mcp' ? ['authorization', 'content-type', 'mcp-protocol-version'] : ['authorization', 'content-type'];
            if (new Set(names).size !== names.length || names.some(name => !allowedHeaders.includes(name))) return failure(403, 'preflight_not_allowed');
            const pna = request.headers.get('Access-Control-Request-Private-Network');
            if (pna !== null && pna !== 'true') return failure(403, 'preflight_not_allowed');
            if (pna) headers.set('Access-Control-Allow-Private-Network', 'true');
            headers.set('Access-Control-Allow-Methods', 'GET, POST'); headers.set('Access-Control-Allow-Headers', config.mcp && path === '/mcp' ? 'Authorization, Content-Type, MCP-Protocol-Version' : 'Authorization, Content-Type');
            return new Response(null, { status: 204, headers });
          }
        }
        const allowed = path === '/api/auth/ws-ticket' || path === '/api/send' || path === '/api/wake' || path === '/api/worktrees/cleanup' ? ['POST'] : ['/api/asks', '/api/ui-state', '/api/feed'].includes(path) ? ['GET', 'POST'] : ['GET'];
        const methodError = () => { headers.set('Allow', allowed.join(', ')); return failure(405, 'method_not_allowed'); };
        let readOnly = false;
        if (path === '/ws' || path === '/ws/pty') {
          if (request.method !== 'GET') return methodError();
          if ((!config.engine && !origin) || request.url.includes('?')) return failure(400, 'websocket_request_invalid');
          const offers = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(value => value.trim());
          const ticketless = !!config.insecure && path === '/ws' && offers.length === 1 && offers[0] === '';
          if (!config.engine && ticketless) {
            readOnly = true;
          } else if (!config.engine) {
            if (offers.length !== 2 || offers[0] !== 'maw.ws.v1') return failure(401, 'websocket_ticket_required');
            const ticket = tickets.get(offers[1]);
            if (!/^mwt1_[0-9a-f]{64}$/.test(offers[1]) || !ticket || ticket.origin !== origin || ticket.path !== path || ticket.expires <= Date.now()) return failure(401, 'websocket_ticket_invalid');
            readOnly = !!ticket.readOnly;
            tickets.delete(offers[1]); // Single-use, before upgrade, with no intervening await.
          }
          // Unreachable while the ticket route refuses read-only pty tickets; kept
          // so a future ticket path cannot silently reopen the hole.
          if (path === '/ws/pty' && readOnly) return failure(401, 'operator_token_required_for_writes');
          if (connections >= 32) return failure(503, 'websocket_capacity_reached');
          if (offers.includes('maw.ws.v1')) headers.set('Sec-WebSocket-Protocol', 'maw.ws.v1');
          if (instance.upgrade(request, { headers, data: { controller: new AbortController(), path, readOnly } })) {
            connections++;
            // A socket has no Response to carry a status, so the upgrade is
            // reported as the 101 it is; otherwise the busiest client on the
            // server would be the one that never appears in the log.
            access({ ip: clientIP, method: request.method, url: requestURL, status: 101, bytes: null,
              ms: performance.now() - startedAt, origin: request.headers.get('origin') || '',
              note: readOnly ? 'ws read-only' : 'ws' });
            return;
          }
          return failure(400, 'websocket_request_invalid');
        }
        const WRITE_ROUTES = new Set(['/api/send', '/api/wake', '/api/worktrees/cleanup']);
        // A send refused for want of the token, over POST /api/send or MCP herdr_send.
        const recordAuthReject = () => deliveryHistory.append({ timestamp: Math.floor(Date.now() / 1000), kind: 'message', direction: 'inbound', state: 'failed', route: 'auth', event: 'auth-reject', decision: 'operator_token_required', source: 'herdr', from: '', to: '', target: '', text: '', oracle: '' });
        const isWrite = path !== '/api/auth/ws-ticket' && (request.method === 'POST' || WRITE_ROUTES.has(path));
        const authorization = request.headers.get('authorization') || '';
        const authenticated = tokenConfigured && authorization.startsWith('Bearer ')
          && timingSafeEqual(createHash('sha256').update(authorization.slice(7)).digest(), tokenHash);
        // /mcp carries reads and writes in one POST, so the per-tool rule lives in
        // serveMCP: reads follow the mode, writes always need the token. Host and
        // Origin were already checked above, exactly as for every other route.
        if (config.mcp && !config.engine && path === '/mcp') {
          const display = config.hostname.includes(':') ? `[${config.hostname}]` : config.hostname;
          return logged(await serveMCP(request, { authenticated, insecure: !!config.insecure, signal, base: `http://${display}:${server.port}`,
            tokenFile: config.tokenFile, binary: config.binary, worktreeRoot: config.worktreeRoot, onSendRefused: recordAuthReject,
            route: (route, init) => {
              const url = new URL(route, 'http://127.0.0.1');
              for (const [key, value] of Object.entries(init?.query ?? {})) url.searchParams.set(key, value);
              const body = init?.body === undefined ? undefined : JSON.stringify(init.body);
              const synthetic = new Request(url, body === undefined ? { method: 'GET' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
              return serveAPI(synthetic, route, config, backend, started, signal, delivery, deliveryHistory);
            } }, headers));
        }
        if (!config.engine) {
          if (config.insecure && !isWrite) { /* read-only demo access */ }
          else if (config.insecure && isWrite) {
            return failure(401, 'operator_token_required_for_writes');
          } else if (!authenticated) {
            if (path === '/api/send' && request.method === 'POST') recordAuthReject();
            return failure(401, 'operator_token_required');
          }
        }
        if (!allowed.includes(request.method)) return methodError();
        if (path === '/api/auth/ws-ticket') {
          if (!origin || request.url.includes('?')) return failure(400, 'ticket_request_invalid');
          const body = await readJSON(request, 128, signal);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'path') || ('path' in body && typeof body.path !== 'string')) return failure(400, 'invalid_json');
          if (!('path' in body) || (body.path !== '/ws' && body.path !== '/ws/pty')) return failure(400, 'ticket_path_invalid');
          // A pty is a write surface: it carries keystrokes into a live pane. Demo
          // mode mints read-only tickets, but the pty session has no read-only
          // mode to honour, so the only safe read-only pty ticket is none at all.
          if (body.path === '/ws/pty' && config.insecure && !authenticated) return failure(401, 'operator_token_required_for_writes');
          const now = Date.now();
          for (const [key, ticket] of tickets) if (ticket.expires <= now) tickets.delete(key);
          if (tickets.size >= 256) return failure(429, 'too_many_tickets');
          const value = 'mwt1_' + randomBytes(32).toString('hex');
          tickets.set(value, { origin, path: body.path, expires: now + 30_000, readOnly: !!config.insecure && !authenticated });
          return json({ protocol: 'maw.ws.v1', ticket: value });
        }
        return json(await serveAPI(request, path, config, backend, started, signal, delivery, deliveryHistory));
      } catch (error) {
        if (error instanceof HTTPError) return json(error.body ?? { error: error.message }, error.status);
        if (error instanceof BackendError && error.code === 'target_not_found') return failure(404, 'target_not_found');
        if (error instanceof BackendError && error.code === 'target_not_agent') return failure(409, 'target_not_agent');
        if (path === '/api/health' || path === '/health') return json({ ok: false, error: 'herdr_unavailable' }, 503);
        return failure(503, 'herdr_unavailable');
      } finally { clearTimeout(timeout); requests--; }
    },
    websocket: {
      maxPayloadLength: 64 << 10, backpressureLimit: 8 << 20, closeOnBackpressureLimit: true,
      perMessageDeflate: false, idleTimeout: 60,
      open(ws) { sockets.add(ws); ws.data.session = ws.data.path === '/ws/pty' ? createPtySession(ws, backend) : createSocketSession(ws, backend); },
      message(ws, message) { ws.data.session?.message(message); },
      close(ws) { ws.data.session?.close(); sockets.delete(ws); connections--; },
    },
    error() { return Response.json({ error: 'request_failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } }); },
  });
  const hostname = server.hostname || config.hostname;
  const displayHost = hostname.includes(':') ? `[${hostname}]` : hostname;
  if (config.accessLog) console.error('maw herdr serve: access log on (--no-access-log to silence).');
  if (config.allowOrigins?.length) console.error(`maw herdr serve: extra allowed origins — ${config.allowOrigins.join(', ')}`);
  console.error(`maw herdr serve: http://${displayHost}:${server.port}${config.engine ? '/api/herdr' : ''} (Bun/TypeScript; ${config.engine ? 'engine child; gateway authenticates remote clients' : config.insecure ? 'INSECURE read-only demo; no token required' : 'operator token required; core dashboard only'})`);
  if (config.mcp) console.error(`maw herdr serve: MCP at http://${displayHost}:${server.port}/mcp (read tools follow the mode; write tools always require the operator token)`);
  if (config.insecure) {
    // Loopback is not a boundary against a browser: any page the operator
    // visits can reach this port. Reads are open here, so say so plainly and
    // stop on a deadline rather than lingering.
    console.error('maw herdr serve: WARNING — reads (sessions, panes, captures) are open to any local process or web page.');
    console.error('maw herdr serve: writes (send, wake, cleanup, terminal) still require --token-file.');
    console.error(`maw herdr serve: stopping automatically in ${config.demoMinutes} minute(s).`);
    const demoTimer = setTimeout(() => {
      console.error('maw herdr serve: demo window elapsed; stopping.');
      shutdown.abort();
      server.stop(true);
      process.exit(0);
    }, (config.demoMinutes ?? 30) * 60_000);
    demoTimer.unref?.();
  }
  return new Promise<number>(resolve => {
    const stop = async () => {
      if (shutdown.signal.aborted) return;
      shutdown.abort(); tickets.clear();
      for (const socket of sockets) { socket.data.session?.close(); socket.close(1001, 'server shutting down'); }
      let force: ReturnType<typeof setTimeout> | undefined;
      const forced = new Promise<void>(done => {
        force = setTimeout(() => {
          for (const socket of sockets) socket.terminate();
          void server.stop(true).then(done, done);
        }, 1000);
      });
      try { await Promise.all([Promise.race([server.stop(), forced]), backend.close?.()]); }
      finally { clearTimeout(force); for (const signal of signals) process.off(signal, stop); resolve(0); }
    };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    for (const signal of signals) process.on(signal, stop);
  });
}
