export interface ServeConfig {
  hostname: string;
  port: number;
  token: string;
  dataDir: string;
  binary: string;
  engine: boolean;
  node: string;
}

export class HTTPError extends Error {
  constructor(public status: number, message: string, public body?: Record<string, unknown>) { super(message); }
}
