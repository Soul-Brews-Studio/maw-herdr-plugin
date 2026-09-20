import type { ServerWebSocket } from 'bun';
import type { Backend } from './types.ts';
import { validateCommand, type Command } from './mod.validateCommand.ts';

export interface SocketData { controller: AbortController; session?: ReturnType<typeof createSocketSession> }

export function createSocketSession(ws: ServerWebSocket<SocketData>, backend: Backend) {
  const signal = ws.data.controller.signal;
  let stopped = false, pending = 0, lastSessions = '', selected = '', lastContent = '', haveContent = false;
  let available = new Set<string>();
  let previews = new Map<string, string>();
  const previewSent = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => { stopped = true; clearTimeout(timer); ws.data.controller.abort(); };
  const write = (value: unknown) => {
    if (stopped) return false;
    if (ws.send(JSON.stringify(value)) <= 0) { ws.close(1013, 'slow client'); close(); return false; }
    return true;
  };
  const error = (reason: string) => write({ type: 'error', error: reason });
  const roster = async (force: boolean) => {
    let sessions;
    try { sessions = await backend.sessions(signal); }
    catch { error('herdr_unavailable'); return false; }
    if (stopped) return false;
    available = new Set(sessions.flatMap(session => session.windows.map(window => `${session.name}:${window.index}`)));
    const data = JSON.stringify(sessions);
    if (!force && data === lastSessions) return true;
    lastSessions = data;
    if (!write({ type: 'sessions', sessions })) return false;
    return write({ type: 'recent', agents: sessions.flatMap(session => session.windows.map(window => ({ target: `${session.name}:${window.index}`, name: window.name, session: session.name }))) });
  };
  const capture = async () => {
    let departed = false;
    if (selected && !available.has(selected)) { selected = ''; haveContent = false; departed = true; }
    for (const target of previews.keys()) if (!available.has(target)) { previews.delete(target); previewSent.delete(target); departed = true; }
    if (departed) error('subscription_target_gone');
    const targets: Record<string, number> = Object.create(null);
    for (const target of previews.keys()) targets[target] = 15;
    if (selected) targets[selected] = 80;
    if (!Object.keys(targets).length) return;
    let contents;
    try { contents = await backend.captureBatch(targets, signal); }
    catch { error('capture_unavailable'); return; }
    if (selected && (!haveContent || contents[selected] !== lastContent)) {
      write({ type: 'capture', target: selected, content: contents[selected] });
      lastContent = contents[selected]; haveContent = true;
    }
    const changed: Record<string, string> = Object.create(null);
    for (const [target, previous] of previews) if (!previewSent.has(target) || contents[target] !== previous) {
      changed[target] = contents[target]; previews.set(target, contents[target]); previewSent.add(target);
    }
    if (Object.keys(changed).length) write({ type: 'previews', data: changed });
  };
  const command = async (body: Command) => {
    switch (body.type) {
      case 'select': case 'subscribe':
        if (!body.target || Buffer.byteLength(body.target) > 1024 || (body.scope && !['main', 'preview'].includes(body.scope))) { error('subscription_invalid'); return; }
        if (body.scope === 'preview') {
          if (!previews.has(body.target) && previews.size >= 16) { error('too_many_previews'); return; }
          previews.set(body.target, ''); previewSent.delete(body.target);
        } else { selected = body.target; haveContent = false; }
        await capture(); return;
      case 'subscribe-previews':
        if ((body.targets?.length || 0) > 16) { error('too_many_previews'); return; }
        if (body.targets?.some(target => !target || Buffer.byteLength(target) > 1024)) { error('subscription_invalid'); return; }
        previews = new Map((body.targets || []).map(target => [target, ''])); previewSent.clear(); await capture(); return;
      case 'send':
        if (!body.target || !body.text) { error('target_and_text_required'); return; }
        if (body.force || body.inbox || body.attachments?.length) { error('send_options_not_supported'); return; }
        try { await backend.send(body.target, body.text, signal); }
        catch { error('send_failed'); return; }
        write({ type: 'sent', ok: true, target: body.target, text: body.text, state: 'accepted' }); return;
      default: error('command_not_supported');
    }
  };
  const enqueue = (work: () => Promise<void>) => {
    if (stopped) return;
    if (pending >= 8) { ws.close(1008, 'too many commands'); close(); return; }
    pending++;
    chain = chain.then(async () => { if (!stopped) await work(); }).catch(() => {
      ws.close(1011, 'server operation failed'); close();
    }).finally(() => { pending--; });
  };
  const poll = () => {
    if (stopped) return;
    enqueue(async () => { if (await roster(false)) await capture(); });
    // Schedule only after previous work settles: a slow backend never grows a timer queue.
    void chain.then(() => { if (!stopped) timer = setTimeout(poll, 1000); });
  };
  enqueue(async () => {
    write({ type: 'feed-history', events: [] });
    if (!await roster(true)) { ws.close(1011, 'herdr unavailable'); close(); }
  });
  void chain.then(() => { if (!stopped) timer = setTimeout(poll, 1000); });
  return { close, message(value: string | Buffer) {
    if (typeof value !== 'string') { ws.close(1003, 'text JSON required'); close(); return; }
    let body: Command;
    try { body = validateCommand(JSON.parse(value), true); }
    catch { ws.close(1008, 'invalid command JSON'); close(); return; }
    enqueue(() => command(body));
  } };
}
