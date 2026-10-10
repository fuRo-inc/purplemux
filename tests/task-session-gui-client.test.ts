import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskSessionGuiClient } from '@/lib/task-session-gui-client';

afterEach(() => { vi.unstubAllGlobals(); });
describe('Task Session browser response handling', () => {
  it.each([413, 502])('shows an HTTP error for a non-JSON %s body without exposing it', async (status) => {
    const fetch = vi.fn(async () => new Response('<html>internal details</html>', { status }));
    vi.stubGlobal('fetch', fetch);
    await expect(new TaskSessionGuiClient(vi.fn()).request('/api/task-sessions', {})).rejects.toThrow('HTTP ' + status);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves a JSON API error and does not retry a failed mutation', async () => {
    const fetch = vi.fn(async () => Response.json({ error: 'Task session status changed' }, { status: 409 }));
    vi.stubGlobal('fetch', fetch);
    await expect(new TaskSessionGuiClient(vi.fn()).request('/api/task-sessions/id', {})).rejects.toThrow('status changed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('clears CSRF and disables mutations when recovery fails, with no POST replay', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ csrfToken: 'old' }))
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    const onCsrf = vi.fn(); const client = new TaskSessionGuiClient(onCsrf);
    await client.request('/api/task-sessions');
    await expect(client.request('/api/task-sessions/id', {})).rejects.toThrow('更新に失敗');
    expect(onCsrf).toHaveBeenLastCalledWith('');
    expect(fetch.mock.calls.map((c) => c[1].method || 'GET')).toEqual(['GET', 'POST', 'GET']);
  });
  it('handles malformed successful responses without a parser exception or retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json')));
    await expect(new TaskSessionGuiClient(vi.fn()).request('/api/task-sessions')).rejects.toThrow('応答を読み取れません');
  });
});
