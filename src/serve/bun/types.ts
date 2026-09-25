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
  wake(target: string, signal?: AbortSignal, task?: string): Promise<"ready" | "already-awake" | "launched">;
  sendLiteral(target: string, text: string, enter: boolean, signal?: AbortSignal): Promise<void>;
  inbox?(target: string, text: string, serverRoot: string, from: string, signal?: AbortSignal): Promise<string>;
  send(target: string, text: string, signal?: AbortSignal): Promise<SendReceipt>;
  openTerminal(target: string, cols: number, rows: number, output: (bytes: Buffer) => void, signal: AbortSignal): Promise<Terminal>;
  close?(): Promise<void>;
}
/** What was observed after `herdr agent prompt`; never a claim the agent read it. */
export interface SendReceipt { state: "accepted" | "queued" | "delivered"; lastLine: string; evidence: string[] }
export type BackendErrorCode = "target_not_found" | "target_not_agent" | "target_blocked" | "composer_not_empty" | "target_changed" | "backend_error";
export class BackendError extends Error {
  /** hint: a copy-pasteable command with real values that shows or fixes the condition. */
  constructor(public readonly code: BackendErrorCode, message: string, public readonly hint?: string) {
    super(message);
    this.name = "BackendError";
  }
}
export type RunHerdr = (args: string[], signal: AbortSignal) => Promise<string>;
export interface Pane { workspaceLabel?: string; id: string; workspace: string; agent: string; label: string; title: string; cwd: string; focused: boolean; status: string }
export interface Target { session: string; pane: Pane }
export interface Roster { runningSessions: string[]; sessions: Session[]; targets: Map<string, Target> }

export interface Terminal { input(bytes: Buffer): void; resize(cols: number, rows: number): void; close(): void; done: Promise<void> }
