import { spawn } from "node:child_process";

/** Trusted merged operator config and resolved identity only; never browser commands.
 * Best effort, sequential, process cwd/env inherited. Safety deviations from the
 * legacy CLI: closed stdin, 10-second total ceiling, process-group cleanup.
 * Shorter budgets are useful for callers already operating under a deadline.
 */
export async function runWakeHooks(config: Record<string, unknown>, oracle: string, session: string, window: string, signal: AbortSignal, budgetMs = 10_000): Promise<void> {
  const hooks = config.hooks;
  const entries = hooks && typeof hooks === "object" && !Array.isArray(hooks) ? (hooks as Record<string, unknown>).postWake : undefined;
  if (!Array.isArray(entries)) return;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const budget = Number.isFinite(budgetMs) ? Math.max(0, Math.min(10_000, budgetMs)) : 10_000;
  const deadline = performance.now() + budget;
  const timer = setTimeout(abort, budget);
  if (signal.aborted) abort();
  try {
    for (const entry of entries) {
      if (controller.signal.aborted || performance.now() >= deadline) break;
      if (typeof entry !== "string" || !entry.trim()) continue;
      await new Promise<void>((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn("sh", ["-c", entry.trim()], {
            stdio: "ignore", detached: process.platform !== "win32",
            env: { ...process.env, MAW_ORACLE: oracle, MAW_SESSION: session, MAW_WINDOW: window },
          });
        } catch { resolve(); return; }
        const kill = () => {
          try {
            if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch { /* Already gone. */ }
        };
        controller.signal.addEventListener("abort", kill, { once: true });
        child.on("error", () => { /* Spawn/exit failures do not stop later hooks. */ });
        child.on("close", () => {
          kill();
          controller.signal.removeEventListener("abort", kill);
          resolve();
        });
        if (controller.signal.aborted) kill();
      });
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
