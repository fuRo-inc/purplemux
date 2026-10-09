import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexGuiRuntime, type CodexGuiSandbox, type CodexGuiState } from '@/lib/codex-app-gui';
import type { IWorkspace, ITab } from '@/types/terminal';

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
