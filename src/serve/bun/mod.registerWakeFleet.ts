import * as fs from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
type FleetWindow = { name: string; repo: string; kind?: string };
const limit = 1048576;
const fail = () => new Error("wake fleet registration failed");
const storage = (s: string) => s.trim().replace(/^github\.com\//, "");
const stem = (s: string) => s.replace(/^[0-9]+-/, "");
const canonical = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
const key = (root: string, repo: string) => {
  repo = storage(repo);
  return repo
    ? canonical(isAbsolute(repo) ? repo : join(root, "github.com", repo))
    : "";
};
const kind = (v: unknown) =>
  typeof v === "string" && ["oracle", "project"].includes(v.trim())
    ? v.trim()
    : undefined;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const slug = (p: string) => {
  const parts = canonical(p).split(sep),
    i = parts.indexOf("github.com");
  return i >= 0 && i + 2 < parts.length
    ? `github.com/${parts[i + 1]}/${parts[i + 2]}`
    : "";
};
function safe(path: string): void {
  if (!isAbsolute(path)) throw fail();
  for (let p = resolve(path); ; p = dirname(p)) {
    try {
      if (fs.lstatSync(p).isSymbolicLink()) throw fail();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw fail();
    }
    if (p === dirname(p)) break;
  }
}
function read(path: string): Record<string, unknown> {
  safe(path);
  if (!fs.lstatSync(path).isFile()) throw fail();
  const fd = fs.openSync(path, "r");
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > limit) throw fail();
    const bytes = Buffer.alloc(limit + 1);
    let n = 0,
      size = 0;
    while (
      size < bytes.length &&
      (n = fs.readSync(fd, bytes, size, bytes.length - size, null)) > 0
    )
      size += n;
    if (size > limit) throw fail();
    const v: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
    );
    if (!object(v)) throw fail();
    return v;
  } finally {
    fs.closeSync(fd);
  }
}
export function collectWakeFleet(
  live: { name: string; cwd: string }[],
  base: string,
  window: string,
  root: string,
): FleetWindow[] {
  const out: FleetWindow[] = [],
    seen = new Set<string>();
  for (const item of live) {
    const repo = slug(item.cwd),
      name = item.name || "main";
    if (!repo || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      repo,
      kind: name.trim().endsWith("-oracle") ? "oracle" : "project",
    });
  }
  const repo = slug(base);
  if (repo) {
    let oracle = basename(base).endsWith("-oracle");
    try {
      oracle ||=
        fs.statSync(join(base, "ψ")).isDirectory() &&
        fs.statSync(join(base, "CLAUDE.md")).isFile();
    } catch {}
    const type = oracle ? "oracle" : "project";
    let found = false;
    for (const item of out) {
      if (item.name === window) {
        item.repo = repo;
        item.kind = type;
        found = true;
      } else if (key(root, item.repo) === key(root, repo)) item.kind = type;
    }
    if (!found) out.push({ name: window, repo, kind: type });
  }
  return out;
}
export function mergeWakeFleet(
  existing: unknown,
  updates: FleetWindow[],
  root: string,
): FleetWindow[] {
  const out: FleetWindow[] = [];
  if (Array.isArray(existing))
    for (const item of existing) {
      if (!object(item) || typeof item.name !== "string" || !item.name.trim())
        continue;
      out.push({
        name: item.name,
        repo: storage(typeof item.repo === "string" ? item.repo : ""),
        kind: kind(item.kind),
      });
    }
  const counts = (items: FleetWindow[]) => {
    const c = new Map<string, number>();
    for (const w of items)
      if (w.name.trim()) {
        const k = key(root, w.repo);
        c.set(k, (c.get(k) ?? 0) + 1);
      }
    return c;
  };
  const old = counts(out),
    next = counts(updates);
  for (const item of updates) {
    if (!item.name.trim()) continue;
    const update = { ...item, repo: storage(item.repo) },
      k = key(root, update.repo),
      exact = out.find((w) => w.name === update.name);
    if (exact) {
      exact.repo = update.repo;
      if (update.kind) exact.kind = update.kind;
      continue;
    }
    const alias =
      old.get(k) === 1 && next.get(k) === 1
        ? out.findIndex((w) => key(root, w.repo) === k)
        : -1;
    if (alias >= 0) out[alias] = update;
    else out.push(update);
  }
  return out;
}
function dirs(home: string): string[] {
  const e = process.env,
    legacy = join(home, ".maw"),
    xdg = ["1", "true", "yes", "on"].includes((e.MAW_XDG ?? "").toLowerCase());
  const state =
    e.MAW_HOME ??
    e.MAW_STATE_DIR ??
    (xdg
      ? join(
          isAbsolute(e.XDG_STATE_HOME ?? "")
            ? e.XDG_STATE_HOME!
            : join(home, ".local", "state"),
          "maw",
        )
      : legacy);
  const config =
    e.MAW_HOME !== undefined
      ? join(e.MAW_HOME, "config")
      : (e.MAW_CONFIG_DIR ??
        join(
          isAbsolute(e.XDG_CONFIG_HOME ?? "")
            ? e.XDG_CONFIG_HOME!
            : join(home, ".config"),
          "maw",
        ));
  return [...new Set([state, legacy, config].map((p) => join(p, "fleet")))];
}
export function registerWakeFleet(
  session: string,
  live: { name: string; cwd: string }[],
  basePath: string,
  window: string,
): void {
  if (
    !session ||
    Buffer.byteLength(session) > 255 ||
    session.trim() !== session ||
    /^[-]|[\/\\\p{Cc}]/u.test(session) ||
    [".", ".."].includes(session) ||
    live.length > 1024
  )
    throw fail();
  const home = process.env.HOME ?? "";
  if (!isAbsolute(home)) throw fail();
  let root = process.env.GHQ_ROOT;
  if (root === undefined) {
    const result = spawnSync("git", ["config", "--get", "ghq.root"], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 65536,
    });
    root = result.status === 0 ? result.stdout.trim() : "";
    if (root.startsWith("~/")) root = join(home, root.slice(2));
    if (!root) root = join(home, "Code");
  }
  if (basename(root) === "github.com") root = dirname(root);
  const updates = collectWakeFleet(live, basePath, window, root);
  if (!updates.length) return;
  const entries: {
      path: string;
      name: string;
      value: Record<string, unknown>;
    }[] = [],
    seen = new Set<string>();
  let count = 0,
    aggregate = 0;
  for (const dir of dirs(home)) {
    safe(dir);
    let files: string[];
    try {
      const handle = fs.opendirSync(dir);
      files = [];
      try {
        let item;
        while ((item = handle.readSync())) {
          if (++count > 1024) throw fail();
          files.push(item.name);
        }
      } finally {
        handle.closeSync();
      }
      files.sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw fail();
    }
    const current = new Set<string>();
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const path = join(dir, file);
      aggregate += fs.lstatSync(path).size;
      if (aggregate > 4 * limit) throw fail();
      const value = read(path),
        name = value.name;
      if (
        typeof name !== "string" ||
        !name ||
        seen.has(name) ||
        "members" in value
      )
        continue;
      entries.push({ path, name, value });
      current.add(name);
    }
    for (const name of current) seen.add(name);
  }
  const keys = new Set(updates.map((w) => key(root!, w.repo))),
    entry =
      entries.find((e) => e.name === session) ??
      entries.find(
        (e) =>
          stem(e.name) === stem(session) &&
          mergeWakeFleet(e.value.windows, [], root!).some((w) =>
            keys.has(key(root!, w.repo)),
          ),
      );
  const target = entry?.path ?? join(home, ".maw", "fleet", `${session}.json`);
  let value = entry?.value;
  if (!value) {
    try {
      value = read(target);
      if ("members" in value) throw fail();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw fail();
      value = {};
    }
  }
  value.name = session;
  value.created_by = "maw wake";
  value.auto_registered = true;
  if (!("created_at" in value)) value.created_at = new Date().toISOString();
  value.windows = mergeWakeFleet(value.windows, updates, root);
  const data = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(data) > limit) throw fail();
  safe(target);
  fs.mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = join(dirname(target), `.wake-fleet-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    safe(target);
    fs.renameSync(temp, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch {}
  }
}
