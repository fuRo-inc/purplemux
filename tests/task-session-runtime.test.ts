import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskSessionStore, validateTaskSessionTarget } from '@/lib/task-session-store';
import type { CodexGuiState } from '@/lib/codex-app-gui';

const fixture = vi.hoisted(() => ({ store: undefined as unknown as TaskSessionStore,
  runtime: undefined as unknown as Record<string, unknown>, resolve: vi.fn() }));
vi.mock('@/lib/task-session-store', async (original) => {
  const actual = await original<typeof import('@/lib/task-session-store')>();
  return { ...actual, taskSessions: new Proxy({}, { get: (_t, p) => {
    const member = fixture.store[p as keyof TaskSessionStore];
    return typeof member === 'function' ? member.bind(fixture.store) : member;
  } }) };
});
vi.mock('@/lib/codex-app-tab', () => ({ resolveCodexAppTab: fixture.resolve }));
vi.mock('@/lib/codex-app-gui', () => ({ getCodexGuiRuntime: vi.fn(async () => fixture.runtime), getLoadedCodexGuiRuntime: vi.fn(async () => fixture.runtime) }));
import { dispatchTaskSessionMcp } from '@/lib/mcp-task-sessions';
import { runTaskSessionTurn, finishTaskSession, getTaskSession } from '@/lib/task-session-runtime';

let dir: string;
let id: string;
let live: CodexGuiState;
let listeners: ((state: CodexGuiState) => void)[];
let lost: (() => void) | undefined;
let run: ReturnType<typeof vi.fn>;
const capability = 'A'.repeat(43);
const target = { hostId: 'local', workdir: '/tmp/project', workspaceId: 'ws', tabId: 'tab' };
const tick = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 3)); };
const waitFor = async (predicate: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('Mock coordinator did not settle');
};
const detail = () => fixture.store.detail(id);
const args = (key = 'turn1') => ({ executionCapability: capability, taskId: id, ...target, instruction: 'Build and analyze', idempotencyKey: key });
beforeEach(async () => {
  vi.stubEnv('PURPLEMUX_MCP_ALLOW_WRITES', '1'); vi.stubEnv('PURPLEMUX_MCP_ALLOW_FULL_ACCESS', '1');
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-session-runtime-'));
  fixture.store = new TaskSessionStore(dir, async () => {});
  fixture.resolve.mockResolvedValue({ workspace: { id: 'ws', directories: ['/tmp/project'] }, tab: { id: 'tab', cwd: '/tmp/project' } });
  live = { ready: true, running: true, busy: false, threadId: 'thread', cwd: '/tmp/project', turnId: null,
    lastTurnId: null, lastTurnStatus: null, model: null, effort: null, fastMode: false, sandboxMode: 'read-only', approvalPolicy: 'on-request',
    approvals: [], items: [], models: [], error: null, taskPermissionsActive: false };
  listeners = []; lost = undefined;
  let count = 0;
  run = vi.fn(async (options) => {
    await options.validate(); lost = options.onLost;
    live = { ...live, busy: true, taskPermissionsActive: true, turnId: 'codex-turn' + ++count };
    return { ...live };
  });
  fixture.runtime = { runTaskSessionTurn: run, snapshot: () => ({ ...live }),
    subscribe: (listener: (s: CodexGuiState) => void) => { listeners.push(listener); listener(live); return () => { listeners = listeners.filter((l) => l !== listener); }; },
    finishTaskSession: vi.fn(async () => { live.taskPermissionsActive = false; live.busy = false; lost?.(); }),
    terminate: vi.fn(() => { live.running = false; live.taskPermissionsActive = false; lost?.(); }) };
  const r = await fixture.store.propose({ ...target, purpose: 'Develop runtime', scope: 'Repo only', requestedPermissions: 'full-access', ttl: 3600, idempotencyKey: 'proposal' }, 'mcp', capability);
  id = r.id;
});
afterEach(async () => {
  await finishTaskSession(id, true); await tick(); vi.unstubAllEnvs(); vi.clearAllMocks(); await fs.rm(dir, { recursive: true, force: true });
});
const approve = () => fixture.store.decide(id, 'approved', 'pending', true);
const complete = () => { live.lastTurnId = live.turnId; live.turnId = null; live.lastTurnStatus = 'completed'; live.busy = false; listeners.forEach((l) => l(live)); };

describe('MCP turn coordinator with durable store and mock Codex', () => {
  it('issues a private proposal capability and recovers only with that capability', async () => {
    const proposal = { ...target, purpose: 'New capability task', scope: 'Repo only', requestedPermissions: 'full-access', ttl: 3600, idempotencyKey: 'cap-proposal' };
    const first = await dispatchTaskSessionMcp('propose_task_session', proposal) as { id: string; executionCapability: string };
    expect(first.executionCapability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(dispatchTaskSessionMcp('propose_task_session', proposal)).rejects.toThrow('capability required');
    const recovered = await dispatchTaskSessionMcp('propose_task_session', { ...proposal, executionCapability: first.executionCapability });
    expect(recovered).toMatchObject({ id: first.id, executionCapability: first.executionCapability });
    expect(JSON.stringify(await dispatchTaskSessionMcp('list_task_sessions', {}))).not.toContain(first.executionCapability);
    expect(JSON.stringify(await dispatchTaskSessionMcp('get_task_session', { taskId: first.id }))).not.toContain(first.executionCapability);
  });
  it('requires a private capability for execution, finish/revoke and live output; never passes it to Codex', async () => {
    await approve();
    await expect(dispatchTaskSessionMcp('run_task_session_turn', { ...args(), executionCapability: 'B'.repeat(43) })).rejects.toThrow('capability required');
    await expect(dispatchTaskSessionMcp('finish_task_session', { taskId: id })).rejects.toThrow('Invalid finish');
    await expect(dispatchTaskSessionMcp('finish_task_session', { taskId: id, revoke: true, executionCapability: 'B'.repeat(43) })).rejects.toThrow('capability required');
    await expect(dispatchTaskSessionMcp('get_task_session', { taskId: id, includeOutput: true })).rejects.toThrow('capability required');
    expect(run).not.toHaveBeenCalled(); expect((await detail()).record.status).toBe('approved');
    await dispatchTaskSessionMcp('run_task_session_turn', args());
    await waitFor(async () => !!(await detail()).record.turns?.[0].turnId);
    expect(run.mock.calls[0][0]).not.toHaveProperty('executionCapability');
    expect(JSON.stringify(run.mock.calls[0][0])).not.toContain(capability);
    await dispatchTaskSessionMcp('finish_task_session', { taskId: id, executionCapability: capability });
    expect((await detail()).record.status).toBe('completed');
  });
  it('observes revoke by an independent GUI worker through the owner watch', async () => {
    await approve(); await runTaskSessionTurn(args()); await waitFor(async () => !!(await detail()).record.turns?.[0].turnId);
    const reader = new TaskSessionStore(dir, async () => {}, Date.now, 'gui-other-worker');
    expect((await reader.list())[0].status).toBe('approved');
    await reader.decide(id, 'revoked', 'approved');
    // No runtime notification: exercise the periodic file watch itself.
    await new Promise((r) => setTimeout(r, 1200)); expect(live.taskPermissionsActive).toBe(false);
    expect((await detail()).record.status).toBe('revoked');
  });
  it('rejects an SSH host removed from the registry even if its tab remains configured', async () => {
    fixture.resolve.mockResolvedValueOnce({ workspace: { id: 'ws', hostId: 'removed', remoteDirectory: '/tmp/project' }, tab: { id: 'tab' } });
    const read = vi.spyOn(fs, 'readFile').mockResolvedValueOnce('{"hosts": []}');
    try { await expect(validateTaskSessionTarget('removed', '/tmp/project', 'ws', 'tab')).rejects.toThrow('no longer registered'); }
    finally { read.mockRestore(); }
  });
  it('rejects unapproved and client approval flags without creating a process', async () => {
    await expect(runTaskSessionTurn(args())).rejects.toThrow('GUI-approved');
    await expect(runTaskSessionTurn({ ...args(), confirmFullAccess: true })).rejects.toThrow('Invalid'); expect(run).not.toHaveBeenCalled();
  });
  it('retains an approved lease across two turns, retries exactly once, and then finishes', async () => {
    await approve(); const first = await runTaskSessionTurn(args());
    const duplicate = await runTaskSessionTurn(args()); expect(duplicate).toMatchObject({ existing: true, turn: { id: first.turn.id } });
    await waitFor(async () => !!(await detail()).record.turns?.[0].turnId);
    expect(run).toHaveBeenCalledOnce(); complete();
    await waitFor(async () => (await detail()).record.executionState === 'idle');
    await runTaskSessionTurn(args('turn2'));
    await waitFor(async () => !!(await detail()).record.turns?.[1].turnId);
    expect(run.mock.calls[1][0].pinnedThreadId).toBe('thread'); complete();
    await waitFor(async () => (await detail()).record.executionState === 'idle');
    const record = await finishTaskSession(id);
    expect(record.status).toBe('completed'); expect((await detail()).record.status).toBe('completed');
    expect((await detail()).audit.filter((e) => e.event === 'turn-completed')).toHaveLength(2);
    await expect(runTaskSessionTurn(args('turn3'))).rejects.toThrow('GUI-approved');
    expect(run.mock.calls[0][0].text).toContain('Do not perform unrelated deletion');
  });
  it('returns explicit bounded live assistant output without persisting it', async () => {
    await approve(); await runTaskSessionTurn(args()); await waitFor(async () => !!(await detail()).record.turns?.[0].turnId);
    live.items = [{ id: 'old', type: 'assistant', text: 'unrelated history' }, { id: 'input', type: 'user', text: 'Build' },
      { id: 'command', type: 'command', text: 'DO_NOT_RETURN_STDOUT' }, { id: 'answer', type: 'assistant', text: 'BUILD_RESULT_' + 'x'.repeat(7000) }];
    complete(); await waitFor(async () => (await detail()).record.executionState === 'idle');
    expect(await getTaskSession(id)).not.toHaveProperty('output');
    const result = await getTaskSession(id, true);
    expect('output' in result && result.output?.length).toBe(6000);
    expect(JSON.stringify(result)).not.toContain('DO_NOT_RETURN_STDOUT');
    expect(await fs.readFile(path.join(dir, 'records.json'), 'utf8')).not.toContain('BUILD_RESULT');
    await finishTaskSession(id); expect(await getTaskSession(id, true)).toHaveProperty('output', null);
  });
  it('refuses simultaneous new turns and remembers failed submissions', async () => {
    await approve(); run.mockRejectedValueOnce(new Error('RPC timeout'));
    await runTaskSessionTurn(args());
    await expect(runTaskSessionTurn(args('turn2'))).rejects.toThrow();
    await waitFor(async () => (await detail()).record.status === 'revoked');
    expect(run).toHaveBeenCalledOnce(); await expect(runTaskSessionTurn(args())).rejects.toThrow('GUI-approved');
  });
  it('observes authenticated GUI revoke while running and releases the runtime', async () => {
    await approve(); await runTaskSessionTurn(args()); await waitFor(async () => !!(await detail()).record.turns?.[0].turnId);
    await fixture.store.decide(id, 'revoked', 'approved'); listeners.forEach((l) => l(live));
    await waitFor(async () => !live.taskPermissionsActive);
    expect((await detail()).record.status).toBe('revoked'); expect(fixture.runtime.finishTaskSession).toHaveBeenCalled();
  });
  it('marks a child exit unknown and revokes continuation authority', async () => {
    await approve(); await runTaskSessionTurn(args()); await waitFor(async () => !!(await detail()).record.turns?.[0].turnId);
    live.running = false; lost?.();
    await waitFor(async () => (await detail()).record.status === 'revoked');
    expect((await detail()).record.turns?.[0].result).toBe('unknown');
  });
  it('fails closed when administrator opt-in is removed between turns', async () => {
    await approve(); await runTaskSessionTurn(args()); await waitFor(async () => !!(await detail()).record.turns?.[0].turnId); complete();
    await waitFor(async () => (await detail()).record.executionState === 'idle');
    vi.stubEnv('PURPLEMUX_MCP_ALLOW_FULL_ACCESS', '0'); listeners.forEach((l) => l(live));
    await waitFor(async () => (await detail()).record.status === 'revoked'); expect(live.taskPermissionsActive).toBe(false);
  });
});
