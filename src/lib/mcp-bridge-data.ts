import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { listRemoteHosts } from '@/lib/remote-host-store';
import { getWorkspaces } from '@/lib/workspace-store';
import { collectAllTabs, readLayoutFile, resolveLayoutFile } from '@/lib/layout-store';
import { peekCodexGuiRuntime } from '@/lib/codex-app-gui';
import type { ITab, IWorkspace } from '@/types/terminal';

const ID_RE = /^[a-zA-Z0-9_-]{1,120}$/;
const MAX_WORKSPACES = 100;
const MAX_TABS = 150;
const MAX_RECENT = 10;

const findWorkspace = async (workspaceId: unknown): Promise<IWorkspace> => {
  if (typeof workspaceId !== 'string' || !ID_RE.test(workspaceId)) {
    throw new Error('A valid workspaceId is required');
  }
  const { workspaces } = await getWorkspaces();
  const workspace = workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) throw new Error('Workspace not found');
  return workspace;
};

const getCodexTabs = async (workspace: IWorkspace): Promise<ITab[]> => {
  const layout = await readLayoutFile(resolveLayoutFile(workspace.id));
  if (!layout) return [];
  return collectAllTabs(layout.root)
    .filter((tab) => tab.panelType === 'codex-chat' || tab.panelType === 'codex-cli')
    .slice(0, MAX_TABS);
};

const readPersistedChat = async (workspaceId: string, tabId: string) => {
  if (!ID_RE.test(workspaceId) || !ID_RE.test(tabId)) return null;
  const filename = path.join(os.homedir(), '.purplemux', 'codex-app-sessions',
    workspaceId + '__' + tabId + '.json');
  try {
    const entry = JSON.parse(await fs.readFile(filename, 'utf8')) as Record<string, unknown>;
    return {
      threadId: typeof entry.threadId === 'string' ? entry.threadId : null,
      model: typeof entry.model === 'string' ? entry.model : null,
      effort: typeof entry.effort === 'string' ? entry.effort : null,
    };
  } catch {
    return null;
  }
};

const workspaceLocation = (workspace: IWorkspace): string =>
  (workspace.hostId ? workspace.remoteDirectory : workspace.directories[0]) || '';

export const listBridgeHosts = async () => {
  const hosts = await listRemoteHosts();
  return {
    hosts: [
      { id: 'local', name: os.hostname(), kind: 'local', configured: true },
      ...hosts.map((host) => ({
        id: host.id,
        name: host.name,
        kind: 'ssh',
        address: host.address,
        port: host.port,
        configured: true,
        // Listing hosts is intentionally passive: no SSH connection is made.
        connectivity: 'not_checked',
      })),
    ],
  };
};

export const listBridgeWorkspaces = async (hostId?: unknown) => {
  if (hostId !== undefined && (typeof hostId !== 'string' || !ID_RE.test(hostId))) {
    throw new Error('hostId must be a valid host ID');
  }
  const { workspaces, activeWorkspaceId } = await getWorkspaces();
  const hosts = await listRemoteHosts();
  const nameById = new Map(hosts.map((host) => [host.id, host.name]));
  const rows = workspaces
    .filter((workspace) => !hostId || (workspace.hostId || 'local') === hostId)
    .slice(0, MAX_WORKSPACES)
    .map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      hostId: workspace.hostId || 'local',
      hostName: workspace.hostId ? nameById.get(workspace.hostId) || '(missing host)' : os.hostname(),
      directory: workspaceLocation(workspace),
      isActive: workspace.id === activeWorkspaceId,
    }));
  return { activeWorkspaceId: activeWorkspaceId || null, workspaces: rows };
};

export const listBridgeCodexTabs = async (workspaceId?: unknown) => {
  const { workspaces } = await getWorkspaces();
  const selected = workspaceId === undefined
    ? workspaces.slice(0, MAX_WORKSPACES)
    : [await findWorkspace(workspaceId)];
  const rows = [];
  for (const workspace of selected) {
    const tabs = await getCodexTabs(workspace);
    for (const tab of tabs) {
      if (rows.length >= MAX_TABS) break;
      const active = tab.panelType === 'codex-chat'
        ? await peekCodexGuiRuntime(workspace.id, tab.id) : null;
      const persisted = tab.panelType === 'codex-chat' && !active
        ? await readPersistedChat(workspace.id, tab.id) : null;
      const directory = (workspace.hostId ? workspace.remoteDirectory :
        (tab.cwd || workspace.directories[0])) || '';
      rows.push({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        hostId: workspace.hostId || 'local',
        directory,
        // The resumed Codex thread can have a cwd different from its tab.
        // Surface that discrepancy before a client attempts continuation.
        threadDirectory: active?.cwd || null,
        threadMatchesDirectory: active?.cwd ? active.cwd.replace(/\/+$/, '') === directory.replace(/\/+$/, '') : null,
        tabId: tab.id,
        tabName: tab.name,
        panelType: tab.panelType || 'terminal',
        threadId: active?.threadId || persisted?.threadId || tab.agentState?.sessionId || null,
        model: active?.model || persisted?.model || null,
        status: active
          ? (active.busy ? 'running' : active.ready ? 'ready' : 'unavailable')
          : tab.panelType === 'codex-chat' ? 'not_loaded' : 'legacy_tui',
        // Not a live probe of SSH or of the remote Codex CLI.
      });
    }
    if (rows.length >= MAX_TABS) break;
  }
  return { tabs: rows, truncated: rows.length >= MAX_TABS };
};

export const getBridgeCodexStatus = async (
  workspaceId: unknown,
  tabId: unknown,
  includeRecentItems: unknown = false,
) => {
  const workspace = await findWorkspace(workspaceId);
  if (typeof tabId !== 'string' || !ID_RE.test(tabId)) {
    throw new Error('A valid tabId is required');
  }
  if (typeof includeRecentItems !== 'boolean') {
    throw new Error('includeRecentItems must be boolean');
  }
  const tab = (await getCodexTabs(workspace)).find((entry) => entry.id === tabId);
  if (!tab) throw new Error('Codex tab not found in this Workspace');
  if (tab.panelType !== 'codex-chat') {
    return {
      workspaceId: workspace.id, tabId, panelType: tab.panelType,
      status: 'legacy_tui', ready: null, busy: null,
      note: 'Legacy Codex CLI status is not available through App Server. No process was started.',
    };
  }
  const state = await peekCodexGuiRuntime(workspace.id, tab.id);
  if (!state) {
    const persisted = await readPersistedChat(workspace.id, tab.id);
    return {
      workspaceId: workspace.id, tabId, panelType: 'codex-chat',
      status: 'not_loaded', ready: false, busy: null,
      threadId: persisted?.threadId || null,
      model: persisted?.model || null,
      effort: persisted?.effort || null,
      note: 'Purplemux has not loaded this Codex Chat runtime. The saved thread is not a live status.',
    };
  }
  return {
    workspaceId: workspace.id,
    tabId: tab.id,
    hostId: workspace.hostId || 'local',
    directory: (workspace.hostId ? workspace.remoteDirectory :
      (tab.cwd || workspace.directories[0])) || '',
    threadDirectory: state.cwd,
    status: state.busy ? 'running' : state.ready ? 'ready' : 'unavailable',
    ready: state.ready,
    busy: state.busy,
    threadId: state.threadId,
    turnId: state.turnId,
    lastTurnId: state.lastTurnId,
    lastTurnStatus: state.lastTurnStatus,
    model: state.model,
    effort: state.effort,
    fastMode: state.fastMode,
    sandboxMode: state.sandboxMode,
    approvalPolicy: state.approvalPolicy,
    pendingApprovalCount: state.approvals.length,
    itemCount: state.items.length,
    error: state.error,
    // Content is only included when explicitly requested.
    ...(includeRecentItems ? {
      pendingApprovals: state.approvals.map((approval) => ({
        requestId: approval.requestId, method: approval.method,
        command: approval.command.slice(0, 1000), reason: approval.reason.slice(0, 1000),
      })),
      recentItems: state.items.slice(-MAX_RECENT).map((item) => ({
        id: item.id,
        type: item.type,
        status: item.status || null,
        title: item.title ? item.title.slice(0, 300) : null,
        text: item.text.slice(-1200),
      })),
    } : {}),
  };
};
