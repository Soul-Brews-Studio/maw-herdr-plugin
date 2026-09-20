import { createHash } from "node:crypto";
import { BackendError, type Backend, type RunHerdr } from "./types.ts";
import { readRoster } from "./mod.readRoster.ts";
import { openHerdrTerminal } from "./mod.openHerdrTerminal.ts";
import { runHerdr } from "./mod.runHerdr.ts";

export function createHerdrBackend(binary: string, wakeEngine = "claude"): Backend {
  const shutdown = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const waiters: Array<() => void> = [];
  let active = 0, terminals = 0;
  const run: RunHerdr = (args, signal) => runHerdr(binary || "herdr", args, signal);
  async function operation<T>(fn: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
    if (shutdown.signal.aborted || caller?.aborted) throw new BackendError("backend_error", "herdr operation aborted");
    if (active >= 8 && waiters.length >= 64) throw new BackendError("backend_error", "herdr operation queue is full");
    const controller = new AbortController();
    const abort = () => controller.abort();
    shutdown.signal.addEventListener("abort", abort, { once: true });
    caller?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 10_000);
    let acquired = false;
    const task = (async () => {
      try {
        if (active >= 8) {
          await new Promise<void>((resolve, reject) => {
            const ready = () => { controller.signal.removeEventListener("abort", cancelled); resolve(); };
            const cancelled = () => {
              const index = waiters.indexOf(ready);
              if (index >= 0) waiters.splice(index, 1);
              reject(new BackendError("backend_error", "herdr operation aborted"));
            };
            waiters.push(ready);
            controller.signal.addEventListener("abort", cancelled, { once: true });
          });
        } else active++;
        acquired = true;
        if (controller.signal.aborted) throw new BackendError("backend_error", "herdr operation aborted");
        return await fn(controller.signal);
      } finally {
        clearTimeout(timer);
        caller?.removeEventListener("abort", abort);
        shutdown.signal.removeEventListener("abort", abort);
        if (acquired) {
          const next = waiters.shift();
          if (next) next();
          else active--;
        }
      }
    })();
    pending.add(task);
    try { return await task; } finally { pending.delete(task); }
  }
  const backend: Backend = {
    sessions: (signal) => operation(async (s) => (await readRoster(run, s)).sessions, signal),
    async capture(target, lines, signal) {
      const captures = await backend.captureBatch({ [target]: lines }, signal);
      return captures[target];
    },
    async captureBatch(targets, signal) {
      const keys = Object.keys(targets).sort();
      if (keys.length > 64) throw new BackendError("backend_error", "capture batch exceeds 64 targets");
      const requests = new Map<string, number>();
      for (const key of keys) {
        const lines = targets[key];
        if (!Number.isInteger(lines) || lines < 1 || lines > 2000) throw new BackendError("backend_error", "capture lines must be between 1 and 2000");
        requests.set(key, lines);
      }
      return operation(async (s) => {
        const captures: Record<string, string> = Object.create(null);
        if (!keys.length) return captures;
        const roster = await readRoster(run, s);
        for (const key of keys) if (!roster.targets.has(key)) throw new BackendError("target_not_found", "unknown or stale target");
        for (const key of keys) {
          const target = roster.targets.get(key)!;
          captures[key] = await run(["--session", target.session, "pane", "read", target.pane.id, "--source", "visible", "--lines", String(requests.get(key)), "--format", "text"], s);
        }
        if (s.aborted) throw new BackendError("backend_error", "herdr operation aborted");
        return captures;
      }, signal);
    },
    async wake(target, signal) {
      if (!target || Buffer.byteLength(target) > 1024) throw new BackendError("target_not_found", "unknown or stale target");
      return operation(async (s) => {
        const pane = (await readRoster(run, s)).targets.get(target);
        if (!pane) throw new BackendError("target_not_found", "unknown or stale target");
        if (pane.pane.agent.trim()) return "already-awake";
        const name = "maw-" + createHash("sha256").update(pane.pane.id).digest("hex").slice(0, 16);
        const raw = await run(["--session", pane.session, "agent", "start", name, "--kind", wakeEngine, "--pane", pane.pane.id, "--timeout", "8000"], s);
        let response;
        try { response = JSON.parse(raw); } catch { throw new BackendError("backend_error", "invalid agent start response"); }
        const result = response?.result, agent = result?.agent;
        if (!response || typeof response !== "object" || Array.isArray(response) || response.error != null || result?.error != null || result?.type !== "agent_started" || !Array.isArray(result.argv) || !result.argv.every((arg: unknown) => typeof arg === "string") || !agent || agent.pane_id !== pane.pane.id || agent.agent !== wakeEngine || agent.interactive_ready !== true || (agent.launch_pending !== undefined && agent.launch_pending !== false) || s.aborted) throw new BackendError("backend_error", "agent readiness not verified");
        return "ready";
      }, signal);
    },
    async send(target, text, signal) {
      if (!text.trim() || Buffer.byteLength(text, "utf8") > 64 * 1024 || text.includes("\0")) throw new BackendError("backend_error", "invalid prompt text");
      await operation(async (s) => {
        const pane = (await readRoster(run, s)).targets.get(target);
        if (!pane) throw new BackendError("target_not_found", "unknown or stale target");
        if (!pane.pane.agent.trim()) throw new BackendError("target_not_agent", "target is not an agent pane");
        await run(["--session", pane.session, "agent", "prompt", pane.pane.id, text], s);
      }, signal);
    },
    async openTerminal(target, cols, rows, output, signal) {
      if (terminals >= 16) throw new BackendError("backend_error", "terminal capacity reached");
      terminals++;
      try {
        const pane = await operation(async (s) => {
          const found = (await readRoster(run, s)).targets.get(target);
          if (!found) throw new BackendError("target_not_found", "unknown or stale target");
          return found;
        }, signal);
        const terminal = openHerdrTerminal(binary || "herdr", pane, cols, rows, output, AbortSignal.any([signal, shutdown.signal]));
        pending.add(terminal.done);
        void terminal.done.finally(() => { terminals--; pending.delete(terminal.done); });
        return terminal;
      } catch (error) { terminals--; throw error; }
    },
    async close() {
      shutdown.abort();
      await Promise.allSettled([...pending]);
    },
  };
  return backend;
}
