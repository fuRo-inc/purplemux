import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskSession } from '@/types/task-session';

// Exercise the page's handlers/effects in Node without a browser or production server.
const hooks = vi.hoisted(() => {
  type Slot = { value?: unknown; deps?: unknown[]; cleanup?: () => void };
  const slots: Slot[] = [];
  const pending: (() => void)[] = [];
  let index = 0;
  const changed = (a?: unknown[], b?: unknown[]) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  return {
    begin: () => { index = 0; },
    reset: () => { slots.forEach((s) => s.cleanup?.()); slots.length = 0; pending.length = 0; index = 0; },
    runEffects: () => { pending.splice(0).forEach((f) => f()); },
    useState: (initial: unknown) => {
      const slot = slots[index++] ?? (slots[index - 1] = { value: typeof initial === 'function' ? initial() : initial });
      return [slot.value, (value: unknown) => { slot.value = typeof value === 'function' ? value(slot.value) : value; }];
    },
    useRef: (initial: unknown) => {
      const slot = slots[index++] ?? (slots[index - 1] = { value: { current: initial } });
      return slot.value;
    },
    useCallback: (fn: unknown, deps: unknown[]) => {
      const slot = slots[index++] ?? (slots[index - 1] = {});
      if (changed(slot.deps, deps)) { slot.value = fn; slot.deps = deps; }
      return slot.value;
    },
    useEffect: (fn: () => (() => void) | undefined, deps?: unknown[]) => {
      const slot = slots[index++] ?? (slots[index - 1] = {});
      if (changed(slot.deps, deps)) {
        slot.deps = deps;
        pending.push(() => { slot.cleanup?.(); slot.cleanup = fn(); });
      }
    },
  };
});
vi.mock('react', async (importOriginal) => ({ ...await importOriginal<typeof import('react')>(), ...hooks }));
vi.mock('@/lib/require-auth', () => ({ requireAuth: vi.fn() }));
import Page from '@/pages/task-sessions';

type Node = { type: unknown; props: { children?: unknown; onClick?: () => Promise<void> | void; disabled?: boolean } };
let tree: unknown;
let record: TaskSession;
let fetchMock: ReturnType<typeof vi.fn>;
function render() { hooks.begin(); tree = Page(); hooks.runEffects(); }
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as Node; return [node, ...nodes(node.props.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object' && 'props' in value) return text((value as Node).props.children);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
function button(label: string) {
  const found = nodes(tree).find((n) => n.type === 'button' && text(n.props.children).includes(label));
  if (!found) throw new Error('Missing button: ' + label);
  return found;
}
async function settle() { for (let i = 0; i < 8; i++) await new Promise<void>((r) => setImmediate(r)); render(); }
async function select() { button('original purpose').props.onClick?.(); render(); await settle(); }
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  record = { id: 'task-one', purpose: 'original purpose', hostId: 'local', workdir: '/tmp/project', scope: 'GUI',
    status: 'pending', source: 'gui', createdAt: '', updatedAt: '', expiresAt: '' };
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes('?id=')) return Response.json({ record, audit: [] });
    if (url.includes('audit=1')) return Response.json({ audit: [] });
    return Response.json({ records: [record], csrfToken: 'csrf' });
  });
  vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('window', { confirm: vi.fn(() => true) });
  render(); await settle();
});
afterEach(() => { hooks.reset(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('Task Session detail GUI', () => {
  it.each(['expired', 'revoked'] as const)('polls the selected detail and removes buttons after %s', async (status) => {
    await select(); expect(button('リスクを確認して承認').props.disabled).toBe(false);
    record = { ...record, status };
    await vi.advanceTimersByTimeAsync(30000); await settle();
    expect(text(tree)).toContain(status === 'expired' ? '申請詳細 — 期限切れ' : '申請詳細 — 取消済み');
    expect(nodes(tree).some((n) => n.type === 'button' && text(n.props.children) === 'リスクを確認して承認')).toBe(false);
    expect(fetchMock.mock.calls.filter((c) => c[0].includes('?id=task-one'))).toHaveLength(2);
  });
  it('refreshes details after POST failure, preserves the error and blocks duplicate clicks', async () => {
    await select();
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { resolve = r; }));
    const click = button('リスクを確認して承認').props.onClick!;
    const first = click(); const second = click();
    record = { ...record, status: 'revoked' };
    resolve(Response.json({ error: 'status changed' }, { status: 409 }));
    await Promise.all([first, second]); await settle();
    expect(text(tree)).toContain('申請詳細 — 取消済み'); expect(text(tree)).toContain('status changed');
    const posts = fetchMock.mock.calls.filter((c) => c[1].method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1].body)).toEqual({ action: 'approved', confirm: true, expectedStatus: 'pending' });
  });
  it('recovers CSRF after 403 but requires a second confirmed click to post again', async () => {
    await select(); fetchMock.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
    button('取消').props.onClick?.(); await settle();
    expect(text(tree)).toContain('自動再送していません');
    expect(fetchMock.mock.calls.filter((c) => c[1].method === 'POST')).toHaveLength(1);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    button('取消').props.onClick?.(); await settle();
    expect(fetchMock.mock.calls.filter((c) => c[1].method === 'POST')).toHaveLength(2);
    expect(window.confirm).toHaveBeenCalledTimes(2);
  });
  it('respects a cancelled confirmation without posting', async () => {
    await select(); vi.mocked(window.confirm).mockReturnValue(false);
    await button('取消').props.onClick?.();
    expect(fetchMock.mock.calls.some((c) => c[1].method === 'POST')).toBe(false);
  });
  it('hides stale details on read failure and resumes polling', async () => {
    await select(); fetchMock.mockImplementation(async (url: string) => url.includes('?id=')
      ? new Response('upstream error', { status: 502 }) : Response.json({ records: [record], csrfToken: 'csrf', audit: [] }));
    await vi.advanceTimersByTimeAsync(30000); await settle();
    expect(text(tree)).toContain('HTTP 502');
    expect(text(tree)).not.toContain('申請詳細');
    fetchMock.mockImplementation(async () => Response.json({ record: { ...record, status: 'expired' }, records: [], audit: [] }));
    await vi.advanceTimersByTimeAsync(30000); await settle();
    expect(text(tree)).toContain('申請詳細 — 期限切れ');
  });
  it('removes the input form, displays execution risk and confirms Full Access from the GUI', async () => {
    record = { ...record, workspaceId: 'ws', tabId: 'tab', requestedPermissions: 'full-access' };
    await select();
    expect(nodes(tree).some((node) => node.type === 'form')).toBe(false);
    expect(text(tree)).toContain('repo外への操作をOSレベルでは防ぎません');
    expect(text(tree)).toContain('実行権限は未有効');
    button('リスクを確認して承認').props.onClick?.(); await settle();
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST');
    expect(JSON.parse(post![1].body)).toMatchObject({ action: 'approved', fullAccessWarningAccepted: true });
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('全ファイルにアクセス'));
  });
  it('ignores a late detail response after selecting a different record', async () => {
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { resolve = r; }));
    button('original purpose').props.onClick?.(); render();
    record = { ...record, id: 'task-two', purpose: 'second purpose', status: 'revoked' };
    button('更新').props.onClick?.(); await settle();
    button('second purpose').props.onClick?.(); render(); await settle();
    resolve(Response.json({ record: { ...record, id: 'task-one', purpose: 'late old purpose', status: 'pending' }, audit: [] }));
    await settle();
    expect(text(tree)).toContain('申請詳細 — 取消済み');
    expect(text(tree)).not.toContain('late old purpose');
  });
});
