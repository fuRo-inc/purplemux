import { afterEach, describe, expect, it, vi } from 'vitest';

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

import { submitCodexTask, getCodexTask } from '@/lib/mcp-codex-tasks';

const base = {
  workspaceId: 'ws-test', tabId: 'tab-test',
  expectedHostId: 'local', expectedDirectory: '/home/test/work',
  instruction: 'Inspect project status, do not change files.',
  confirmTarget: true,
};
afterEach(() => vi.unstubAllEnvs());

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
  it('rejects malformed task IDs without filesystem access', async () => {
    await expect(getCodexTask({ taskId: '../etc/passwd' })).rejects.toThrow('Invalid taskId');
  });
});
