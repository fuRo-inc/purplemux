/**
 * Purplemux MCP Bridge (read-only phase).
 *
 * Streamable HTTP JSON-RPC on 127.0.0.1 ONLY. No additional dependencies,
 * no shell/file mutation tools, and no access to this endpoint via the main
 * browser-facing Purplemux port.
 *
 * The stdio shim is the only intended client. It authenticates with a local
 * 0600 bearer token; tunnel-client runs the shim instead of forwarding TCP.
 *
 * Supports MCP 2025-11-25 initialize and MCP 2026-07-28 server/discover.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listBridgeHosts, listBridgeWorkspaces } from '@/lib/mcp-bridge-data';
import { callMcpRuntime } from '@/lib/mcp-internal-client';

const PORT_DEFAULT = 18223;
const MAX_BODY_BYTES = 64 * 1024;
const PROTOCOL_LEGACY = '2025-11-25';
const PROTOCOL_MODERN = '2026-07-28';
const SUPPORTED_VERSIONS = [PROTOCOL_MODERN, PROTOCOL_LEGACY];
const TOKEN_DIR = path.join(os.homedir(), '.purplemux');
export const MCP_TOKEN_FILE = path.join(TOKEN_DIR, 'mcp-bridge-token');

type RpcId = string | number | null;
type JsonObject = Record<string, unknown>;
type RpcReply = { jsonrpc: '2.0'; id: RpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } };
type RpcRequest = { jsonrpc: '2.0'; id?: RpcId; method: string; params?: JsonObject };
const asObject = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};

const tools = [
  {
    name: 'list_hosts',
    title: 'List Purplemux hosts',
    description: 'List the local NUC and configured SSH hosts. Does not initiate SSH connections.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_workspaces',
    title: 'List Purplemux workspaces',
    description: 'List workspaces with their host, working directory and active selection. Optionally filter by hostId.',
    inputSchema: {
      type: 'object',
      properties: { hostId: { type: 'string', description: 'Host ID from list_hosts, or local' } },
      additionalProperties: false,
    },
  },
  {
    name: 'list_codex_tabs',
    title: 'List Codex sessions in Purplemux',
    description: 'List existing Codex Chat and legacy Codex tabs across workspaces. This does not start Codex or SSH.',
    inputSchema: {
      type: 'object',
      properties: { workspaceId: { type: 'string', description: 'Workspace ID from list_workspaces' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_codex_status',
    title: 'Get Codex task status',
    description: 'Read the latest known state of an existing Codex tab. A live status is available only for a loaded App Server Chat. For explicit recent messages, set includeRecentItems=true.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        tabId: { type: 'string' },
        includeRecentItems: { type: 'boolean', default: false },
      },
      required: ['workspaceId', 'tabId'],
      additionalProperties: false,
    },
  },
].map((tool) => ({
  ...tool,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}));

const taskReadTools = [
  {
    name: 'get_codex_task',
    title: 'Read a Codex task and results',
    description: 'Read task status by ID, and optionally bounded final output, recent items, pending approvals, or diff. Does not start Codex or modify files.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        includeOutput: { type: 'boolean', default: false },
        includeDiff: { type: 'boolean', default: false },
      },
      required: ['taskId'], additionalProperties: false,
    },
  },
  {
    name: 'list_codex_tasks',
    title: 'List Codex tasks started through ChatGPT',
    description: 'Read recent queued, running and finished MCP task records. No Codex processes are started.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
  },
].map((tool) => ({
  ...tool,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}));

// Deliberately hidden until the NUC operator opts in via an environment
// variable and restarts Purplemux. ChatGPT tool approvals are also required.
const taskWriteTools = [
  {
    name: 'start_codex_task',
    title: 'Start a Codex task in a verified workspace',
    description: 'Submit work to the specified existing Codex Chat tab. Can modify files inside the workspace. Always verify host and directory against list_codex_tabs. Requires confirmTarget=true. Returns taskId immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        tabId: { type: 'string' },
        expectedHostId: { type: 'string' },
        expectedDirectory: { type: 'string' },
        instruction: { type: 'string', minLength: 1, maxLength: 16000 },
        mode: { type: 'string', enum: ['continue', 'new'], default: 'continue' },
        idempotencyKey: { type: 'string', description: 'Optional unique client key to avoid duplicate task submission on retry.' },
        confirmTarget: { type: 'boolean', description: 'Must be true after verifying the target.' },
      },
      required: ['workspaceId', 'tabId', 'expectedHostId', 'expectedDirectory', 'instruction', 'confirmTarget'],
      additionalProperties: false,
    },
  },
  {
    name: 'interrupt_codex_task',
    title: 'Interrupt an active Codex task',
    description: 'Interrupt only the exact active turn associated with this taskId. Requires explicit confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        confirmInterrupt: { type: 'boolean' },
      },
      required: ['taskId', 'confirmInterrupt'], additionalProperties: false,
    },
  },
  {
    name: 'respond_codex_approval',
    title: 'Respond to a specific Codex approval request',
    description: 'Accept or decline a pending command/file-change approval. First inspect get_codex_task(includeOutput=true) and match the exact requestId and expectedCommand. Accepting can run commands or modify files.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        requestId: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
        expectedCommand: { type: 'string' },
        decision: { type: 'string', enum: ['accept', 'decline'] },
        confirmApproval: { type: 'boolean' },
      },
      required: ['taskId', 'requestId', 'expectedCommand', 'decision', 'confirmApproval'],
      additionalProperties: false,
    },
  },
].map((tool) => ({
  ...tool,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}));
const writesEnabled = (): boolean => process.env.PURPLEMUX_MCP_ALLOW_WRITES === '1';
const allTools = () => [
  ...tools, ...taskReadTools, ...(writesEnabled() ? taskWriteTools : []),
];

const serializeJson = (value: unknown): string => JSON.stringify(value);
const rpcResult = (id: RpcId, result: unknown): RpcReply => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: RpcId, code: number, message: string, data?: unknown): RpcReply => ({
  jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) },
});

const serverInfo = { name: 'purplemux-readonly', version: '0.1.0' };
const instructions = () => writesEnabled()
  ? 'Purplemux development bridge. Read status before targeting a Codex tab, confirm exact host and working directory, then submit a task. File changes and approvals require explicit user review. Always poll taskId for completion.'
  : 'Read-only development status bridge. Task submission, interruption and approvals are disabled until the NUC operator explicitly opts in. Host SSH connectivity may not have been checked.';

export const dispatchMcpRequest = async (body: unknown, protocolVersion?: string): Promise<RpcReply | null> => {
  const req = asObject(body);
  const id: RpcId = typeof req.id === 'number' || typeof req.id === 'string' ? req.id : null;
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string' || req.method.length > 128) {
    return rpcError(id, -32600, 'Invalid JSON-RPC request');
  }
  const version = protocolVersion || (asObject(req.params)._meta
    ? asObject(asObject(req.params)._meta)['io.modelcontextprotocol/protocolVersion']
    : undefined);
  if (typeof version === 'string' && !SUPPORTED_VERSIONS.includes(version)) {
    return rpcError(id, -32022, 'Unsupported MCP protocol version', {
      supported: SUPPORTED_VERSIONS, requested: version,
    });
  }
  const requestMeta = asObject(asObject(req.params)._meta);
  const metaVersion = requestMeta['io.modelcontextprotocol/protocolVersion'];
  if (protocolVersion && typeof metaVersion === 'string' && metaVersion !== protocolVersion) {
    return rpcError(id, -32600, 'MCP protocol version header and request metadata disagree');
  }
  const modern = version === PROTOCOL_MODERN;
  // Modern MCP requires resultType on every successful RPC response.
  // Retain unmodified legacy responses for 2025-era initialize clients.
  const respond = (value: JsonObject): RpcReply =>
    rpcResult(id, modern ? { resultType: 'complete', ...value } : value);
  if (req.method.startsWith('notifications/')) return null;
  const params = asObject(req.params);
  try {
    switch (req.method) {
      case 'server/discover':
        return respond({
          resultType: 'complete',
          supportedVersions: [PROTOCOL_MODERN],
          capabilities: { tools: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
          instructions: instructions(),
        });
      case 'initialize':
        return respond({
          protocolVersion: PROTOCOL_LEGACY,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          instructions: instructions(),
        });
      case 'ping':
        return respond({});
      case 'tools/list':
        return respond({ tools: allTools() });
      case 'tools/call': {
        if (typeof params.name !== 'string') return rpcError(id, -32602, 'Tool name required');
        const args = asObject(params.arguments);
        let data: unknown;
        switch (params.name) {
          case 'list_hosts':
            data = await listBridgeHosts();
            break;
          case 'list_workspaces':
            data = await listBridgeWorkspaces(args.hostId);
            break;
          case 'list_codex_tabs':
            data = await callMcpRuntime('list_codex_tabs', { workspaceId: args.workspaceId });
            break;
          case 'get_codex_status':
            data = await callMcpRuntime('get_codex_status', {
              workspaceId: args.workspaceId,
              tabId: args.tabId,
              includeRecentItems: args.includeRecentItems ?? false,
            });
            break;
          case 'get_codex_task':
            data = await callMcpRuntime('get_codex_task', args);
            break;
          case 'list_codex_tasks':
            data = await callMcpRuntime('list_codex_tasks', args);
            break;
          case 'start_codex_task':
          case 'interrupt_codex_task':
          case 'respond_codex_approval':
            if (!writesEnabled()) return rpcError(id, -32602, 'Write tools are disabled on this host');
            data = await callMcpRuntime(params.name, args);
            break;
          default:
            return rpcError(id, -32602, 'Unknown read-only tool');
        }
        return respond({
          content: [{ type: 'text', text: serializeJson(data) }],
          structuredContent: data,
          isError: false,
        });
      }
      default:
        return rpcError(id, -32601, 'Method not found');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Read-only tool failed';
    return respond({ content: [{ type: 'text', text: message.slice(0, 220) }], isError: true });
  }
};

const jsonResponse = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(serializeJson(value));
};

const getOrCreateToken = async (): Promise<string> => {
  await fs.mkdir(TOKEN_DIR, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(MCP_TOKEN_FILE, randomBytes(32).toString('hex') + '\n', {
      flag: 'wx', mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const token = (await fs.readFile(MCP_TOKEN_FILE, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('MCP token file has an unexpected format');
  return token;
};

const matchesToken = (supplied: string, expected: string) => {
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(supplied), hash(expected));
};

export interface IMcpBridgeHandle {
  port: number;
  shutdown: () => Promise<void>;
}

export const startMcpBridge = async (): Promise<IMcpBridgeHandle> => {
  const expectedToken = await getOrCreateToken();
  const rawPort = process.env.PURPLEMUX_MCP_PORT || String(PORT_DEFAULT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('PURPLEMUX_MCP_PORT must be an unprivileged TCP port');
  }
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // A local HTTP listener is never an authorization bypass: every request
    // must pass the bearer token issued to the stdio proxy.
    if (req.url !== '/mcp') {
      jsonResponse(res, 404, { error: 'Not found' });
      return;
    }
    if (req.headers.origin) {
      jsonResponse(res, 403, { error: 'Browser origins are not allowed' });
      return;
    }
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!matchesToken(token, expectedToken)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="purplemux-readonly"');
      jsonResponse(res, 401, { error: 'Unauthorized' });
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      jsonResponse(res, 405, { error: 'Only MCP POST requests are supported' });
      return;
    }
    if (!(req.headers['content-type'] || '').startsWith('application/json')) {
      jsonResponse(res, 415, { error: 'Content-Type must be application/json' });
      return;
    }
    if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) {
      jsonResponse(res, 413, { error: 'MCP request exceeds size limit' });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > MAX_BODY_BYTES) {
          jsonResponse(res, 413, { error: 'MCP request exceeds size limit' });
          return;
        }
        chunks.push(bytes);
      }
      let request: unknown;
      // Decode once: multibyte UTF-8 characters may span TCP chunks.
      try { request = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
      catch {
        jsonResponse(res, 400, rpcError(null, -32700, 'JSON parse error'));
        return;
      }
      const protocolVersion = req.headers['mcp-protocol-version'];
      const reply = await dispatchMcpRequest(request,
        typeof protocolVersion === 'string' ? protocolVersion : undefined);
      if (!reply) { res.writeHead(202); res.end(); return; }
      const status = reply.error?.code === -32022 ? 400 : 200;
      jsonResponse(res, status, reply);
    } catch {
      if (!res.headersSent) jsonResponse(res, 500, rpcError(null, -32603, 'Internal MCP error'));
      else res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    port,
    shutdown: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
