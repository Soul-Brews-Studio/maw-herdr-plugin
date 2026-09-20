#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWakeHooks } from "../src/serve/bun/mod.runWakeHooks.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "herdr-wake-hooks-")));
const cwd = process.cwd(), env = { ...process.env };
const config = (...postWake: unknown[]) => ({ hooks: { postWake } });
try {
  process.chdir(dir);
  process.env.WAKE_HOOK_INHERITED = "inherited";
  process.env.MAW_ORACLE = "stale";
  const signal = new AbortController().signal;
  await runWakeHooks(config(null, 42, "  ", '  printf "%s\\n" "$MAW_ORACLE|$MAW_SESSION|$MAW_WINDOW|$WAKE_HOOK_INHERITED" > result  ', "exit 7", "bad\0command", 'printf "%s\\n" "$PWD" >> result', "printf done >> result"), "oracle name", "session name", "window name", signal);
  assert.equal(readFileSync("result", "utf8"), `oracle name|session name|window name|inherited\n${dir}\ndone`);
  for (const value of [{}, { hooks: "invalid" }, { hooks: { postWake: "invalid" } }]) await runWakeHooks(value, "", "", "", signal);
  for (const mode of ["abort", "timeout"]) {
    const controller = new AbortController();
    const started = `${mode}-started`, leaked = `${mode}-leaked`, later = `${mode}-later`;
    const pending = runWakeHooks(config(`touch ${started}; (sleep 0.4; touch ${leaked}) & wait`, `touch ${later}`), "", "", "", controller.signal, mode === "timeout" ? 150 : 10_000);
    const deadline = Date.now() + 3000;
    while (!existsSync(started)) { assert.ok(Date.now() < deadline, "hook did not start"); await Bun.sleep(5); }
    if (mode === "abort") controller.abort();
    await pending;
    await Bun.sleep(500);
    assert.ok(!existsSync(leaked), "child survived cancellation");
    assert.ok(!existsSync(later), "later hook ran after cancellation");
  }
  await runWakeHooks(config("(sleep 0.4; touch background-leak) &"), "", "", "", signal);
  await Bun.sleep(500);
  assert.ok(!existsSync("background-leak"), "background child survived normal exit");
  const controller = new AbortController(); controller.abort();
  await runWakeHooks(config("touch pre-cancelled"), "", "", "", controller.signal);
  assert.ok(!existsSync("pre-cancelled"));
  console.log("PASS wake hooks: order, identities, inherited cwd/env, ignored failures, filtering, cancellation/timeout and descendant cleanup");
} finally {
  process.chdir(cwd);
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  rmSync(dir, { recursive: true, force: true });
}
