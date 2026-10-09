import { describe, expect, it, vi } from 'vitest';

// The protocol tests never read a user's workspaces or start Codex.
vi.mock('@/lib/mcp-bridge-data', () => ({
  listBridgeHosts: vi.fn(async () => ({ hosts: [{ id: 'local', name: 'test', kind: 'local' }] })),
  listBridgeWorkspaces: vi.fn(async () => ({ workspaces: [], activeWorkspaceId: null })),
  listBridgeCodexTabs: vi.fn(async () => ({ tabs: [], truncated: false })),
  getBridgeCodexStatus: vi.fn(async () => ({ status: 'not_loaded' })),
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
