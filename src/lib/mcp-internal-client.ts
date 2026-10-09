/**
 * Private MCP -> Next.js runtime RPC. The UI and the Next API must share the
 * same Codex App Server runtime. This is especially important in production,
 * where the Purplemux HTTP proxy and Next standalone run in separate contexts.
 */
type Json = Record<string, unknown>;

export const callMcpRuntime = async (operation: string, args: Json = {}): Promise<unknown> => {
  const token = process.env.__PMUX_MCP_INTERNAL_TOKEN;
  const port = Number(process.env.__PMUX_MCP_INTERNAL_PORT);
  if (!token || !/^[a-f0-9]{64}$/.test(token) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Internal MCP-to-Codex runtime channel is not configured');
  }
  const response = await fetch('http://127.0.0.1:' + port + '/api/mcp-internal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-pmux-mcp-internal': token,
    },
    body: JSON.stringify({ operation, args }),
    signal: AbortSignal.timeout(12000),
    cache: 'no-store',
  });
  const body = await response.json() as { ok?: boolean; data?: unknown; error?: string };
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error || 'MCP-to-Codex runtime request failed (' + response.status + ')');
  }
  return body.data;
};
