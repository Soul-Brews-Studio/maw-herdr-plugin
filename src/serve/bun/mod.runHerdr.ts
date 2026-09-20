import { spawn } from "node:child_process";
import { BackendError } from "./types.ts";

// No shell, inherited terminal input, or stderr content enters the response.
export function runHerdr(binary: string, args: string[], signal: AbortSignal, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new BackendError("backend_error", "herdr operation aborted")); return; }
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], env, detached: process.platform !== "win32" });
    const chunks: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0;
    let failure: Error | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* Process may have already exited. */ }
    };
    const fail = (message: string) => {
      failure ??= new BackendError("backend_error", message);
      kill();
    };
    const abort = () => fail("herdr operation aborted");
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => fail("herdr command timed out"), 10_000);
    child.stdout.on("data", (data: Buffer) => {
      stdoutBytes += data.length;
      if (stdoutBytes > 4 * 1024 * 1024) fail("herdr output exceeds limit");
      else if (!failure) chunks.push(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrBytes > 64 * 1024) fail("herdr stderr exceeds limit");
    });
    child.on("error", () => { failure ??= new BackendError("backend_error", "herdr command failed"); });
    child.on("exit", () => {
      // Bound inherited pipe lifetimes if a subprocess leaves descendants behind.
      drainTimer = setTimeout(() => {
        fail("herdr output pipes did not close");
        child.stdout.destroy();
        child.stderr.destroy();
      }, 1000);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(drainTimer);
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new BackendError("backend_error", "herdr command failed"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    if (signal.aborted) abort();
  });
}
