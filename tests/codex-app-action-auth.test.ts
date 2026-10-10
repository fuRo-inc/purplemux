import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { signSessionToken } from '@/lib/auth';
import { taskSessionCsrf } from '@/lib/task-session-gui-auth';
import { TaskSessionError, taskSessions } from '@/lib/task-session-store';
import handler from '@/pages/api/codex-app/action';
import csrfHandler from '@/pages/api/codex-app/csrf';

const mocks = vi.hoisted(() => ({ action: vi.fn(), snapshot: vi.fn(), getRuntime: vi.fn() }));
vi.mock('@/lib/codex-app-tab', () => ({ resolveCodexAppTab: vi.fn(async () => ({ workspace: { id: 'ws' }, tab: { id: 'tab' } })) }));
vi.mock('@/lib/codex-app-gui', () => ({ getCodexGuiRuntime: mocks.getRuntime }));
let token: string;
const req = (body: Record<string, unknown> = {}, gui = false) => ({
  method: 'POST', body: { workspaceId: 'ws', tabId: 'tab', action: 'settings', ...body },
  cookies: gui ? { 'session-token': token } : {}, socket: {},
  headers: { host: 'localhost:8022', origin: 'http://localhost:8022', 'content-type': 'application/json',
    'x-pmux-token': 'authenticated-cli-token', ...(gui ? { 'x-task-session-csrf': taskSessionCsrf(token) } : {}) },
}) as unknown as NextApiRequest;
const res = () => {
  const r = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() }; r.status.mockReturnValue(r); r.json.mockReturnValue(r);
  return r as unknown as NextApiResponse & typeof r;
};
beforeEach(async () => {
  vi.stubEnv('NEXTAUTH_SECRET', 'isolated-codex-action-test-secret'); token = await signSessionToken();
  mocks.action.mockResolvedValue({ sandboxMode: 'workspace-write', approvalPolicy: 'on-request' });
  mocks.snapshot.mockReturnValue({ sandboxMode: 'workspace-write', approvalPolicy: 'on-request' });
  mocks.getRuntime.mockResolvedValue({ snapshot: mocks.snapshot, action: mocks.action });
  // No tests access or mutate the application's actual store.
  vi.spyOn(taskSessions, 'withTabAccess').mockImplementation(async (_w, _t, _owner, fn) => fn());
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe('Codex GUI privilege changes', () => {
  it.each([{ sandboxMode: 'danger-full-access' }, { approvalPolicy: 'never' }, { action: 'send', text: 'Build', sandboxMode: 'danger-full-access' }])('rejects CLI elevation %j before creating a runtime', async (body) => {
    const response = res(); await handler(req(body), response);
    expect(response.status).toHaveBeenCalledWith(401); expect(mocks.getRuntime).not.toHaveBeenCalled(); expect(mocks.action).not.toHaveBeenCalled();
  });
  it.each(['read-only', 'workspace-write'])('preserves CLI %s settings and submission', async (sandboxMode) => {
    for (const action of ['settings', 'send']) {
      const response = res(); await handler(req({ action, sandboxMode, approvalPolicy: 'on-request', text: 'Build' }), response);
      expect(response.status).toHaveBeenCalledWith(200);
    }
    expect(mocks.action).toHaveBeenCalledTimes(2);
  });
  it('accepts existing GUI Full Access controls with cookie, same Origin and session CSRF', async () => {
    const response = res(); await handler(req({ sandboxMode: 'danger-full-access', approvalPolicy: 'never' }, true), response);
    expect(response.status).toHaveBeenCalledWith(200); expect(mocks.action).toHaveBeenCalledOnce();
  });
  it.each(['missing-csrf', 'foreign-origin', 'wrong-csrf'])('rejects GUI elevation with %s', async (bad) => {
    const request = req({ sandboxMode: 'danger-full-access' }, true);
    if (bad === 'missing-csrf') delete request.headers['x-task-session-csrf'];
    if (bad === 'foreign-origin') request.headers.origin = 'http://foreign.example';
    if (bad === 'wrong-csrf') request.headers['x-task-session-csrf'] = '0'.repeat(64);
    const response = res(); await handler(request, response);
    expect(response.status).toHaveBeenCalledWith(403); expect(mocks.action).not.toHaveBeenCalled();
  });
  it.each([{ sandboxMode: 'danger-full-access', approvalPolicy: 'on-request' }, { sandboxMode: 'workspace-write', approvalPolicy: 'never' }])('prevents CLI reuse of stored high privilege settings %j', async (state) => {
    mocks.snapshot.mockReturnValue(state);
    const response = res(); await handler(req({ action: 'send', text: 'Build' }), response);
    expect(response.status).toHaveBeenCalledWith(401); expect(mocks.action).not.toHaveBeenCalled();
    const gui = res(); await handler(req({ action: 'send', text: 'Build' }, true), gui);
    expect(gui.status).toHaveBeenCalledWith(200);
  });
  it('requires GUI authentication for leased-task interruption rather than allowing a CLI token', async () => {
    mocks.snapshot.mockReturnValue({ sandboxMode: 'danger-full-access', approvalPolicy: 'never', taskPermissionsActive: true });
    const response = res(); await handler(req({ action: 'interrupt' }), response);
    expect(response.status).toHaveBeenCalledWith(401); expect(mocks.action).not.toHaveBeenCalled();
    const gui = res(); await handler(req({ action: 'interrupt' }, true), gui);
    expect(gui.status).toHaveBeenCalledWith(200);
  });
  it('blocks GUI mutation when another worker has a durable tab lease', async () => {
    vi.mocked(taskSessions.withTabAccess).mockRejectedValue(new TaskSessionError('Tab has an active Task Session lease', 409));
    const response = res(); await handler(req({ action: 'send', text: 'Build' }, true), response);
    expect(response.status).toHaveBeenCalledWith(409); expect(mocks.action).not.toHaveBeenCalled();
  });
  it('issues no-cache CSRF only to the logged-in GUI', async () => {
    const request = req({}, true); request.method = 'GET';
    const response = res(); await csrfHandler(request, response);
    expect(response.json).toHaveBeenCalledWith({ csrfToken: taskSessionCsrf(token) });
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    const cliRequest = req(); cliRequest.method = 'GET'; const cli = res(); await csrfHandler(cliRequest, cli);
    expect(cli.status).toHaveBeenCalledWith(401);
  });
});
