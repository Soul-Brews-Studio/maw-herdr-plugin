import type { ServerWebSocket } from "bun";
import type { Backend, Terminal } from "./types.ts";
import type { SocketData } from "./mod.createSocketSession.ts";

export function createPtySession(ws: ServerWebSocket<SocketData>, backend: Backend) {
  let stopped = false, attaching = false, attached = false, pending = 0, queuedBytes = 0;
  let terminal: Terminal | undefined;
  let chain = Promise.resolve();
  const close = () => { stopped = true; clearTimeout(attachTimer); ws.data.controller.abort(); terminal?.close(); };
  const fail = (code: number, reason: string) => { close(); ws.close(code, reason); };
  const attachTimer = setTimeout(() => fail(1008, "attach required"), 10_000);
  const write = (value: string | Buffer) => {
    if (stopped) return false;
    // A queued send (-1) is accepted, never resent. Bound backlog independently.
    if (ws.getBufferedAmount() > 4 * 1024 * 1024 || ws.send(value) === 0) { fail(1013, "slow terminal client"); return false; }
    return true;
  };
  const dimensions = (body: Record<string, unknown>) => Number.isInteger(body.cols) && Number.isInteger(body.rows) && Number(body.cols) >= 1 && Number(body.cols) <= 500 && Number(body.rows) >= 1 && Number(body.rows) <= 300;
  return { close, message(value: string | Buffer) {
    if (stopped) return;
    const bytes = Buffer.byteLength(value);
    if (++pending > 64 || (queuedBytes += bytes) > 256 * 1024) { fail(1008, "terminal input overflow"); return; }
    chain = chain.then(async () => {
      if (stopped) return;
      if (typeof value !== "string") {
        if (!terminal) { fail(1008, "terminal not attached"); return; }
        terminal.input(value); return;
      }
      let body: Record<string, unknown>;
      try { body = JSON.parse(value); } catch { fail(1008, "invalid terminal command"); return; }
      if (!body || typeof body !== "object" || Array.isArray(body) || !dimensions(body)) { fail(1008, "invalid terminal command"); return; }
      if (body.type === "attach") {
        if (attaching || Object.keys(body).some(key => !["type", "target", "cols", "rows"].includes(key)) || typeof body.target !== "string" || !body.target || Buffer.byteLength(body.target) > 1024) { fail(1008, "invalid terminal attach"); return; }
        attaching = true;
        terminal = await backend.openTerminal(body.target, Number(body.cols), Number(body.rows), output => {
          if (!attached) { attached = true; clearTimeout(attachTimer); if (!write(JSON.stringify({ type: "attached" }))) return; }
          if (output.length) write(output);
        }, ws.data.controller.signal);
        if (stopped) { terminal.close(); return; }
        void terminal.done.then(() => { if (!stopped) { write(JSON.stringify({ type: "detached" })); fail(1000, "terminal detached"); } });
      } else if (body.type === "resize" && terminal && Object.keys(body).every(key => ["type", "cols", "rows"].includes(key))) {
        terminal.resize(Number(body.cols), Number(body.rows));
      } else fail(1008, "invalid terminal command");
    }).catch(() => fail(1011, "terminal unavailable")).finally(() => { pending--; queuedBytes -= bytes; });
  } };
}
