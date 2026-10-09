import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.stubEnv('PURPLEMUX_MCP_ALLOW_WRITES', '0'));
afterEach(() => vi.unstubAllEnvs());

// The protocol tests never read a user's workspaces or start Codex.
vi.mock('@/lib/mcp-bridge-data', () => ({
  listBridgeHosts: vi.fn(async () => ({ hosts: [{ id: 'local', name: 'test', kind: 'local' }] })),
  listBridgeWorkspaces: vi.fn(async () => ({ workspaces: [], activeWorkspaceId: null })),
  listBridgeCodexTabs: vi.fn(async () => ({ tabs: [], truncated: false })),
  getBridgeCodexStatus: vi.fn(async () => ({ status: 'not_loaded' })),
}));

vi.mock('@/lib/mcp-internal-client', () => ({
  callMcpRuntime: vi.fn(async (operation: string) => {
    if (operation === 'start_codex_task') return { taskId: 'abcd1234', status: 'queued' };
    if (operation === 'get_codex_task') return { taskId: 'abcd1234', status: 'completed' };
    return { tabs: [] };
  }),
}));

import { dispatchMcpRequest } from '@/lib/mcp-bridge';

describe('Purplemux read-only MCP bridge', () => {
  it('negotiates the legacy MCP initialization', async () => {
    const response = await dispatchMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    expect(response?.result).toMatchObject({
      protocolVersion: '2025-11-25',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'purplemux-readonly' },
    });
  });

  it('supports 2026-era server discovery', async () => {
    const response = await dispatchMcpRequest({
      jsonrpc: '2.0', id: 'discovery', method: 'server/discover',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    });
    expect(response?.result).toMatchObject({
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
    });
  });

  it('only advertises read-only tools', async () => {
    const response = await dispatchMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const result = response?.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
    expect(result.tools.map((tool) => tool.name)).toEqual([
      'list_hosts', 'list_workspaces', 'list_codex_tabs', 'get_codex_status',
      'get_codex_task', 'list_codex_tasks',
    ]);
    expect(result.tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
    expect(result.tools.some((tool) => tool.name.includes('send') || tool.name.includes('exec'))).toBe(false);
  });

  it('returns structured output for a read-only tool call', async () => {
    const response = await dispatchMcpRequest({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_hosts', arguments: {} },
    });
    expect(response?.result).toMatchObject({
      structuredContent: { hosts: [{ id: 'local' }] },
      isError: false,
    });
  });

  it('rejects unknown methods and tool calls', async () => {
    const unknown = await dispatchMcpRequest({ jsonrpc: '2.0', id: 4, method: 'system/exec' });
    expect(unknown?.error?.code).toBe(-32601);
    const tool = await dispatchMcpRequest({
      jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'send_codex_task', arguments: {} },
    });
    expect(tool?.error?.code).toBe(-32602);
  });

  it('adds mandatory resultType for modern tools/list and tools/call', async () => {
    const metadata = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const list = await dispatchMcpRequest({
      jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: metadata },
    }, '2026-07-28');
    expect(list?.result).toMatchObject({ resultType: 'complete', tools: expect.any(Array) });
    const call = await dispatchMcpRequest({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { _meta: metadata, name: 'list_hosts', arguments: {} },
    }, '2026-07-28');
    expect(call?.result).toMatchObject({ resultType: 'complete', isError: false });
  });

  it('rejects contradictory HTTP and JSON-RPC protocol versions', async () => {
    const response = await dispatchMcpRequest({
      jsonrpc: '2.0', id: 9, method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } },
    }, '2026-07-28');
    expect(response?.error?.code).toBe(-32600);
  });

  it('advertises mutation tools only when explicitly enabled', async () => {
    vi.stubEnv('PURPLEMUX_MCP_ALLOW_WRITES', '1');
    const response = await dispatchMcpRequest({ jsonrpc: '2.0', id: 31, method: 'tools/list' });
    const result = response?.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
    expect(result.tools.slice(-3).map((tool) => tool.name)).toEqual([
      'start_codex_task', 'interrupt_codex_task', 'respond_codex_approval',
    ]);
    expect(result.tools.slice(-3).every((tool) => !tool.annotations.readOnlyHint)).toBe(true);
  });

  it('describes workspace-write opt-in and defaults to read-only for task submission', async () => {
    vi.stubEnv('PURPLEMUX_MCP_ALLOW_WRITES', '1');
    const response = await dispatchMcpRequest({ jsonrpc: '2.0', id: 40, method: 'tools/list' });
    const tool = (response?.result as { tools: { name: string; inputSchema: {
      properties: Record<string, { default?: string | boolean; enum?: string[] }>;
    } }[] }).tools.find((entry) => entry.name === 'start_codex_task');
    expect(tool?.inputSchema.properties.sandboxMode).toMatchObject({
      default: 'read-only', enum: ['read-only', 'workspace-write'],
    });
    expect(tool?.inputSchema.properties.confirmWriteAccess).toMatchObject({ default: false });
  });

  it('rejects mutation attempts even when an unlisted tool is invoked', async () => {
    vi.stubEnv('PURPLEMUX_MCP_ALLOW_WRITES', '0');
    const result = await dispatchMcpRequest({
      jsonrpc: '2.0', id: 32, method: 'tools/call',
      params: { name: 'start_codex_task', arguments: { workspaceId: 'test' } },
    });
    expect(result?.error?.code).toBe(-32602);
  });

  it('routes explicitly enabled writes to the private runtime, not through shell', async () => {
    vi.stubEnv('PURPLEMUX_MCP_ALLOW_WRITES', '1');
    const result = await dispatchMcpRequest({
      jsonrpc: '2.0', id: 33, method: 'tools/call',
      params: { name: 'start_codex_task', arguments: { workspaceId: 'ws-test' } },
    });
    expect(result?.result).toMatchObject({
      structuredContent: { taskId: 'abcd1234', status: 'queued' },
      isError: false,
    });
  });

  it('does not respond to client notifications', async () => {
    const response = await dispatchMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(response).toBeNull();
  });

  it('returns supported versions for unknown versions', async () => {
    const response = await dispatchMcpRequest({
      jsonrpc: '2.0', id: 6, method: 'tools/list',
    }, '2030-01-01');
    expect(response?.error).toMatchObject({
      code: -32022,
      data: { supported: ['2026-07-28', '2025-11-25'] },
    });
  });
});
