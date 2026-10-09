/**
 * Stdio entrypoint for Secure MCP Tunnel.
 *
 * tunnel-client launches this command and exchanges newline-delimited JSON-RPC.
 * It forwards requests to the authenticated 127.0.0.1 Purplemux MCP bridge,
 * avoiding a public MCP URL, a long-lived extra HTTP credential in ChatGPT,
 * or a second process trying to manage the same Codex runtimes.
 *
 * Run: pnpm exec tsx src/mcp-stdio.ts
 */
import readline from 'node:readline';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TOKEN_FILE = path.join(os.homedir(), '.purplemux', 'mcp-bridge-token');
const port = Number(process.env.PURPLEMUX_MCP_PORT || '18223');
const MAX_REQUEST_CHARS = 64 * 1024;

const extractId = (line: string): string | number | null => {
  try {
    const req = JSON.parse(line) as { id?: unknown };
    return typeof req.id === 'string' || typeof req.id === 'number' ? req.id : null;
  } catch {
    return null;
  }
};
const fail = (id: string | number | null, message: string): void => {
  if (id === null) return; // Notifications never receive a JSON-RPC response.
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id, error: { code: -32603, message },
  }) + '\n');
};

const main = async () => {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    process.stderr.write('Invalid PURPLEMUX_MCP_PORT\n');
    process.exitCode = 1;
    return;
  }
  let token: string;
  try {
    token = (await fs.readFile(TOKEN_FILE, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid token');
  } catch {
    process.stderr.write('Purplemux MCP bridge is not enabled or its local token is missing. Start Purplemux with PURPLEMUX_MCP_ENABLED=1.\n');
    process.exitCode = 1;
    return;
  }

  const input = readline.createInterface({ input: process.stdin, terminal: false });
  const inFlight = new Set<Promise<void>>();
  for await (const line of input) {
    if (!line.trim()) continue;
    const id = extractId(line);
    if (line.length > MAX_REQUEST_CHARS) {
      fail(id, 'MCP request too large');
      continue;
    }
    const work = (async () => {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: 'Bearer ' + token,
          },
          body: line,
          signal: AbortSignal.timeout(20000),
        });
        if (response.status === 202 || response.status === 204) return;
        const reply = await response.text();
        if (reply) {
          const parsed = JSON.parse(reply) as Record<string, unknown>;
          if (parsed.jsonrpc === '2.0' && (Object.hasOwn(parsed, 'result') || Object.hasOwn(parsed, 'error'))) {
            process.stdout.write(JSON.stringify(parsed) + '\n');
            return;
          }
        }
        fail(id, 'Unexpected MCP bridge response (HTTP ' + response.status + ')');
      } catch {
        fail(id, 'Cannot reach Purplemux MCP bridge on local loopback');
      }
    })();
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  }
  await Promise.allSettled([...inFlight]);
};

void main().catch(() => {
  process.stderr.write('Purplemux MCP stdio proxy failed\n');
  process.exitCode = 1;
});
