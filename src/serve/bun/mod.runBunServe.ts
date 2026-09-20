import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServerWebSocket } from 'bun';
import { createHerdrBackend } from './mod.createHerdrBackend.ts';
import { BackendError } from './types.ts';
import { HTTPError } from './serverTypes.ts';
import { readServeConfig } from './mod.readServeConfig.ts';
import { loopbackHost } from './mod.loopbackHost.ts';
import { requestOrigin } from './mod.requestOrigin.ts';
import { readJSON } from './mod.readJSON.ts';
import { serveAPI } from './mod.serveAPI.ts';
import { createPtySession } from './mod.createPtySession.ts';
import { createSocketSession, type SocketData } from './mod.createSocketSession.ts';

export async function runBunServe(args: string[]): Promise<number> {
  const config = readServeConfig(args);
  const tokenHash = createHash('sha256').update(config.token).digest();
  config.token = '';
  const backend = createHerdrBackend(config.binary, config.wakeEngine, config.explicitWakeEngine);
  const shutdown = new AbortController();
  const started = Date.now();
  const tickets = new Map<string, { origin: string; path: string; expires: number }>();
  const sockets = new Set<ServerWebSocket<SocketData>>();
  let connections = 0, requests = 0;
  const server = Bun.serve<SocketData>({
    hostname: config.hostname, port: config.port, development: false,
    maxRequestBodySize: 257 << 10, idleTimeout: 20,
    async fetch(request, instance) {
      const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
      const failure = (status: number, error: string) => json({ error }, status);
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
          origin = requestOrigin(request);
          if (origin) { headers.set('Access-Control-Allow-Origin', origin); headers.set('Vary', 'Origin'); }
          if (request.method === 'OPTIONS') {
            headers.append('Vary', 'Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network');
            if (!origin || !['GET', 'POST'].includes(request.headers.get('Access-Control-Request-Method') || '')) return failure(403, 'preflight_not_allowed');
            const requested = request.headers.get('Access-Control-Request-Headers');
            const names = requested === null ? [] : requested.split(',').map(name => name.trim().toLowerCase());
            if (new Set(names).size !== names.length || names.some(name => !['authorization', 'content-type'].includes(name))) return failure(403, 'preflight_not_allowed');
            const pna = request.headers.get('Access-Control-Request-Private-Network');
            if (pna !== null && pna !== 'true') return failure(403, 'preflight_not_allowed');
            if (pna) headers.set('Access-Control-Allow-Private-Network', 'true');
            headers.set('Access-Control-Allow-Methods', 'GET, POST'); headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
            return new Response(null, { status: 204, headers });
          }
        }
        const allowed = path === '/api/auth/ws-ticket' || path === '/api/send' || path === '/api/wake' || path === '/api/worktrees/cleanup' ? ['POST'] : ['/api/asks', '/api/ui-state'].includes(path) ? ['GET', 'POST'] : ['GET'];
        const methodError = () => { headers.set('Allow', allowed.join(', ')); return failure(405, 'method_not_allowed'); };
        if (path === '/ws' || path === '/ws/pty') {
          if (request.method !== 'GET') return methodError();
          if ((!config.engine && !origin) || request.url.includes('?')) return failure(400, 'websocket_request_invalid');
          const offers = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(value => value.trim());
          if (!config.engine) {
            if (offers.length !== 2 || offers[0] !== 'maw.ws.v1') return failure(401, 'websocket_ticket_required');
            const ticket = tickets.get(offers[1]);
            if (!/^mwt1_[0-9a-f]{64}$/.test(offers[1]) || !ticket || ticket.origin !== origin || ticket.path !== path || ticket.expires <= Date.now()) return failure(401, 'websocket_ticket_invalid');
            tickets.delete(offers[1]); // Single-use, before upgrade, with no intervening await.
          }
          if (connections >= 32) return failure(503, 'websocket_capacity_reached');
          if (offers.includes('maw.ws.v1')) headers.set('Sec-WebSocket-Protocol', 'maw.ws.v1');
          if (instance.upgrade(request, { headers, data: { controller: new AbortController(), path } })) { connections++; return; }
          return failure(400, 'websocket_request_invalid');
        }
        if (!config.engine) {
          const authorization = request.headers.get('authorization') || '';
          if (!authorization.startsWith('Bearer ') || !timingSafeEqual(createHash('sha256').update(authorization.slice(7)).digest(), tokenHash)) return failure(401, 'operator_token_required');
        }
        if (!allowed.includes(request.method)) return methodError();
        if (path === '/api/auth/ws-ticket') {
          if (!origin || request.url.includes('?')) return failure(400, 'ticket_request_invalid');
          const body = await readJSON(request, 128, signal);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'path') || ('path' in body && typeof body.path !== 'string')) return failure(400, 'invalid_json');
          if (!('path' in body) || (body.path !== '/ws' && body.path !== '/ws/pty')) return failure(400, 'ticket_path_invalid');
          const now = Date.now();
          for (const [key, ticket] of tickets) if (ticket.expires <= now) tickets.delete(key);
          if (tickets.size >= 256) return failure(429, 'too_many_tickets');
          const value = 'mwt1_' + randomBytes(32).toString('hex');
          tickets.set(value, { origin, path: body.path, expires: now + 30_000 });
          return json({ protocol: 'maw.ws.v1', ticket: value });
        }
        return json(await serveAPI(request, path, config, backend, started, signal));
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
  console.error(`maw herdr serve: http://${displayHost}:${server.port}${config.engine ? '/api/herdr' : ''} (Bun/TypeScript; ${config.engine ? 'engine child; gateway authenticates remote clients' : 'operator token required; core dashboard only'})`);
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
