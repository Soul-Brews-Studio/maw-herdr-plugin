import { BackendError, type Pane, type Roster, type RunHerdr, type Session } from "./types.ts";

function invalid(message: string): never { throw new BackendError("backend_error", message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("invalid herdr JSON object");
  return value as Record<string, unknown>;
}
function unwrap(raw: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { invalid("invalid herdr JSON object"); }
  for (;;) {
    const obj = object(value);
    if (Object.hasOwn(obj, "error") && obj.error !== null) invalid("herdr returned an error");
    if (Object.hasOwn(obj, "result")) value = obj.result;
    else if (Object.hasOwn(obj, "snapshot")) value = obj.snapshot;
    else return obj;
  }
}
// Go's JSON string fields accept null/missing as empty, but reject other types.
function string(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") invalid("invalid herdr string field");
  return value;
}
export async function readRoster(run: RunHerdr, signal: AbortSignal): Promise<Roster> {
  const result: Roster = { runningSessions: [], sessions: [], targets: new Map() };
  const list = unwrap(await run(["session", "list", "--json"], signal));
  if (!Array.isArray(list.sessions)) invalid("invalid herdr session list");
  const seenSessions = new Set<string>();
  for (const item of list.sessions) {
    const server = object(item), serverName = string(server.name);
    if (!serverName || typeof server.running !== "boolean" || seenSessions.has(serverName)) invalid("invalid or duplicate herdr session");
    seenSessions.add(serverName);
    if (!server.running) continue;
    result.runningSessions.push(serverName);
    const snap = unwrap(await run(["--session", serverName, "api", "snapshot"], signal));
    if (snap.protocol !== 22 || !Array.isArray(snap.workspaces) || !Array.isArray(snap.panes)) invalid("invalid herdr protocol-22 snapshot");
    const spaces = new Map<string, Session>();
    const labels = new Map<string,string>();
    for (const item of snap.workspaces) {
      const space = object(item), id = string(space.workspace_id);
      labels.set(id,string(space.label));
      if (!id || spaces.has(id)) invalid("invalid or duplicate workspace");
      const name = Buffer.from(serverName).toString("base64url") + "/" + Buffer.from(id).toString("base64url");
      spaces.set(id, { name, source: "local", windows: [] });
    }
    const seenPanes = new Set<string>();
    for (const item of snap.panes) {
      const p = object(item);
      const pane: Pane = { workspaceLabel: labels.get(string(p.workspace_id)), id: string(p.pane_id), workspace: string(p.workspace_id), agent: string(p.agent), label: string(p.label), title: string(p.title), cwd: string(p.cwd), focused: p.focused as boolean, status: string(p.agent_status) };
      if (!["idle", "working", "blocked", "done", "unknown"].includes(pane.status)) invalid("invalid pane agent status");
      const space = spaces.get(pane.workspace), prefix = pane.workspace + ":p";
      const number = pane.id.slice(prefix.length), n = Number.parseInt(number, 36);
      if (!space || typeof pane.focused !== "boolean" || !pane.id.startsWith(prefix) || !/^[0-9a-z]+$/i.test(number) || !Number.isSafeInteger(n) || n < 0 || seenPanes.has(pane.id)) invalid("invalid or ambiguous pane identity");
      seenPanes.add(pane.id);
      // herdr pane ids count in base 36 (p8, pC, p14). The dashboard, WS and
      // delivery claims name a pane by its decimal window index, so the
      // roster must too: keyed by the raw digits, `:12` would be pane p12 here
      // but pane pC on the dashboard.
      const target = space.name + ":" + n;
      if (result.targets.has(target)) invalid("duplicate pane target");
      space.windows.push({ index: n, name: pane.label || pane.title || pane.agent || pane.id, active: pane.focused, ...(pane.cwd ? { cwd: pane.cwd } : {}), status: pane.status, ...(pane.agent.trim() ? { agent: pane.agent.trim() } : {}) });
      result.targets.set(target, { session: serverName, pane });
    }
    for (const space of spaces.values()) {
      space.windows.sort((a, b) => a.index - b.index);
      result.sessions.push(space);
    }
  }
  result.sessions.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return result;
}
