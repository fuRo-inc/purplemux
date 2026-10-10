import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexGuiRuntime, type CodexGuiSandbox, type CodexGuiState } from '@/lib/codex-app-gui';
import type { IWorkspace, ITab } from '@/types/terminal';

const disk = vi.hoisted(() => new Map<string, string>());
vi.mock('fs', () => ({ promises: {
  mkdir: vi.fn(async () => {}),
  writeFile: vi.fn(async (file: string, bytes: string) => { disk.set(file, bytes); }),
  readFile: vi.fn(async (file: string) => {
    if (!disk.has(file)) throw new Error('ENOENT');
    return disk.get(file)!;
  }),
  rename: vi.fn(async (from: string, to: string) => { disk.set(to, disk.get(from)!); disk.delete(from); }),
} }));

// Exercise the actual RPC argument construction without starting Codex/SSH.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});

const cwd = '/home/test/work';
const threadA = '00000000-0000-4000-8000-000000000001';
const threadB = '00000000-0000-4000-8000-000000000002';
const workspace: IWorkspace = { id: 'ws-test', name: 'Test', directories: [cwd] };
const tab: ITab = {
  id: 'tab-test', sessionName: 'codex-test', name: 'Codex Chat', order: 0, cwd,
};

type RpcParams = Record<string, unknown>;
type RuntimeInternal = {
  state: CodexGuiState;
  request: (method: string, params: RpcParams, timeoutMs?: number) => Promise<RpcParams>;
  readStored: () => Promise<void>;
  store: () => Promise<void>;
  publish: () => void;
  handleNotification: (method: string, params: RpcParams) => void;
  handleLine: (line: string) => void;
  sendMessage: (message: RpcParams) => void;
  actions: Promise<unknown>;
};

const setup = (mode: CodexGuiSandbox, threadId: string | null = null) => {
  const runtime = new CodexGuiRuntime(workspace, tab);
  const internal = runtime as unknown as RuntimeInternal;
  internal.state.ready = true;
  internal.state.running = true;
  internal.state.cwd = cwd;
  internal.state.threadId = threadId;
  internal.state.sandboxMode = mode;
  vi.spyOn(internal, 'store').mockResolvedValue(undefined);
  vi.spyOn(internal, 'publish').mockImplementation(() => undefined);
  const rpc = vi.spyOn(internal, 'request').mockImplementation(async (method, params) => {
    if (method === 'thread/start') return { thread: { id: threadA, cwd } };
    if (method === 'thread/resume') return { thread: { id: params.threadId, cwd } };
    if (method === 'thread/read') return { thread: { cwd, turns: [] } };
    if (method === 'turn/start') return { turn: { id: 'turn-test' } };
    if (method === 'model/list') return { data: [] };
    return {};
  });
  return { runtime, internal, rpc };
};

afterEach(() => {
  disk.clear();
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
});

describe('Codex App Server sandbox RPC encoding', () => {
  // SandboxMode is kebab-case for thread/start and thread/resume.
  it.each([
    ['read-only', 'read-only'],
    ['workspace-write', 'workspace-write'],
    ['danger-full-access', 'danger-full-access'],
  ] as const)('sends %s for thread/start', async (mode, wireValue) => {
    const { runtime, rpc } = setup(mode);
    await runtime.action('send', { text: 'Inspect project status.' });
    expect(rpc).toHaveBeenCalledWith('thread/start', expect.objectContaining({
      cwd, sandbox: wireValue, approvalPolicy: 'on-request',
    }), 45000);
    expect(rpc).toHaveBeenCalledWith('turn/start', expect.any(Object), 45000);
    expect(runtime.snapshot().sandboxMode).toBe(mode);
  });

  it.each([
    ['read-only', 'read-only'],
    ['workspace-write', 'workspace-write'],
  ] as const)('sends %s when resuming a thread from the GUI', async (mode, wireValue) => {
    const { runtime, rpc } = setup(mode, threadA);
    await runtime.resumeThread(threadB);
    expect(rpc).toHaveBeenCalledWith('thread/resume', {
      threadId: threadB, sandbox: wireValue, approvalPolicy: 'on-request',
    }, 45000);
    expect(runtime.snapshot().threadId).toBe(threadB);
  });

  it('keeps read-only when automatically resuming a stored session', async () => {
    const { runtime, internal, rpc } = setup('read-only', threadA);
    vi.spyOn(internal, 'readStored').mockResolvedValue(undefined);
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    await runtime.start();
    expect(rpc).toHaveBeenCalledWith('initialize', {
      clientInfo: { name: 'purplemux', title: 'Purplemux', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }, 25000);
    expect(rpc.mock.calls[0][0]).toBe('initialize');
    expect(rpc).toHaveBeenCalledWith('thread/resume', {
      threadId: threadA, sandbox: 'read-only', approvalPolicy: 'on-request',
    }, 40000);
    expect(spawn).toHaveBeenCalledTimes(1);
    runtime.terminate();
  });

  it('stops initialization if experimentalApi negotiation is rejected', async () => {
    const { runtime, internal, rpc } = setup('read-only', threadA);
    internal.state.ready = false;
    internal.state.running = false;
    vi.spyOn(internal, 'readStored').mockResolvedValue(undefined);
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    rpc.mockImplementation(async (method) => {
      if (method === 'initialize') throw new Error('experimentalApi not supported');
      return {};
    });
    await expect(runtime.start()).rejects.toThrow('experimentalApi not supported');
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(['initialize']);
    expect(runtime.snapshot().ready).toBe(false);
    runtime.terminate();
  });

  // Tagged SandboxPolicy uses camelCase; these are not SandboxMode values.
  it.each([
    ['read-only', 'readOnly'],
    ['workspace-write', 'workspaceWrite'],
    ['danger-full-access', 'dangerFullAccess'],
  ] as const)('encodes %s as %s in thread/settings/update', async (mode, policyType) => {
    const previous: CodexGuiSandbox = mode === 'read-only' ? 'workspace-write' : 'read-only';
    const { runtime, rpc } = setup(previous, threadA);
    await runtime.action('settings', { sandboxMode: mode, approvalPolicy: 'on-request' });
    expect(rpc).toHaveBeenCalledWith('thread/settings/update', {
      threadId: threadA,
      sandboxPolicy: { type: policyType },
      approvalPolicy: 'on-request',
    }, 30000);
    expect(runtime.snapshot().sandboxMode).toBe(mode);
  });

  it('fails closed on a rejected read-only setting instead of starting the turn', async () => {
    const { runtime, rpc } = setup('workspace-write', threadA);
    rpc.mockImplementation(async (method) => {
      if (method === 'thread/settings/update') throw new Error('Invalid sandbox policy');
      return {};
    });
    // Same ordering as MCP execute(): settings must resolve before send().
    const run = async () => {
      await runtime.action('settings', { sandboxMode: 'read-only', approvalPolicy: 'on-request' });
      await runtime.action('send', { text: 'Inspect project status.' });
    };
    await expect(run()).rejects.toThrow('Invalid sandbox policy');
    expect(runtime.snapshot().sandboxMode).toBe('workspace-write');
    expect(rpc.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
    expect(rpc.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(true);
  });
});


const complete = async (internal: RuntimeInternal, status = 'completed') => {
  internal.handleNotification('turn/completed', { threadId: threadA, turn: { id: 'turn-test', status } });
  await internal.actions;
};
const task = { text: 'Inspect only', mode: 'continue' as const, sandboxMode: 'read-only' as const, directory: cwd, hostId: 'local' };
const savedSettings = () => JSON.parse([...disk.entries()].find(([file]) => file.endsWith('ws-test__tab-test.json'))![1]);

describe('MCP temporary permissions and durable GUI settings', () => {
  it.each(['completed', 'failed', 'interrupted'])('preserves Full Access/never on disk and restores after %s', async (status) => {
    const { runtime, internal, rpc } = setup('danger-full-access', threadA);
    internal.state.approvalPolicy = 'never';
    vi.mocked(internal.store).mockRestore();
    const state = await runtime.runTask(task);
    expect(state).toMatchObject({ sandboxMode: 'read-only', approvalPolicy: 'on-request', taskPermissionsActive: true });
    expect(savedSettings()).toMatchObject({ sandboxMode: 'danger-full-access', approvalPolicy: 'never' });
    await expect(runtime.action('settings', { sandboxMode: 'danger-full-access' })).rejects.toThrow('MCP task');
    await expect(runtime.action('send', { text: 'race' })).rejects.toThrow('MCP task');
    await expect(runtime.resumeThread(threadB)).rejects.toThrow('MCP task');
    await complete(internal, status);
    expect(runtime.snapshot()).toMatchObject({ sandboxMode: 'danger-full-access', approvalPolicy: 'never', taskPermissionsActive: false });
    expect(rpc).toHaveBeenLastCalledWith('thread/settings/update', {
      threadId: threadA, sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never',
    }, 30000);
    expect(savedSettings()).toMatchObject({ sandboxMode: 'danger-full-access', approvalPolicy: 'never' });
  });

  it.each(['read-only', 'workspace-write'] as const)('keeps the saved GUI %s setting during and after workspace-write tasks', async (mode) => {
    const { runtime, internal } = setup(mode, threadA);
    vi.mocked(internal.store).mockRestore();
    await runtime.runTask({ ...task, sandboxMode: 'workspace-write' });
    expect(savedSettings().sandboxMode).toBe(mode);
    expect(runtime.snapshot().sandboxMode).toBe('workspace-write');
    await complete(internal);
    expect(runtime.snapshot().sandboxMode).toBe(mode);
    expect(savedSettings().sandboxMode).toBe(mode);
  });

  it('starts a new MCP thread with temporary permissions without changing the previous thread', async () => {
    const { runtime, internal, rpc } = setup('danger-full-access', threadB);
    vi.mocked(internal.store).mockRestore();
    await runtime.runTask({ ...task, mode: 'new', sandboxMode: 'workspace-write' });
    expect(rpc).toHaveBeenCalledWith('thread/start', expect.objectContaining({ sandbox: 'workspace-write', approvalPolicy: 'on-request' }), 45000);
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/settings/update')).toEqual([]);
    expect(savedSettings().sandboxMode).toBe('danger-full-access');
    await complete(internal);
    await runtime.action('new-thread', {});
    await runtime.action('send', { text: 'GUI work' });
    expect(rpc).toHaveBeenLastCalledWith('turn/start', expect.any(Object), 45000);
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/start').at(-1)?.[1].sandbox).toBe('danger-full-access');
  });

  it('restores saved GUI settings on reconnect, including a restart during a task', async () => {
    const { runtime, internal } = setup('danger-full-access');
    internal.state.approvalPolicy = 'never';
    vi.mocked(internal.store).mockRestore();
    await runtime.runTask({ ...task, mode: 'new' });
    runtime.terminate();
    const restarted = setup('workspace-write');
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    await restarted.runtime.start();
    expect(restarted.rpc).toHaveBeenCalledWith('thread/resume', {
      threadId: threadA, sandbox: 'danger-full-access', approvalPolicy: 'never',
    }, 40000);
    expect(restarted.runtime.snapshot().taskPermissionsActive).toBe(false);
    restarted.runtime.terminate();
  });

  it('requires server acknowledgement even if temporary permissions equal current GUI settings', async () => {
    const { runtime, rpc } = setup('read-only', threadA);
    rpc.mockImplementation(async (method) => {
      if (method === 'thread/settings/update') throw new Error('unsupported');
      return {};
    });
    await expect(runtime.runTask(task)).rejects.toThrow();
    expect(rpc.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
    expect(runtime.snapshot().running).toBe(false);
  });

  it('disconnects if restoring GUI permissions fails', async () => {
    const { runtime, internal, rpc } = setup('danger-full-access', threadA);
    await runtime.runTask(task);
    rpc.mockImplementation(async () => { throw new Error('restore rejected'); });
    internal.handleNotification('turn/completed', { threadId: threadA, turn: { id: 'turn-test', status: 'completed' } });
    await expect(internal.actions).rejects.toThrow('restore rejected');
    expect(runtime.snapshot()).toMatchObject({ running: false, sandboxMode: 'danger-full-access', taskPermissionsActive: false });
    await expect(runtime.action('send', { text: 'next' })).rejects.toThrow('unavailable');
  });

  it('does not send a task after a rejected temporary sandbox update', async () => {
    const { runtime, rpc } = setup('danger-full-access', threadA);
    rpc.mockRejectedValueOnce(new Error('sandbox rejected'));
    await expect(runtime.runTask(task)).rejects.toThrow('sandbox rejected');
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(['thread/settings/update', 'thread/settings/update']);
    expect(runtime.snapshot()).toMatchObject({ sandboxMode: 'danger-full-access', taskPermissionsActive: false });
  });

  it('disconnects after an ambiguous turn/start failure and retains original settings', async () => {
    const { runtime, internal, rpc } = setup('danger-full-access');
    vi.mocked(internal.store).mockRestore();
    rpc.mockImplementation(async (method) => {
      if (method === 'thread/start') return { thread: { id: threadA, cwd } };
      if (method === 'turn/start') throw new Error('timed out');
      return {};
    });
    await expect(runtime.runTask(task)).rejects.toThrow('timed out');
    expect(runtime.snapshot()).toMatchObject({ running: false, sandboxMode: 'danger-full-access', taskPermissionsActive: false });
    expect(savedSettings().sandboxMode).toBe('danger-full-access');
  });

  it('restores after a turn completes before turn/start responds', async () => {
    const { runtime, internal, rpc } = setup('danger-full-access', threadA);
    rpc.mockImplementation(async (method) => {
      if (method === 'turn/start') {
        internal.handleNotification('turn/completed', { threadId: threadA, turn: { id: 'turn-test', status: 'completed' } });
        return { turn: { id: 'turn-test' } };
      }
      return {};
    });
    await runtime.runTask(task);
    await internal.actions;
    expect(runtime.snapshot()).toMatchObject({ busy: false, turnId: null, sandboxMode: 'danger-full-access', taskPermissionsActive: false });
  });

  it('ignores stale completion events from an earlier turn during task submission', async () => {
    const { runtime, internal, rpc } = setup('danger-full-access', threadA);
    rpc.mockImplementation(async (method) => {
      if (method === 'turn/start') {
        internal.handleNotification('turn/completed', { threadId: threadA, turn: { id: 'older-turn', status: 'completed' } });
        return { turn: { id: 'turn-test' } };
      }
      return {};
    });
    await runtime.runTask(task);
    await internal.actions;
    expect(runtime.snapshot()).toMatchObject({ busy: true, turnId: 'turn-test', sandboxMode: 'read-only', taskPermissionsActive: true });
    internal.handleNotification('turn/completed', { threadId: threadA, turn: { id: 'older-turn', status: 'completed' } });
    expect(runtime.snapshot().taskPermissionsActive).toBe(true);
    await complete(internal);
    expect(runtime.snapshot().taskPermissionsActive).toBe(false);
  });

  it('rejects concurrent tasks atomically, and permits a later continuation', async () => {
    const { runtime, internal, rpc } = setup('danger-full-access', threadA);
    const results = await Promise.allSettled([runtime.runTask(task), runtime.runTask(task)]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(rpc.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
    await complete(internal);
    await runtime.runTask({ ...task, sandboxMode: 'workspace-write' });
    expect(runtime.snapshot().sandboxMode).toBe('workspace-write');
    await complete(internal);
    expect(runtime.snapshot().sandboxMode).toBe('danger-full-access');
  });

  it('rejects changed actual cwd and invalid sandbox modes before sending', async () => {
    const { runtime, internal, rpc } = setup('danger-full-access', threadA);
    internal.state.cwd = '/different';
    await expect(runtime.runTask(task)).rejects.toThrow('working directory');
    await expect(runtime.runTask({ ...task, sandboxMode: 'danger-full-access' as 'read-only' })).rejects.toThrow('sandbox');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects an existing runtime attached to a different confirmed Host', async () => {
    const { runtime, rpc } = setup('danger-full-access', threadA);
    await expect(runtime.runTask({ ...task, hostId: 'other-host' })).rejects.toThrow('runtime host');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects a new thread created in an unexpected cwd', async () => {
    const { runtime, rpc } = setup('danger-full-access');
    rpc.mockImplementation(async (method) => method === 'thread/start' ? { thread: { id: threadA, cwd: '/different' } } : {});
    await expect(runtime.runTask({ ...task, mode: 'new' })).rejects.toThrow('working directory');
    expect(rpc.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
    expect(runtime.snapshot().running).toBe(false);
  });
});

const approvalSetup = (method = 'item/commandExecution/requestApproval', params: RpcParams = {}) => {
  const result = setup('workspace-write', threadA);
  result.internal.state.turnId = 'turn-test';
  result.internal.state.busy = true;
  const messages = vi.spyOn(result.internal, 'sendMessage').mockImplementation(() => {});
  result.internal.handleLine(JSON.stringify({ id: 123, method, params: {
    threadId: threadA, turnId: 'turn-test', command: 'nvidia-smi', ...params,
  } }));
  return { ...result, messages };
};

describe('Codex approval decisions', () => {
  it.each(['accept', 'acceptForSession', 'decline', 'cancel'])('supports command %s', async (decision) => {
    const { runtime, messages } = approvalSetup();
    await runtime.action('approve', { requestId: 123, decision });
    expect(messages).toHaveBeenLastCalledWith({ id: 123, result: { decision } });
    expect(runtime.snapshot().approvals).toEqual([]);
    await expect(runtime.action('approve', { requestId: 123, decision })).rejects.toThrow('expired');
  });

  it('supports acceptForSession for file changes', async () => {
    const { runtime, messages } = approvalSetup('item/fileChange/requestApproval');
    await runtime.action('approve', { requestId: 123, decision: 'acceptForSession' });
    expect(messages).toHaveBeenCalledWith({ id: 123, result: { decision: 'acceptForSession' } });
  });

  it('limits choices to availableDecisions and rejects unknown decisions', async () => {
    const { runtime, messages } = approvalSetup(undefined, { availableDecisions: ['accept', 'decline', 'unknown'] });
    expect(runtime.snapshot().approvals[0].availableDecisions).toEqual(['accept', 'decline']);
    await expect(runtime.action('approve', { requestId: 123, decision: 'acceptForSession' })).rejects.toThrow('Invalid');
    await expect(runtime.action('approve', { requestId: 123, decision: 'unknown' })).rejects.toThrow('Invalid');
    expect(messages).not.toHaveBeenCalled();
  });

  it('accepts only the precise execpolicy rule proposed by Codex', async () => {
    const decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['nvidia-smi'] } };
    const { runtime, messages } = approvalSetup(undefined, { proposedExecpolicyAmendment: ['nvidia-smi'], availableDecisions: [decision, 'decline'] });
    await expect(runtime.action('approve', { requestId: 123, decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['sh'] } } })).rejects.toThrow('Invalid');
    await runtime.action('approve', { requestId: 123, decision });
    expect(messages).toHaveBeenCalledWith({ id: 123, result: { decision } });
  });

  it('rejects rule decisions without a proposal even if listed in availableDecisions', async () => {
    const decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['sh'] } };
    const { runtime } = approvalSetup(undefined, { availableDecisions: [decision, 'decline'] });
    expect(runtime.snapshot().approvals[0].availableDecisions).toEqual(['decline']);
    await expect(runtime.action('approve', { requestId: 123, decision })).rejects.toThrow('Invalid');
  });

  it('does not offer a proposed exec rule when availableDecisions excludes it', async () => {
    const { runtime } = approvalSetup(undefined, { proposedExecpolicyAmendment: ['nvidia-smi'], availableDecisions: ['accept', 'decline'] });
    expect(runtime.snapshot().approvals[0].availableDecisions).toEqual(['accept', 'decline']);
  });

  it('accepts only proposed network amendments including the action', async () => {
    const rule = { host: 'example.com', action: 'allow' };
    const decision = { applyNetworkPolicyAmendment: { network_policy_amendment: rule } };
    const { runtime, messages } = approvalSetup(undefined, { proposedNetworkPolicyAmendments: [rule], networkApprovalContext: { host: 'example.com', protocol: 'https' } });
    expect(runtime.snapshot().approvals[0].command).toBe('Network: https example.com');
    await expect(runtime.action('approve', { requestId: 123, decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { ...rule, host: '*' } } } })).rejects.toThrow('Invalid');
    await runtime.action('approve', { requestId: 123, decision });
    expect(messages).toHaveBeenCalledWith({ id: 123, result: { decision } });
  });

  it('does not expose or accept rule amendments for file changes', async () => {
    const decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['sh'] } };
    const { runtime } = approvalSetup('item/fileChange/requestApproval', { proposedExecpolicyAmendment: ['sh'] });
    await expect(runtime.action('approve', { requestId: 123, decision })).rejects.toThrow('Invalid');
  });

  it.each([[], ['unknown'], 'invalid'])('fails closed for unsupported candidate lists %j', (availableDecisions) => {
    const { runtime, messages } = approvalSetup(undefined, { availableDecisions });
    expect(runtime.snapshot().approvals).toEqual([]);
    expect(messages).toHaveBeenCalledWith({ id: 123, result: { decision: 'decline' } });
  });

  it('refuses approvals for a different thread or expired turn', async () => {
    const { runtime, internal, messages } = approvalSetup(undefined, { threadId: threadB });
    expect(runtime.snapshot().approvals).toEqual([]);
    expect(messages).toHaveBeenCalledWith({ id: 123, result: { decision: 'decline' } });
    internal.handleLine(JSON.stringify({ id: 124, method: 'item/commandExecution/requestApproval', params: { threadId: threadA, turnId: 'turn-test' } }));
    internal.state.turnId = 'next-turn';
    await expect(runtime.action('approve', { requestId: 124, decision: 'accept' })).rejects.toThrow('Invalid');
  });

  it('denies a server approval request under never instead of automatically accepting', () => {
    const { runtime, internal } = setup('danger-full-access', threadA);
    internal.state.approvalPolicy = 'never';
    const messages = vi.spyOn(internal, 'sendMessage').mockImplementation(() => {});
    internal.handleLine(JSON.stringify({ id: 123, method: 'item/commandExecution/requestApproval', params: {} }));
    expect(messages).toHaveBeenCalledWith({ id: 123, result: { decision: 'decline' } });
    expect(runtime.snapshot().approvals).toEqual([]);
  });

  it('explicitly denies permissions requests using the dedicated response shape', () => {
    const { runtime, messages } = approvalSetup('item/permissions/requestApproval', {
      permissions: { network: { enabled: true }, fileSystem: { write: ['/'] } },
    });
    expect(messages).toHaveBeenCalledWith({ id: 123, result: { permissions: {}, scope: 'turn' } });
    expect(runtime.snapshot().approvals).toEqual([]);
    expect(runtime.snapshot().error).toContain('拒否');
  });

  it('responds with a protocol error for unknown server requests', () => {
    const { runtime, messages } = approvalSetup('unsupported/requestApproval');
    expect(messages).toHaveBeenCalledWith({ id: 123, error: { code: -32601, message: 'Unsupported Codex request: unsupported/requestApproval' } });
    expect(runtime.snapshot().approvals).toEqual([]);
  });

  it('does not allow a snapshot consumer to mutate the backend decision allowlist', async () => {
    const { runtime } = approvalSetup();
    runtime.snapshot().approvals[0].availableDecisions!.push({ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['sh'] } });
    await expect(runtime.action('approve', { requestId: 123, decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['sh'] } } })).rejects.toThrow('Invalid');
  });
});
