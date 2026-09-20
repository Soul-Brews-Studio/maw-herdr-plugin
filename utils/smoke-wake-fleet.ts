import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectWakeFleet,
  mergeWakeFleet,
  registerWakeFleet,
} from "../src/serve/bun/mod.registerWakeFleet.ts";
const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "wake-fleet-"))),
  prior = { ...process.env };
try {
  for (const k of [
    "MAW_HOME",
    "MAW_STATE_DIR",
    "MAW_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "MAW_XDG",
  ])
    delete process.env[k];
  process.env.HOME = home;
  process.env.GHQ_ROOT = join(home, "Code");
  const base = join(home, "Code/github.com/o/neo-oracle"),
    dir = join(home, ".maw/fleet");
  fs.mkdirSync(base, { recursive: true });
  registerWakeFleet("s", [], home, "w");
  assert(!fs.existsSync(dir));
  fs.mkdirSync(dir, { recursive: true });
  const target = join(dir, "old.json");
  fs.writeFileSync(
    target,
    JSON.stringify({
      name: "01-neo",
      created_at: null,
      custom: { x: 1 },
      windows: [
        {
          name: "prior",
          repo: "github.com/o/neo-oracle",
          kind: "project",
          extra: true,
        },
      ],
    }),
  );
  registerWakeFleet(
    "02-neo",
    [{ name: "neo-task", cwd: join(base, "agents/task") }],
    base,
    "neo-task",
  );
  const saved = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(saved.name, "02-neo");
  assert.equal(saved.created_at, null);
  assert.deepEqual(saved.custom, { x: 1 });
  assert.deepEqual(saved.windows, [
    { name: "neo-task", repo: "o/neo-oracle", kind: "oracle" },
  ]);
  const old = [
    { name: "old", repo: "github.com/o/r", kind: " oracle ", extra: 1 },
  ];
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        mergeWakeFleet(
          old,
          [{ name: "new", repo: "o/r", kind: "project" }],
          home,
        ),
      ),
    ),
    [{ name: "new", repo: "o/r", kind: "project" }],
  );
  assert.equal(
    mergeWakeFleet(old, [{ name: "old", repo: "o/x" }], home)[0]!.kind,
    "oracle",
  );
  assert.equal(
    mergeWakeFleet(
      old,
      [
        { name: "a", repo: "o/r" },
        { name: "b", repo: "o/r" },
      ],
      home,
    ).length,
    3,
  );
  fs.writeFileSync(target, "broken");
  assert.throws(() => registerWakeFleet("02-neo", [], base, "neo"));
  assert.equal(fs.readFileSync(target, "utf8"), "broken");
  fs.writeFileSync(target, JSON.stringify(saved));
  const state = join(home, "state");
  process.env.MAW_STATE_DIR = state;
  fs.mkdirSync(join(state, "fleet"), { recursive: true });
  const first = join(state, "fleet/first.json");
  fs.writeFileSync(
    first,
    JSON.stringify({ name: "02-neo", custom: "first", windows: [] }),
  );
  registerWakeFleet("02-neo", [], base, "neo");
  assert.equal(
    JSON.parse(fs.readFileSync(first, "utf8")).created_by,
    "maw wake",
  );
  assert.equal(fs.readFileSync(target, "utf8"), JSON.stringify(saved));
  fs.symlinkSync(first, join(state, "fleet/link.json"));
  assert.throws(() => registerWakeFleet("02-neo", [], base, "neo"));
  assert.equal(
    collectWakeFleet(
      [
        { name: "a", cwd: base },
        { name: "b", cwd: base },
      ],
      base,
      "a",
      home,
    ).filter((w) => w.kind === "oracle").length,
    2,
  );
  console.log(
    "wake fleet: collection, aliases, metadata, task base, precedence, malformed and symlink guards PASS",
  );
} finally {
  process.env = prior;
  fs.rmSync(home, { recursive: true, force: true });
}
