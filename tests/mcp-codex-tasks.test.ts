import { afterEach, describe, expect, it, vi } from 'vitest';

const taskDisk = vi.hoisted(() => new Map<string, string>());
vi.mock('node:fs', () => ({ promises: {
  mkdir: vi.fn(async () => {}),
  writeFile: vi.fn(async (file: string, bytes: string) => { taskDisk.set(file, bytes); }),
  readFile: vi.fn(async (file: string) => {
    if (!taskDisk.has(file)) throw new Error('ENOENT');
    return taskDisk.get(file)!;
  }),
  rename: vi.fn(async (from: string, to: string) => { taskDisk.set(to, taskDisk.get(from)!); taskDisk.delete(from); }),
  unlink: vi.fn(async () => {}), readdir: vi.fn(async () => []),
} }));

// No real Codex process, SSH or task file writes are started in these tests.
vi.mock('@/lib/codex-app-tab', () => ({
  resolveCodexAppTab: vi.fn(async () => ({
    workspace: {
      id: 'ws-test', name: 'Test', directories: ['/home/test/work'], hostId: undefined,
    },
    tab: { id: 'tab-test', name: 'Codex Chat', panelType: 'codex-chat', cwd: '/home/test/work' },
  })),
}));
vi.mock('@/lib/codex-app-gui', () => ({
  peekCodexGuiRuntime: vi.fn(async () => null),
  getCodexGuiRuntime: vi.fn(),
  getLoadedCodexGuiRuntime: vi.fn(async () => null),
}));

import { getCodexGuiRuntime, getLoadedCodexGuiRuntime, peekCodexGuiRuntime, type CodexGuiState } from '@/lib/codex-app-gui';
import { resolveCodexAppTab } from '@/lib/codex-app-tab';
import { submitCodexTask, getCodexTask, respondCodexApproval } from '@/lib/mcp-codex-tasks';

const base = {
  workspaceId: 'ws-test', tabId: 'tab-test',
  expectedHostId: 'local', expectedDirectory: '/home/test/work',
  instruction: 'Inspect project status, do not change files.',
  confirmTarget: true,
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(peekCodexGuiRuntime).mockResolvedValue(null);
  vi.mocked(getLoadedCodexGuiRuntime).mockResolvedValue(null);
});

describe('MCP Codex write safety', () => {
  it('refuses any task submission unless explicitly enabled on the NUC', async () => {
    vi.stubEnv('PURPLEMUX_MCP_ALLOW_WRITES', '0');
    await expect(submitCodexTask(base)).rejects.toThrow('disabled');
  });
  it('does not accept implicit workspace confirmation', async () => {
    vi.stubEnv('PURPLEMUX_MCP_ALLOW_WRITES', '1');
    await expect(submitCodexTask({ ...base, confirmTarget: false }))
      .rejects.toThrow('confirmTarget');
  });
  it('refuses wrong Host IDs before starting a process', async () => {
    vi.stubEnv('PURPLEMUX_MCP_ALLOW_WRITES', '1');
    await expect(submitCodexTask({ ...base, expectedHostId: 'host-other' }))
      .rejects.toThrow('Host or working directory mismatch');
  });
  it('refuses wrong working directories before starting a process', async () => {
    vi.stubEnv('PURPLEMUX_MCP_ALLOW_WRITES', '1');
    await expect(submitCodexTask({ ...base, expectedDirectory: '/home/test/another' }))
      .rejects.toThrow('Host or working directory mismatch');
  });
  it('validates bounded instruction and mode before any write', async () => {
    vi.stubEnv('PURPLEMUX_MCP_ALLOW_WRITES', '1');
    await expect(submitCodexTask({ ...base, instruction: '' })).rejects.toThrow('Instruction');
    await expect(submitCodexTask({ ...base, mode: 'run-as-root' })).rejects.toThrow('mode');
  });
  it('starts with read-only permission unless workspace write is explicitly confirmed', async () => {
    vi.stubEnv('PURPLEMUX_MCP_ALLOW_WRITES', '1');
    await expect(submitCodexTask({ ...base, sandboxMode: 'workspace-write' }))
      .rejects.toThrow('confirmWriteAccess');
    await expect(submitCodexTask({ ...base, sandboxMode: 'workspace-write', confirmWriteAccess: false }))
      .rejects.toThrow('confirmWriteAccess');
  });
  it('never allows danger-full-access or unrecognized sandbox modes over MCP', async () => {
    vi.stubEnv('PURPLEMUX_MCP_ALLOW_WRITES', '1');
    await expect(submitCodexTask({ ...base, sandboxMode: 'danger-full-access', confirmWriteAccess: true }))
      .rejects.toThrow('sandboxMode');
  });
  it('does not accept a malformed explicit write confirmation', async () => {
    vi.stubEnv('PURPLEMUX_MCP_ALLOW_WRITES', '1');
    await expect(submitCodexTask({ ...base, confirmWriteAccess: 'true' }))
      .rejects.toThrow('confirmWriteAccess');
  });
  it('rejects malformed task IDs without filesystem access', async () => {
    await expect(getCodexTask({ taskId: '../etc/passwd' })).rejects.toThrow('Invalid taskId');
  });
});


const taskRuntime = () => {
  vi.stubEnv('PURPLEMUX_MCP_ALLOW_WRITES', '1');
  const state: CodexGuiState = {
    ready: true, running: true, busy: false, threadId: 'thread-1', cwd: '/home/test/work', turnId: null,
    lastTurnId: null, lastTurnStatus: null, model: null, effort: null,
    sandboxMode: 'danger-full-access', approvalPolicy: 'never', fastMode: false,
    models: [], items: [], approvals: [], error: null,
  };
  const runTask = vi.fn(async () => {
    Object.assign(state, { busy: true, turnId: 'turn-1', taskPermissionsActive: true });
    state.items.push({ id: 'task-user', type: 'user', text: base.instruction });
    return state;
  });
  const action = vi.fn(async () => state);
  const runtime = { snapshot: () => state, runTask, action, subscribe: vi.fn(() => () => {}), getTurnDiff: () => null };
  vi.mocked(getCodexGuiRuntime).mockResolvedValue(runtime as unknown as Awaited<ReturnType<typeof getCodexGuiRuntime>>);
  vi.mocked(getLoadedCodexGuiRuntime).mockResolvedValue(runtime as unknown as Awaited<ReturnType<typeof getCodexGuiRuntime>>);
  vi.mocked(peekCodexGuiRuntime).mockImplementation(async () => state);
  return { state, runtime, runTask, action };
};
const waitForTask = async (taskId: string) => {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = await getCodexTask({ taskId, includeOutput: true });
    if (!['queued', 'starting'].includes(String(result.status))) return result;
  }
  throw new Error('Task did not start');
};
const finish = async (taskId: string, state: CodexGuiState) => {
  Object.assign(state, { busy: false, taskPermissionsActive: false, turnId: null, lastTurnId: 'turn-1', lastTurnStatus: 'completed' });
  return getCodexTask({ taskId, includeOutput: true });
};

describe('MCP execution uses the runtime temporary-permission transaction', () => {
  it('passes the read-only default without changing persistent settings through action', async () => {
    const { state, runTask, action } = taskRuntime();
    const result = await submitCodexTask(base);
    expect((await waitForTask(result.taskId)).status).toBe('running');
    expect(runTask).toHaveBeenCalledWith({ text: base.instruction, mode: 'continue', sandboxMode: 'read-only', directory: '/home/test/work', hostId: 'local' });
    expect(action).not.toHaveBeenCalled();
    expect((await finish(result.taskId, state)).status).toBe('completed');
  });

  it('passes explicitly confirmed workspace-write and new-thread mode', async () => {
    const { state, runTask } = taskRuntime();
    const result = await submitCodexTask({ ...base, mode: 'new', sandboxMode: 'workspace-write', confirmWriteAccess: true });
    await waitForTask(result.taskId);
    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({ sandboxMode: 'workspace-write', mode: 'new' }));
    await finish(result.taskId, state);
  });

  it('marks failed if temporary permission configuration is rejected', async () => {
    const { runTask, action } = taskRuntime();
    runTask.mockRejectedValueOnce(new Error('temporary sandbox rejected'));
    const result = await submitCodexTask(base);
    expect(await waitForTask(result.taskId)).toMatchObject({ status: 'failed', error: 'temporary sandbox rejected' });
    expect(action).not.toHaveBeenCalled();
  });

  it('rejects a submission while restoration still owns the tab', async () => {
    const { state, runTask } = taskRuntime();
    state.taskPermissionsActive = true;
    await expect(submitCodexTask(base)).rejects.toThrow('already running');
    expect(runTask).not.toHaveBeenCalled();
  });

  it('rechecks the host before entering the permission transaction', async () => {
    const { runTask } = taskRuntime();
    const normal = await resolveCodexAppTab('ws-test', 'tab-test');
    vi.mocked(resolveCodexAppTab).mockResolvedValueOnce(normal).mockResolvedValueOnce({
      ...normal, workspace: { ...normal.workspace, hostId: 'changed-host' },
    });
    const result = await submitCodexTask(base);
    expect(await waitForTask(result.taskId)).toMatchObject({ status: 'failed', error: 'Host changed while task was starting' });
    expect(runTask).not.toHaveBeenCalled();
  });

  it('preserves MCP accept/decline compatibility and separate acceptance opt-in', async () => {
    const { state, action } = taskRuntime();
    const result = await submitCodexTask(base);
    await waitForTask(result.taskId);
    state.approvals = [{ requestId: 123, method: 'item/commandExecution/requestApproval', command: 'nvidia-smi', reason: 'GPU', availableDecisions: ['accept', 'decline'] }];
    const approval = { taskId: result.taskId, requestId: 123, decision: 'accept', confirmApproval: true, expectedCommand: 'nvidia-smi' };
    await expect(respondCodexApproval(approval)).rejects.toThrow('acceptance is disabled');
    vi.stubEnv('PURPLEMUX_MCP_ALLOW_APPROVALS', '1');
    await expect(respondCodexApproval({ ...approval, decision: 'acceptForSession' })).rejects.toThrow('Invalid approval decision');
    await expect(respondCodexApproval({ ...approval, expectedCommand: 'sh' })).rejects.toThrow('request changed');
    await expect(respondCodexApproval({ ...approval, confirmApproval: false })).rejects.toThrow('confirmApproval');
    await respondCodexApproval(approval);
    expect(action).toHaveBeenCalledWith('approve', { requestId: 123, decision: 'accept' });
    await respondCodexApproval({ ...approval, decision: 'decline' });
    expect(action).toHaveBeenCalledWith('approve', { requestId: 123, decision: 'decline' });
    await finish(result.taskId, state);
  });

  it('treats a persisted task from an earlier process as unknown after restart', async () => {
    const { state } = taskRuntime();
    const result = await submitCodexTask(base);
    await waitForTask(result.taskId);
    vi.resetModules();
    const restarted = await import('@/lib/mcp-codex-tasks');
    expect(await restarted.getCodexTask({ taskId: result.taskId })).toMatchObject({ status: 'unknown', error: expect.stringContaining('restarted') });
    await finish(result.taskId, state);
  });
});
