import type { Session } from "./types.ts";

// Compatibility projection from observed Herdr status, never a real tool hook.
export function createObservedFeed() {
  type Event = { timestamp: string; ts: number; oracle: string; project: string; sessionId: string; host: string; event: string; source: string; observedState: string; target: string; message: string };
  let sequence = 0;
  let events: Array<{ id: number; event: Event }> = [];
  let states = new Map<string, { status: string; name: string; emitted: number }>();
  const prune = (now: number) => { events = events.filter(item => now - item.event.ts < 60_000).slice(-100); };
  return {
    observe(sessions: Session[], now = Date.now()) {
      const windows = sessions.flatMap(session => session.windows.map(window => ({ session, window, target: `${session.name}:${window.index}` })));
      const names = new Map<string, { count: number; target: string }>();
      for (const item of windows) {
        const key = item.window.name.toLowerCase();
        const previous = names.get(key);
        names.set(key, { count: (previous?.count || 0) + 1, target: item.target });
      }
      const next = new Map<string, { status: string; name: string; emitted: number }>();
      const safe = new Set<string>();
      for (const item of windows) {
        const { window, session, target } = item;
        if (!window.agent?.trim() || !["working", "blocked", "done", "idle"].includes(window.status || "") || !window.name || window.name.length > 1024 || session.name.length > 1024 || next.size >= 1000) continue;
        const oracle = window.name.toLowerCase();
        const worktree = session.name.match(/[.-]wt-(?:\d+-)?(.+)$/);
        const preferred = worktree ? `${window.name}-${worktree[1]}`.toLowerCase() : oracle.endsWith("-oracle") ? oracle : `${oracle}-oracle`;
        let match = names.get(preferred);
        if (!worktree && !match) match = names.get(oracle);
        if (!match || match.count !== 1 || match.target !== target) continue;
        safe.add(target);
        const previous = states.get(target);
        if (!previous || previous.status !== window.status || previous.name !== window.name || (window.status === "working" && now - previous.emitted >= 10_000)) {
          const event: Event = { timestamp: new Date(now).toISOString(), ts: now, oracle: window.name, project: session.name, sessionId: "", host: "local", event: window.status === "working" ? "PreToolUse" : "Stop", source: "herdr-agent-status", observedState: window.status!, target, message: `Herdr observed ${window.status}; status projection, not a tool hook` };
          events.push({ id: ++sequence, event });
          next.set(target, { status: window.status!, name: window.name, emitted: now });
        } else next.set(target, previous);
      }
      states = next;
      // Never replay an old identity onto a removed, renamed, or ambiguous pane.
      events = events.filter(item => safe.has(item.event.target) && next.get(item.event.target)?.name === item.event.oracle);
      prune(now);
    },
    read(cursor = 0, now = Date.now()) {
      prune(now);
      return { cursor: sequence, events: events.filter(item => item.id > cursor).map(item => item.event) };
    },
  };
}
