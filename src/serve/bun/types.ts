import type { createFederation } from './mod.createFederation.ts';
import type { createObservedFeed } from "./mod.createObservedFeed.ts";
export interface Window { index: number; name: string; active: boolean; cwd?: string; status?: string; agent?: string }
export interface Session { name: string; windows: Window[]; source: string }
export interface Backend {
  federation: ReturnType<typeof createFederation>;
  teamInventory(): { teams: Array<Record<string, unknown>>; total: number };
  observedFeed: ReturnType<typeof createObservedFeed>;
  dashboardSessions(signal?: AbortSignal): Promise<Session[]>;
  sessions(signal?: AbortSignal): Promise<Session[]>;
  capture(target: string, lines: number, signal?: AbortSignal): Promise<string>;
  captureBatch(targets: Record<string, number>, signal?: AbortSignal): Promise<Record<string, string>>;
  wake(target: string, signal?: AbortSignal): Promise<"ready" | "already-awake">;
  sendLiteral(target: string, text: string, enter: boolean, signal?: AbortSignal): Promise<void>;
  send(target: string, text: string, signal?: AbortSignal): Promise<void>;
  openTerminal(target: string, cols: number, rows: number, output: (bytes: Buffer) => void, signal: AbortSignal): Promise<Terminal>;
  close?(): Promise<void>;
}
export class BackendError extends Error {
  constructor(public readonly code: "target_not_found" | "target_not_agent" | "backend_error", message: string) {
    super(message);
    this.name = "BackendError";
  }
}
export type RunHerdr = (args: string[], signal: AbortSignal) => Promise<string>;
export interface Pane { id: string; workspace: string; agent: string; label: string; title: string; cwd: string; focused: boolean; status: string }
export interface Target { session: string; pane: Pane }
export interface Roster { sessions: Session[]; targets: Map<string, Target> }

export interface Terminal { input(bytes: Buffer): void; resize(cols: number, rows: number): void; close(): void; done: Promise<void> }
