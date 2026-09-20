import { spawn } from "node:child_process";
import { BackendError, type Target, type Terminal } from "./types.ts";

// This controls an existing pane; no takeover, shell, or daemon lifecycle commands.
export function openHerdrTerminal(binary: string, target: Target, cols: number, rows: number, output: (bytes: Buffer) => void, signal: AbortSignal): Terminal {
  if (signal.aborted) throw new BackendError("backend_error", "terminal aborted");
  const child = spawn(binary, ["--session", target.session, "terminal", "session", "control", target.pane.id, "--cols", String(cols), "--rows", String(rows)], { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  let stopped = false, buffer = Buffer.alloc(0), stderrBytes = 0, first = true;
  let epoch = Date.now(), outputBytes = 0, inputBytes = 0;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already gone. */ }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  };
  const close = () => {
    if (stopped) return;
    stopped = true; clearTimeout(startTimer); buffer = Buffer.alloc(0);
    // EOF is Herdr detach; never kill the pane or stop its daemon.
    child.stdin.end();
    cleanupTimer = setTimeout(kill, 500);
  };
  const startTimer = setTimeout(close, 10_000);
  const done = new Promise<void>(resolve => {
    child.on("close", () => { stopped = true; clearTimeout(startTimer); clearTimeout(cleanupTimer); signal.removeEventListener("abort", close); buffer = Buffer.alloc(0); resolve(); });
  });
  child.on("error", close); child.stdin.on("error", close);
  child.on("exit", close); // Also bounds descendants retaining the output pipes.
  child.stderr.on("data", (data: Buffer) => { stderrBytes += data.length; if (stderrBytes > 64 * 1024) close(); });
  child.stdout.on("data", (data: Buffer) => {
    if (stopped) return;
    if (Date.now() - epoch >= 1000) { epoch = Date.now(); outputBytes = 0; }
    outputBytes += data.length;
    if (outputBytes > 16 * 1024 * 1024 || buffer.length + data.length > 4 * 1024 * 1024) { close(); return; }
    buffer = Buffer.concat([buffer, data]);
    let newline: number;
    while (!stopped && (newline = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
      try {
        const frame = JSON.parse(line.toString("utf8"));
        if (frame.type === "terminal.closed") { close(); return; }
        if (frame.type !== "terminal.frame" || frame.encoding !== "ansi" || typeof frame.bytes !== "string" || frame.bytes.length % 4) throw new Error("invalid frame");
        const bytes = Buffer.from(frame.bytes, "base64");
        if (bytes.toString("base64") !== frame.bytes || bytes.length > 2 * 1024 * 1024) throw new Error("frame too large");
        if (first) { first = false; clearTimeout(startTimer); }
        output(bytes);
      } catch { close(); }
    }
  });
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();
  const write = (value: unknown) => {
    if (stopped) throw new BackendError("backend_error", "terminal closed");
    const line = JSON.stringify(value) + "\n";
    const bytes = Buffer.byteLength(line);
    if (inputBytes + bytes > 256 * 1024) { close(); throw new BackendError("backend_error", "terminal input overflow"); }
    inputBytes += bytes;
    child.stdin.write(line, error => { inputBytes -= bytes; if (error) close(); });
  };
  return { close, done,
    input(bytes) { write({ type: "terminal.input", bytes: bytes.toString("base64") }); },
    resize(cols, rows) { write({ type: "terminal.resize", cols, rows }); },
  };
}
