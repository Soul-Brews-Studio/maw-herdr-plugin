export interface ServeConfig {
  worktreeRoot: string;
  hostname: string;
  port: number;
  token: string;
  dataDir: string;
  binary: string;
  wakeEngine: string;
  explicitWakeEngine?: string;
  engine: boolean;
  node: string;
  agents: Record<string,string>;
  namedPeers?: {name:string;url:string}[];
}

export class HTTPError extends Error {
  constructor(public status: number, message: string, public body?: Record<string, unknown>) { super(message); }
}
