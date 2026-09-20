export interface ServeConfig {
  worktreeRoot: string;
  hostname: string;
  port: number;
  token: string;
  dataDir: string;
  binary: string;
  wakeEngine: string;
  engine: boolean;
  node: string;
}

export class HTTPError extends Error {
  constructor(public status: number, message: string, public body?: Record<string, unknown>) { super(message); }
}
