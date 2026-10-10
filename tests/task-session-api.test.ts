import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { signSessionToken } from '@/lib/auth';
import { taskSessionCsrf } from '@/lib/task-session-gui-auth';
import { taskSessions } from '@/lib/task-session-store';
import handler from '@/pages/api/task-sessions/index';
import decision from '@/pages/api/task-sessions/[id]';
import { dispatchTaskSessionMcp } from '@/lib/mcp-task-sessions';
import { dispatchMcpRequest } from '@/lib/mcp-bridge';
import internalHandler from '@/pages/api/mcp-internal';
import { submitCodexTask } from '@/lib/mcp-codex-tasks';

vi.mock('@/lib/mcp-codex-tasks', () => ({
  submitCodexTask: vi.fn(), getCodexTask: vi.fn(), listCodexTasks: vi.fn(),
  interruptCodexTask: vi.fn(), respondCodexApproval: vi.fn(),
}));
vi.mock('@/lib/mcp-bridge-data', () => ({ listBridgeHosts: vi.fn(), listBridgeWorkspaces: vi.fn() }));
vi.mock('@/lib/mcp-internal-client', () => ({ callMcpRuntime: vi.fn(async (op, args) => dispatchTaskSessionMcp(op, args)) }));
let token: string;
function req(overrides: Record<string, unknown> = {}) {
  return { method: 'POST', cookies: { 'session-token': token }, headers: {
    origin: 'http://localhost:8022', host: 'localhost:8022', 'content-type': 'application/json',
    'x-task-session-csrf': taskSessionCsrf(token),
  }, socket: {}, query: { id: crypto.randomUUID() }, body: { action: 'approved', confirm: true }, ...overrides } as unknown as NextApiRequest;
}
function res() {
  const r = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  r.status.mockReturnValue(r); r.json.mockReturnValue(r);
  return r as unknown as NextApiResponse & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}
beforeEach(async () => { vi.stubEnv('NEXTAUTH_SECRET', 'isolated-task-session-test-secret'); token = await signSessionToken(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('authenticated GUI management routes', () => {
  it('requires a login cookie even when a CLI or MCP token is supplied', async () => {
    const spy = vi.spyOn(taskSessions, 'decide');
    for (const method of ['GET', 'POST']) {
      const response = res();
      await handler(req({ method, cookies: {}, headers: { 'x-pmux-token': 'cli', authorization: 'Bearer mcp' } }), response);
      expect(response.status).toHaveBeenCalledWith(401);
    }
    const response = res(); await decision(req({ cookies: {} }), response);
    expect(response.status).toHaveBeenCalledWith(401); expect(spy).not.toHaveBeenCalled();
  });
  it('rejects invalid cookies', async () => {
    const response = res(); await decision(req({ cookies: { 'session-token': 'invalid' } }), response);
    expect(response.status).toHaveBeenCalledWith(401);
  });
  it.each([
    { origin: 'http://evil.example' }, { origin: undefined }, { 'x-task-session-csrf': undefined },
    { 'x-task-session-csrf': '0'.repeat(64) }, { 'sec-fetch-site': 'cross-site' },
  ])('rejects missing/cross-origin CSRF proof: %j', async (bad) => {
    const spy = vi.spyOn(taskSessions, 'decide'); const request = req(); Object.assign(request.headers, bad);
    const response = res(); await decision(request, response);
    expect(response.status).toHaveBeenCalledWith(403); expect(spy).not.toHaveBeenCalled();
  });
  it('requires explicit confirmation, JSON and known fields', async () => {
    const spy = vi.spyOn(taskSessions, 'decide');
    for (const body of [{ action: 'approved' }, { action: 'approved', confirm: true, sandboxMode: 'danger-full-access' }]) {
      const response = res(); await decision(req({ body }), response);
      expect(response.status).toHaveBeenCalledWith(400);
    }
    const request = req(); request.headers['content-type'] = 'text/plain';
    const response = res(); await decision(request, response); expect(response.status).toHaveBeenCalledWith(415);
    expect(spy).not.toHaveBeenCalled();
  });
  it('records a GUI decision only after verification', async () => {
    const spy = vi.spyOn(taskSessions, 'decide').mockResolvedValue({ status: 'approved' } as never);
    const request = req(); const response = res(); await decision(request, response);
    expect(response.status).toHaveBeenCalledWith(200); expect(spy).toHaveBeenCalledWith(request.query.id, 'approved');
  });
  it('returns a session-bound CSRF token and no-store list, detail and audit', async () => {
    vi.spyOn(taskSessions, 'list').mockResolvedValue([]);
    vi.spyOn(taskSessions, 'audit').mockResolvedValue([]);
    vi.spyOn(taskSessions, 'detail').mockResolvedValue({ record: {} as never, audit: [] });
    const response = res(); await handler(req({ method: 'GET', query: {} }), response);
    expect(response.json).toHaveBeenCalledWith({ records: [], csrfToken: taskSessionCsrf(token), executionLinked: false });
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    const detail = res(); await handler(req({ method: 'GET' }), detail); expect(detail.status).toHaveBeenCalledWith(200);
    const audit = res(); await handler(req({ method: 'GET', query: { audit: '1' } }), audit); expect(audit.json).toHaveBeenCalledWith({ audit: [] });
  });
  it('does not disclose unexpected exceptions', async () => {
    vi.spyOn(taskSessions, 'list').mockRejectedValue(new Error('password=DO_NOT_DISCLOSE'));
    const response = res(); await handler(req({ method: 'GET', query: {} }), response);
    expect(response.json).toHaveBeenCalledWith({ error: 'Task session storage unavailable' });
  });
});

describe('MCP task-session management boundary', () => {
  it('cannot self-approve via proposal fields, query flags or operation names', async () => {
    const decide = vi.spyOn(taskSessions, 'decide');
    const args = { purpose: 'task', hostId: 'local', workdir: '/tmp/project', scope: 'management only',
      expiresAt: new Date(Date.now() + 3600000).toISOString(), idempotencyKey: 'retry', approved: true };
    await expect(dispatchTaskSessionMcp('propose_task_session', args)).rejects.toThrow('Invalid task session input');
    await expect(dispatchTaskSessionMcp('approve_task_session', {})).rejects.toThrow('Unsupported');
    await expect(dispatchTaskSessionMcp('list_task_sessions', { approve: true })).rejects.toThrow('Invalid');
    await expect(dispatchTaskSessionMcp('get_task_session', { taskId: crypto.randomUUID(), approve: true })).rejects.toThrow('Invalid');
    const response = await dispatchMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'approve_task_session', arguments: {} } });
    expect(response?.error?.code).toBe(-32602); expect(decide).not.toHaveBeenCalled();
  });
  it('exposes proposals without enabling existing Codex write tools', async () => {
    vi.stubEnv('PURPLEMUX_MCP_ALLOW_WRITES', '0');
    const response = await dispatchMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = (response?.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain('propose_task_session');
    expect(tools.map((t) => t.name)).not.toContain('start_codex_task');
    expect(tools.map((t) => t.name)).not.toContain('approve_task_session');
  });
});


describe('private MCP runtime route', () => {
  const internal = (overrides: Record<string, unknown> = {}) => req({
    headers: { 'x-pmux-mcp-internal': 'a'.repeat(64) }, socket: { remoteAddress: '127.0.0.1' },
    cookies: {}, body: { operation: 'list_task_sessions', args: {} }, ...overrides,
  });
  beforeEach(() => {
    vi.stubEnv('PURPLEMUX_MCP_ENABLED', '1'); vi.stubEnv('__PMUX_MCP_INTERNAL_TOKEN', 'a'.repeat(64));
    vi.mocked(submitCodexTask).mockClear();
  });
  it('requires enabled MCP, loopback and the private startup token', async () => {
    const list = vi.spyOn(taskSessions, 'list');
    for (const overrides of [{ headers: {} }, { socket: { remoteAddress: '192.0.2.1' } }]) {
      const response = res(); await internalHandler(internal(overrides), response);
      expect(response.status).toHaveBeenCalledWith(403);
    }
    vi.stubEnv('PURPLEMUX_MCP_ENABLED', '0');
    const response = res(); await internalHandler(internal(), response);
    expect(response.status).toHaveBeenCalledWith(403); expect(list).not.toHaveBeenCalled();
  });
  it('records proposals as MCP without starting Codex', async () => {
    const propose = vi.spyOn(taskSessions, 'propose').mockResolvedValue({ status: 'pending' } as never);
    const args = { purpose: 'test', hostId: 'local', workdir: '/tmp/test', scope: 'API only',
      expiresAt: new Date(Date.now() + 3600000).toISOString(), idempotencyKey: 'key' };
    const response = res(); await internalHandler(internal({ body: { operation: 'propose_task_session', args } }), response);
    expect(propose).toHaveBeenCalledWith(args, 'mcp'); expect(response.status).toHaveBeenCalledWith(200);
    expect(submitCodexTask).not.toHaveBeenCalled();
  });
  it('has no approve operation, even with valid internal credentials', async () => {
    const decide = vi.spyOn(taskSessions, 'decide');
    const response = res(); await internalHandler(internal({ body: { operation: 'approve_task_session', args: { confirm: true } } }), response);
    expect(response.status).toHaveBeenCalledWith(400); expect(decide).not.toHaveBeenCalled();
    expect(submitCodexTask).not.toHaveBeenCalled();
  });
});
