import { serveFeedActivity } from './mod.serveFeedActivity.ts';
import type { createDeliveryFeed } from './mod.createDeliveryFeed.ts';
import { recordDelivery } from './mod.recordDelivery.ts';
import { claimDelivery } from './mod.claimDelivery.ts';
import type { createDeliveryDedup } from './mod.createDeliveryDedup.ts';
import { serveWorktrees } from './mod.serveWorktrees.ts';
import type { Backend } from './types.ts';
import { HTTPError, type ServeConfig } from './serverTypes.ts';
import { readJSON } from './mod.readJSON.ts';
import { validateCommand } from './mod.validateCommand.ts';
import { serveState } from './mod.serveState.ts';

export async function serveAPI(request: Request, path: string, config: ServeConfig, backend: Backend, started: number, signal: AbortSignal, delivery?: ReturnType<typeof createDeliveryDedup>, history?: ReturnType<typeof createDeliveryFeed>): Promise<unknown> {
  if (path === '/api/ui-state' || path === '/api/asks') return serveState(request, path, config.dataDir, signal);
  switch (path) {
    case '/api/worktrees': case '/api/worktrees/cleanup': return serveWorktrees(request, path, config.worktreeRoot, backend, signal);
    case '/api/wake': {
      const body = await readJSON(request, 64 << 10, signal);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.entries(body).some(([key, value]) => !['target', 'task', 'command'].includes(key) || (value !== null && typeof value !== 'string'))) throw new HTTPError(400, 'invalid_json');
      if (!('target' in body) || typeof body.target !== 'string' || !body.target || Buffer.byteLength(body.target) > 1024) throw new HTTPError(400, 'target_required');
      if ('task' in body && typeof body.task === 'string' && Buffer.byteLength(body.task) > 1024) throw new HTTPError(400, 'invalid_task');
      const state = await backend.wake(body.target, signal, 'task' in body && typeof body.task === 'string' ? body.task : undefined);
      return { ok: true, target: body.target, state };
    }
    case '/api/send': {
      let body;
      try { body = validateCommand(await readJSON(request, 64 << 10, signal)); }
      catch (error) { if (error instanceof HTTPError) throw error; throw new HTTPError(400, 'invalid_json'); }
      const originalText = body.text;
      if (body.attachments?.length) body.text = [...body.attachments, body.text ?? ''].join('\n');
      if (!body.target) throw new HTTPError(400, 'target_and_text_required');
      if (body.inbox) {
        if (!backend.inbox) throw new HTTPError(501, 'send_options_not_supported');
        const claim = await claimDelivery(request, body.target, body.text ?? '', originalText ?? '', 'inbox', config, backend, delivery, signal);
        if (claim.duplicate) {
          await recordDelivery(history, backend, request, body.target, body.text ?? '', body.inbox ? 'inbox' : 'local', 'deduped', signal);
          return claim.duplicate;
        }
        try {
          const inbox = await backend.inbox(body.target, body.text ?? '', config.worktreeRoot, request.headers.get('X-Maw-From') ?? '', signal);
          claim.complete('queued');
          await recordDelivery(history, backend, request, body.target, body.text ?? '', 'inbox', 'queued', signal);
          return { ok: true, target: body.target, text: originalText ?? '', source: 'inbox', state: 'queued', inbox,
            reason: '--inbox requested; pane injection skipped', receipt: ['fallback_queued'] };
        } catch (error) {
          await recordDelivery(history, backend, request, body.target, body.text ?? '', body.inbox ? 'inbox' : 'local', 'failed', signal);
          throw error;
        } finally { claim.cancel(); }
      }
      if (!body.text) throw new HTTPError(400, 'target_and_text_required');
      if (body.force) throw new HTTPError(501, 'send_options_not_supported');
      const claim = await claimDelivery(request, body.target, body.text, body.text, 'local', config, backend, delivery, signal);
      if (claim.duplicate) {
          await recordDelivery(history, backend, request, body.target, body.text ?? '', body.inbox ? 'inbox' : 'local', 'deduped', signal);
          return claim.duplicate;
        }
      try {
        await backend.send(body.target, body.text, signal);
        claim.complete('accepted');
        await recordDelivery(history, backend, request, body.target, body.text, 'local', 'accepted', signal);
        return { ok: true, target: body.target, text: body.text, source: 'local', lastLine: '', state: 'accepted', receipt: ['herdr agent prompt accepted'],
          warning: 'Prompt acceptance does not imply consumption or completion; this path does not queue an inbox message.' };
      } catch (error) {
          await recordDelivery(history, backend, request, body.target, body.text ?? '', body.inbox ? 'inbox' : 'local', 'failed', signal);
          throw error;
        } finally { claim.cancel(); }
    }
    case '/api/sessions': return backend.sessions(signal);
    case '/api/capture': {
      const target = new URL(request.url).searchParams.get('target');
      if (!target) throw new HTTPError(400, 'target_required');
      try { return { content: await backend.capture(target, 200, signal), target, resolvedTarget: target }; }
      catch { throw new HTTPError(400, 'capture_unavailable', { content: '', target, resolvedTarget: target, error: 'capture_unavailable' }); }
    }
    case '/api/captures': {
      const targets: Record<string, number> = Object.create(null);
      for (const session of await backend.sessions(signal)) for (const window of session.windows) targets[`${session.name}:${window.index}`] = 200;
      if (Object.keys(targets).length > 64) throw new HTTPError(400, 'too_many_captures');
      return { captures: await backend.captureBatch(targets, signal) };
    }
    case '/api/agent': case '/api/agents': {
      const agents = (await backend.sessions(signal)).flatMap(session => session.windows.map(window => ({ node: config.node,
        session: session.name, window: String(window.index), oracle: window.name, state: window.status === 'working' ? 'active' : 'idle', pid: null })));
      return { agents, count: agents.length, node: config.node };
    }
    case '/api/identity': return { version: 'herdr-core-dev', runtime: 'bun', node: config.node, host: 'localhost', agents: [],
      uptime: Math.floor((Date.now() - started) / 1000), clockUtc: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      endpoints: config.engine ? ['/api/herdr/sessions', '/api/herdr/capture', '/api/herdr/send', '/api/herdr/wake', '/api/herdr/ws', '/api/herdr/ws/pty'] : ['/api/sessions', '/api/capture', '/api/send', '/api/wake', '/ws', '/ws/pty'],
      capabilities: ['sessions', 'capture', 'agent-prompt', 'dashboard-ws', 'terminal-stream', 'existing-pane-wake'] };
    case '/api/federation/status': case '/fed.json': return backend.federation.status(signal);
    case '/api/config':
      if (request.url.includes('?')) throw new HTTPError(400, 'config_query_not_supported');
      return { node: config.node, agents: config.agents, namedPeers: config.namedPeers ?? backend.federation.namedPeers() };
    case '/api/teams':
      await backend.sessions(signal);
      return backend.teamInventory();
    case '/api/costs': return { agents: [], total: { tokens: 0, cost: 0, sessions: 0, agents: 0 }, supported: false };
    case '/api/feed': {
      if (request.method === 'POST') return serveFeedActivity(request, backend, signal);
      const limits = new URL(request.url).searchParams.getAll('limit');
      if (limits.length > 1 || (limits.length && (!/^[0-9]+$/.test(limits[0]) || BigInt(limits[0]) > 18446744073709551615n))) throw new HTTPError(400, 'invalid_limit');
      const limit = limits.length ? Number(BigInt(limits[0]) > 200n ? 200n : BigInt(limits[0])) : undefined;
      if (!history) throw new HTTPError(503, 'delivery_history_unavailable');
      return history.snapshot(limit);
    }
    case '/api/health': case '/health':
      await backend.sessions(signal);
      return { ok: true };
    default: throw new HTTPError(404, 'not_found');
  }
}
