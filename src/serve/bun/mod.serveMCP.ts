import { HTTPError } from './serverTypes.ts';
import { BackendError } from './types.ts';
import { readJSON } from './mod.readJSON.ts';

/**
 * MCP over Streamable HTTP, mounted at /mcp on the dashboard listener by
 * `serve --mcp`. Hand-written because the plugin takes no dependencies: this is
 * JSON-RPC 2.0 over single POSTs, answered with application/json. The server is
 * stateless (no Mcp-Session-Id, no SSE stream), which the transport allows.
 *
 * Every tool is a thin call into an existing HTTP route, so a tool cannot drift
 * from its HTTP twin: same validation, same backend, same result JSON.
 *
 * The auth rule is the one the HTTP API already uses (#61, epic #57):
 *   - read tools follow the mode. Token mode needs the token for everything,
 *     exactly like every other route; --insecure-no-token answers reads.
 *   - write tools need the operator token ALWAYS. Demo mode holds no token, so
 *     there a write tool can never run.
 */

// Newest first. A client asking for one of these gets it echoed back; anything
// else is answered with the newest, and the client decides whether to go on.
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** Implementation-defined JSON-RPC server error meaning "HTTP 401". */
export const MCP_UNAUTHORIZED = -32001;

export type MCPRoute = (path: string, init?: { query?: Record<string, string>; body?: unknown }) => Promise<unknown>;

export interface MCPContext {
  authenticated: boolean;
  insecure: boolean;
  route: MCPRoute;
  signal: AbortSignal;
  /** http://host:port of this listener, for the fix commands. */
  base: string;
  /** Absolute path of the token file in token mode; never its contents. */
  tokenFile?: string;
  binary: string;
  worktreeRoot: string;
}

interface Tool {
  name: string;
  title: string;
  description: string;
  write: boolean;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string; items?: { type: string } }>; required?: string[]; additionalProperties: false };
  call(args: Record<string, unknown>, route: MCPRoute): Promise<unknown>;
}

const TARGET = { type: 'string', description: 'A pane target as listed by herdr_agents: "<session>:<window>", e.g. "bWFpbg/d0Q:4".' };

const TOOLS: Tool[] = [
  {
    name: 'herdr_sessions', title: 'List herdr sessions', write: false,
    description: 'Every herdr workspace this server can see, with its panes (index, name, agent, status, cwd). Same JSON as GET /api/sessions.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: (_args, route) => route('/api/sessions'),
  },
  {
    name: 'herdr_agents', title: 'List agent panes', write: false,
    description: 'Flat list of panes as agents: session, window, oracle name, active/idle. Same JSON as GET /api/agents.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: (_args, route) => route('/api/agents'),
  },
  {
    name: 'herdr_capture', title: 'Read a pane', write: false,
    description: 'The last 200 lines a pane is showing, i.e. what the agent in it is doing now. Same JSON as GET /api/capture?target=.',
    inputSchema: { type: 'object', properties: { target: TARGET }, required: ['target'], additionalProperties: false },
    call: (args, route) => route('/api/capture', { query: { target: args.target as string } }),
  },
  {
    name: 'herdr_worktrees', title: 'List git worktrees', write: false,
    description: 'Git worktrees of the repository the server was started in, including ones with no open pane. Same JSON as GET /api/worktrees.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: (_args, route) => route('/api/worktrees'),
  },
  {
    name: 'herdr_send', title: 'Send a prompt to an agent', write: true,
    description: 'Submit a prompt into an agent pane (or queue it to the ψ inbox with inbox: true). Reports acceptance, not completion; read the reply with herdr_capture. Same as POST /api/send. Requires the operator token, in every mode.',
    inputSchema: { type: 'object', properties: {
      target: TARGET,
      text: { type: 'string', description: 'The prompt. Multi-line text arrives as one prompt.' },
      inbox: { type: 'boolean', description: 'Queue into the target oracle\'s ψ inbox instead of typing into the pane.' },
      attachments: { type: 'array', items: { type: 'string' }, description: 'Lines prepended to the text, one per attachment.' },
    }, required: ['target'], additionalProperties: false },
    call: (args, route) => route('/api/send', { body: args }),
  },
  {
    name: 'herdr_wake', title: 'Wake an agent', write: true,
    description: 'Start the configured agent in an existing pane or registered repository, optionally in a task worktree. Same as POST /api/wake. Requires the operator token, in every mode.',
    inputSchema: { type: 'object', properties: {
      target: { type: 'string', description: 'A pane target or a registered oracle/repository name.' },
      task: { type: 'string', description: 'Optional task slug; wakes into a new or reused worktree for it.' },
    }, required: ['target'], additionalProperties: false },
    call: (args, route) => route('/api/wake', { body: args }),
  },
];

export const MCP_TOOL_NAMES = TOOLS.map(tool => ({ name: tool.name, write: tool.write }));

const INSTRUCTIONS = `maw herdr: the herdr multiplexer's panes and agents on this machine.
Read tools: herdr_sessions, herdr_agents, herdr_capture, herdr_worktrees.
Write tools: herdr_send, herdr_wake. They always require the operator token
(Authorization: Bearer), even when the server runs --insecure-no-token.
herdr_send reports that a prompt was accepted, not that the agent finished;
follow it with herdr_capture to read the reply.`;

type Frame = Record<string, unknown>;
type Reply = { status: number; body: Frame } | null;

const rpcError = (id: unknown, code: number, message: string, data?: Record<string, unknown>): Frame =>
  ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });

function tokenModeFix(context: MCPContext): string {
  const file = context.tokenFile || '~/.maw-herdr-token';
  return `  claude mcp add --transport http herdr ${context.base}/mcp --header "Authorization: Bearer $(cat ${file})"`;
}

function demoWriteFix(context: MCPContext): string {
  const listen = context.base.replace(/^http:\/\//, '');
  return '  test -e ~/.maw-herdr-token || (umask 077; openssl rand -hex 32 > ~/.maw-herdr-token)\n'
    + `  maw herdr serve --mcp --token-file ~/.maw-herdr-token --listen ${listen}`;
}

function toolFix(code: string, args: Record<string, unknown>, context: MCPContext): string {
  switch (code) {
    case 'herdr_unavailable': return `  ${context.binary} workspace list`;
    case 'worktrees_unavailable': return `  git -C ${context.worktreeRoot} worktree list`;
    case 'capture_unavailable': return typeof args.target === 'string' ? `  maw herdr peek ${JSON.stringify(args.target)}` : '  maw herdr ls --agents';
    default: return '  maw herdr ls --agents';
  }
}

function validateArguments(tool: Tool, args: unknown): string | undefined {
  if (args === undefined) args = {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  const properties = tool.inputSchema.properties;
  for (const [key, value] of Object.entries(args)) {
    const schema = properties[key];
    if (!schema) return `unknown argument ${key}`;
    if (value === null) continue;
    if (schema.type === 'array' ? !Array.isArray(value) || value.some(item => typeof item !== 'string') : typeof value !== schema.type) return `argument ${key} must be ${schema.type === 'array' ? 'an array of strings' : 'a ' + schema.type}`;
  }
  for (const key of tool.inputSchema.required ?? []) if (typeof (args as Record<string, unknown>)[key] !== 'string') return `argument ${key} is required`;
  return undefined;
}

async function callTool(id: unknown, params: unknown, context: MCPContext): Promise<Reply> {
  if (!params || typeof params !== 'object' || Array.isArray(params) || typeof (params as Frame).name !== 'string') {
    return { status: 200, body: rpcError(id, -32602, 'tools/call needs params.name\n  list the tools with {"jsonrpc":"2.0","id":1,"method":"tools/list"}') };
  }
  const { name, arguments: rawArgs } = params as { name: string; arguments?: unknown };
  const tool = TOOLS.find(candidate => candidate.name === name);
  if (!tool) return { status: 200, body: rpcError(id, -32602, `unknown tool ${JSON.stringify(name)}; tools: ${TOOLS.map(t => t.name).join(', ')}`) };
  // Auth before argument validation: a refused caller learns nothing else.
  if (tool.write && !context.authenticated) {
    const message = context.insecure
      ? `operator_token_required_for_writes: ${tool.name} writes, and this server runs --insecure-no-token with no token to check\n${demoWriteFix(context)}`
      : `operator_token_required: ${tool.name} needs the operator token\n${tokenModeFix(context)}`;
    return { status: 200, body: rpcError(id, MCP_UNAUTHORIZED, message, { status: 401, error: context.insecure ? 'operator_token_required_for_writes' : 'operator_token_required' }) };
  }
  if (!tool.write && !context.insecure && !context.authenticated) {
    return { status: 200, body: rpcError(id, MCP_UNAUTHORIZED, `operator_token_required\n${tokenModeFix(context)}`, { status: 401, error: 'operator_token_required' }) };
  }
  const invalid = validateArguments(tool, rawArgs);
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  if (invalid) return { status: 200, body: rpcError(id, -32602, `${tool.name}: ${invalid}\n  list the tools with {"jsonrpc":"2.0","id":1,"method":"tools/list"}`) };
  try {
    const value = await tool.call(args, context.route);
    return { status: 200, body: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: false } } };
  } catch (error) {
    // A failed call is a result the model should read, not a transport error.
    let status = 503, code = 'herdr_unavailable', body: Record<string, unknown> | undefined;
    if (error instanceof HTTPError) { status = error.status; code = error.message; body = error.body; }
    else if (error instanceof BackendError && error.code === 'target_not_found') { status = 404; code = 'target_not_found'; }
    else if (error instanceof BackendError && error.code === 'target_not_agent') { status = 409; code = 'target_not_agent'; }
    if (context.signal.aborted) { status = 503; code = 'request_timeout'; }
    const detail = JSON.stringify(body ?? { error: code });
    return { status: 200, body: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error ${status} ${code}: ${detail}\n${toolFix(code, args, context)}` }], isError: true } } };
  }
}

async function handleFrame(frame: unknown, context: MCPContext): Promise<Reply> {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return { status: 400, body: rpcError(null, -32600, 'invalid request: expected a JSON-RPC 2.0 object\n  {"jsonrpc":"2.0","id":1,"method":"tools/list"}') };
  const { jsonrpc, method, params } = frame as Frame;
  const hasId = Object.hasOwn(frame, 'id');
  const id = (frame as Frame).id;
  const validId = typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
  // A client POSTing a response or an error back: accepted, nothing to answer.
  if (method === undefined && jsonrpc === '2.0' && validId && (Object.hasOwn(frame, 'result') || Object.hasOwn(frame, 'error'))) return null;
  if (jsonrpc !== '2.0' || typeof method !== 'string' || (hasId && !validId)) {
    return { status: 400, body: rpcError(validId ? id : null, -32600, 'invalid request: needs jsonrpc "2.0", a string method, and a string or number id\n  {"jsonrpc":"2.0","id":1,"method":"tools/list"}') };
  }
  if (!hasId) return null; // Notification, including notifications/initialized: never answered.
  switch (method) {
    case 'initialize': {
      const requested = params && typeof params === 'object' && !Array.isArray(params) ? (params as Frame).protocolVersion : undefined;
      if (typeof requested !== 'string') return { status: 200, body: rpcError(id, -32602, `initialize needs params.protocolVersion; supported: ${MCP_PROTOCOL_VERSIONS.join(', ')}\n  {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"${MCP_PROTOCOL_VERSIONS[0]}","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}`) };
      const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
      return { status: 200, body: { jsonrpc: '2.0', id, result: { protocolVersion, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'maw-herdr', title: 'maw herdr', version: 'herdr-core-dev' }, instructions: INSTRUCTIONS } } };
    }
    case 'ping': return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
    case 'tools/list': return { status: 200, body: { jsonrpc: '2.0', id, result: { tools: TOOLS.map(tool => ({
      name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
      annotations: { title: tool.title, readOnlyHint: !tool.write, destructiveHint: false, idempotentHint: !tool.write, openWorldHint: false },
    })) } } };
    case 'tools/call': return callTool(id, params, context);
    default: return { status: 200, body: rpcError(id, -32601, `method not found: ${method}; this server offers initialize, ping, tools/list, tools/call\n  {"jsonrpc":"2.0","id":1,"method":"tools/list"}`) };
  }
}

export async function serveMCP(request: Request, context: MCPContext, headers: Headers): Promise<Response> {
  const respond = (body: unknown, status: number) => Response.json(body, { status, headers });
  // Token mode: /mcp is a route like any other, and every route needs the token.
  if (!context.insecure && !context.authenticated) {
    return respond(rpcError(null, MCP_UNAUTHORIZED, `operator_token_required\n${tokenModeFix(context)}`, { status: 401, error: 'operator_token_required' }), 401);
  }
  if (request.method !== 'POST') {
    // No server-initiated SSE stream and no sessions to DELETE: POST only.
    headers.set('Allow', 'POST');
    return respond(rpcError(null, -32600, `method_not_allowed: /mcp takes JSON-RPC over POST\n  curl -s -X POST ${context.base}/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'`), 405);
  }
  const version = request.headers.get('mcp-protocol-version');
  if (version !== null && !MCP_PROTOCOL_VERSIONS.includes(version)) {
    return respond(rpcError(null, -32600, `unsupported MCP-Protocol-Version ${JSON.stringify(version)}; supported: ${MCP_PROTOCOL_VERSIONS.join(', ')}\n  re-run initialize and send the protocolVersion it returns`), 400);
  }
  let payload: unknown;
  try { payload = await readJSON(request, 256 << 10, context.signal); }
  catch (error) {
    if (error instanceof HTTPError && error.status === 400) return respond(rpcError(null, -32700, 'parse error: body is not JSON\n  {"jsonrpc":"2.0","id":1,"method":"tools/list"}'), 400);
    throw error;
  }
  if (Array.isArray(payload)) {
    // Batches were dropped from MCP in 2025-06-18; older clients may still send them.
    if (payload.length === 0 || payload.length > 16) return respond(rpcError(null, -32600, 'invalid request: a batch holds 1..16 frames\n  send one JSON-RPC object per POST'), 400);
    const replies = [];
    for (const frame of payload) { const reply = await handleFrame(frame, context); if (reply) replies.push(reply.body); }
    return replies.length ? respond(replies, 200) : new Response(null, { status: 202, headers });
  }
  const reply = await handleFrame(payload, context);
  return reply ? respond(reply.body, reply.status) : new Response(null, { status: 202, headers });
}
