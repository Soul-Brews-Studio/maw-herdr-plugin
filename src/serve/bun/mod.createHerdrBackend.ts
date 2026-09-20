import { BackendError, type Backend, type RunHerdr } from "./types.ts";
import { readRoster } from "./mod.readRoster.ts";
import { runHerdr } from "./mod.runHerdr.ts";

export function createHerdrBackend(binary: string): Backend {
  const shutdown = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const waiters: Array<() => void> = [];
  let active = 0;
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
    async send(target, text, signal) {
      if (!text.trim() || Buffer.byteLength(text, "utf8") > 64 * 1024 || text.includes("\0")) throw new BackendError("backend_error", "invalid prompt text");
      await operation(async (s) => {
        const pane = (await readRoster(run, s)).targets.get(target);
        if (!pane) throw new BackendError("target_not_found", "unknown or stale target");
        if (!pane.pane.agent.trim()) throw new BackendError("target_not_agent", "target is not an agent pane");
        await run(["--session", pane.session, "agent", "prompt", pane.pane.id, text], s);
      }, signal);
    },
    async close() {
      shutdown.abort();
      await Promise.allSettled([...pending]);
    },
  };
  return backend;
}
