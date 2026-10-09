import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { nanoid } from 'nanoid';
import { listSessions, killSession, sendKeys } from '@/lib/tmux';
import { getRemoteHost } from '@/lib/remote-host-store';
import { buildRemoteShellCommand } from '@/lib/remote-workspace';
import { createLogger } from '@/lib/logger';
import { broadcastSync } from '@/lib/sync-server';
import {
  readLayoutFile,
  writeLayoutFile,
  resolveLayoutDir,
  resolveLayoutFile,
  removeLayoutFile,
  crossCheckLayout,
  collectAllTabs,
  createDefaultLayout,
} from '@/lib/layout-store';
import type { ICreateLayoutOptions } from '@/lib/layout-store';
import { listProviders } from '@/lib/providers/registry';
import { getVisuallyOrderedWorkspaces } from '@/lib/workspace-order';
import type { IWorkspace, IWorkspaceGroup, IWorkspacesData, ILayoutData } from '@/types/terminal';

const log = createLogger('workspace');

const WORKSPACE_PREFIX = 'Workspace ';

export const writeWorkspacePrompts = async (ws: IWorkspace): Promise<void> => {
  const tasks: Promise<void>[] = [];
  for (const provider of listProviders()) {
    const task = provider.writeWorkspacePrompt?.(ws);
    if (task) tasks.push(task);
  }
  await Promise.all(tasks);
};

export const writeAllWorkspacePrompts = async (workspaces: IWorkspace[]): Promise<void> => {
  await Promise.all(workspaces.map(writeWorkspacePrompts));
};

const nextWorkspaceName = (workspaces: IWorkspace[]): string => {
  let max = 0;
  for (const ws of workspaces) {
    if (ws.name.startsWith(WORKSPACE_PREFIX)) {
      const n = parseInt(ws.name.slice(WORKSPACE_PREFIX.length), 10);
      if (n > max) max = n;
    }
  }
  return `${WORKSPACE_PREFIX}${max + 1}`;
};

const BASE_DIR = path.join(os.homedir(), '.purplemux');
const WORKSPACES_FILE = path.join(BASE_DIR, 'workspaces.json');
const LEGACY_LAYOUT_FILE = path.join(BASE_DIR, 'layout.json');
const LEGACY_TABS_FILE = path.join(BASE_DIR, 'tabs.json');

const g = globalThis as unknown as {
  __purplemuxWorkspaceLock?: Promise<void>;
  __purplemuxWorkspacesContentCache?: string;
};
if (!g.__purplemuxWorkspaceLock) g.__purplemuxWorkspaceLock = Promise.resolve();

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = g.__purplemuxWorkspaceLock!;
  g.__purplemuxWorkspaceLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

const emptyState = (): IWorkspacesData => ({
  workspaces: [],
  groups: [],
  sidebarCollapsed: false,
  sidebarWidth: 240,
  updatedAt: new Date().toISOString(),
});

const ensureGroups = (data: IWorkspacesData): IWorkspaceGroup[] => {
  if (!data.groups) data.groups = [];
  return data.groups;
};

const normalizeWorkspaceOrder = (data: IWorkspacesData): void => {
  const groups = ensureGroups(data);
  data.workspaces = getVisuallyOrderedWorkspaces(data.workspaces, groups);
};

const readWorkspacesFile = async (): Promise<IWorkspacesData | null> => {
  let raw: string;
  try {
    raw = await fs.readFile(WORKSPACES_FILE, 'utf-8');
  } catch {
    return null;
  }

  try {
    const data = JSON.parse(raw) as IWorkspacesData;
    for (const ws of data.workspaces) {
      const legacy = ws as unknown as { directory?: string; order?: number };
      if (!ws.directories && legacy.directory) {
        ws.directories = [legacy.directory];
        delete legacy.directory;
      }
      delete legacy.order;
    }
    if (!Array.isArray(data.groups)) data.groups = [];
    for (const g of data.groups) {
      delete (g as unknown as { order?: number }).order;
    }
    const validGroupIds = new Set(data.groups.map((g) => g.id));
    for (const ws of data.workspaces) {
      if (ws.groupId && !validGroupIds.has(ws.groupId)) {
        ws.groupId = null;
      }
    }
    return data;
  } catch {
    log.warn('Failed to parse workspaces.json, starting empty');
    try {
      await fs.copyFile(WORKSPACES_FILE, WORKSPACES_FILE.replace(/\.json$/, '.json.bak'));
    } catch {}
    return null;
  }
};

const writeWorkspacesFile = async (data: IWorkspacesData): Promise<void> => {
  normalizeWorkspaceOrder(data);
  const { workspaces, groups, activeWorkspaceId, sidebarCollapsed, sidebarWidth } = data;
  const contentKey = JSON.stringify({ workspaces, groups: groups ?? [], activeWorkspaceId, sidebarCollapsed, sidebarWidth });

  if (g.__purplemuxWorkspacesContentCache === contentKey) return;

  data.updatedAt = new Date().toISOString();
  const tmpFile = WORKSPACES_FILE + '.tmp';
  try {
    await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmpFile, WORKSPACES_FILE);
  } catch (err) {
    await fs.unlink(tmpFile).catch(() => {});
    throw err;
  }

  g.__purplemuxWorkspacesContentCache = contentKey;
  broadcastSync({ type: 'workspace' });
};

const migrateFromPhase4 = async (): Promise<IWorkspacesData | null> => {
  const legacyLayout = await readLayoutFile(LEGACY_LAYOUT_FILE);
  if (!legacyLayout) return null;

  const wsId = 'ws-default';
  await fs.mkdir(resolveLayoutDir(wsId), { recursive: true });
  await writeLayoutFile(legacyLayout, resolveLayoutFile(wsId));

  const data: IWorkspacesData = {
    workspaces: [{
      id: wsId,
      name: 'default',
      directories: [os.homedir()],
    }],
    sidebarCollapsed: false,
    sidebarWidth: 240,
    updatedAt: legacyLayout.updatedAt || new Date().toISOString(),
  };

  await writeWorkspacesFile(data);
  log.info(`Phase 4 layout.json → Workspace 'default' migration complete`);
  return data;
};

const migrateFromTabs = async (): Promise<IWorkspacesData | null> => {
  try {
    const raw = await fs.readFile(LEGACY_TABS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.tabs) || data.tabs.length === 0) return null;

    const paneId = `pane-${nanoid(6)}`;
    const legacyLayout: ILayoutData = {
      root: {
        type: 'pane',
        id: paneId,
        tabs: data.tabs,
        activeTabId: data.activeTabId ?? null,
      },
      activePaneId: paneId,
      updatedAt: new Date().toISOString(),
    };

    const tmpFile = LEGACY_LAYOUT_FILE + '.tmp';
    try {
      await fs.writeFile(tmpFile, JSON.stringify(legacyLayout, null, 2), { mode: 0o600 });
      await fs.rename(tmpFile, LEGACY_LAYOUT_FILE);
    } catch (err) {
      await fs.unlink(tmpFile).catch(() => {});
      throw err;
    }
    log.info('tabs.json → layout.json migration complete');

    return await migrateFromPhase4();
  } catch {
    return null;
  }
};

export const initWorkspaceStore = async (): Promise<void> => {
  await fs.mkdir(path.join(BASE_DIR, 'workspaces'), { recursive: true });

  let data = await readWorkspacesFile();

  if (!data) {
    const layoutExists = await fs.access(LEGACY_LAYOUT_FILE).then(() => true).catch(() => false);
    if (layoutExists) {
      data = await migrateFromPhase4();
    } else {
      const tabsExists = await fs.access(LEGACY_TABS_FILE).then(() => true).catch(() => false);
      if (tabsExists) {
        data = await migrateFromTabs();
      }
    }
  }

  if (!data) {
    const state = emptyState();
    await writeWorkspacesFile(state);
    data = state;
    log.info('Initial workspaces.json created');
  }

  if (data.workspaces.length === 0) {
    return;
  }

  const allTmuxSessions = await listSessions();

  for (const ws of data.workspaces) {
    const layoutFile = resolveLayoutFile(ws.id);
    let layout = await readLayoutFile(layoutFile);

    if (!layout) {
      log.warn(`Workspace '${ws.name}': layout.json corrupted, reset to default pane`);
      layout = await createDefaultLayout(ws.id, ws.directories[0]);
      await writeLayoutFile(layout, layoutFile);
      continue;
    }

    const wsTabs = collectAllTabs(layout.root);
    const wsSessionNames = wsTabs.map((t) => t.sessionName);

    const wsPrefix = `pt-${ws.id}-`;
    const relevantTmuxSessions = allTmuxSessions.filter(
      (s) => wsSessionNames.includes(s) || s.startsWith(wsPrefix),
    );

    try {
      const changed = await crossCheckLayout(layout, relevantTmuxSessions, ws.id, ws.directories[0]);
      if (changed) {
        await writeLayoutFile(layout, layoutFile);
      }
    } catch (err) {
      log.error(`Workspace '${ws.name}': tmux consistency check failed: ${err instanceof Error ? err.message : err}`);
    }

  }
};

export const getWorkspaces = async (): Promise<{
  workspaces: IWorkspace[];
  groups: IWorkspaceGroup[];
  activeWorkspaceId?: string;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
}> => {
  const data = await readWorkspacesFile();
  if (!data) return { workspaces: [], groups: [], sidebarCollapsed: false, sidebarWidth: 220 };

  return {
    workspaces: data.workspaces,
    groups: data.groups ?? [],
    activeWorkspaceId: data.activeWorkspaceId,
    sidebarCollapsed: data.sidebarCollapsed,
    sidebarWidth: data.sidebarWidth,
  };
};

export const getActiveWorkspaceId = async (): Promise<string | null> => {
  const data = await readWorkspacesFile();
  if (data?.activeWorkspaceId && data.workspaces.some((w) => w.id === data.activeWorkspaceId)) {
    return data.activeWorkspaceId;
  }
  return data?.workspaces[0]?.id ?? null;
};

export const getWorkspaceById = async (wsId: string): Promise<IWorkspace | undefined> => {
  const data = await readWorkspacesFile();
  return data?.workspaces.find((w) => w.id === wsId);
};

export const createWorkspace = async (directory: string, name?: string, layoutOptions?: ICreateLayoutOptions, remote?: { hostId: string; remoteDirectory: string }): Promise<IWorkspace> =>
  withLock(async () => {
    if (remote) {
      if (!await getRemoteHost(remote.hostId)) throw new Error('Remote host not found');
      if (!remote.remoteDirectory.startsWith('/') || remote.remoteDirectory.includes('\n')) throw new Error('Remote directory must be absolute');
    }
    let stat;
    try {
      stat = await fs.stat(directory);
    } catch {
      throw new Error('Directory does not exist');
    }

    if (!stat.isDirectory()) {
      throw new Error('Please enter a directory path, not a file');
    }

    const data = (await readWorkspacesFile()) ?? emptyState();

    const wsId = `ws-${nanoid(6)}`;
    const wsName = name?.trim() || nextWorkspaceName(data.workspaces);

    const layout = await createDefaultLayout(wsId, directory, layoutOptions);
    await fs.mkdir(resolveLayoutDir(wsId), { recursive: true });
    await writeLayoutFile(layout, resolveLayoutFile(wsId));

    const workspace: IWorkspace = { id: wsId, name: wsName, directories: [directory], ...(remote ? { hostId: remote.hostId, remoteDirectory: remote.remoteDirectory } : {}) };
    if (remote) {
      const tab = collectAllTabs(layout.root)[0];
      if (tab) await sendKeys(tab.sessionName, await buildRemoteShellCommand(workspace));
    }
    data.workspaces.push(workspace);
    await writeWorkspacesFile(data);
    await writeWorkspacePrompts(workspace);

    log.debug(`Created: ${wsId} (${wsName}, ${directory})`);
    return workspace;
  });

export const deleteWorkspace = async (workspaceId: string): Promise<boolean> =>
  withLock(async () => {
    const data = (await readWorkspacesFile()) ?? emptyState();
    const idx = data.workspaces.findIndex((w) => w.id === workspaceId);
    if (idx === -1) return false;

    const ws = data.workspaces[idx];

    const layout = await readLayoutFile(resolveLayoutFile(workspaceId));
    if (layout) {
      const tabs = collectAllTabs(layout.root);
      for (const tab of tabs) {
        try {
          await killSession(tab.sessionName);
        } catch {}
      }
    }

    try {
      await removeLayoutFile(workspaceId);
    } catch {}

    data.workspaces.splice(idx, 1);

    await writeWorkspacesFile(data);
    log.info(`Deleted: ${workspaceId} (${ws.name})`);
    return true;
  });

export const renameWorkspace = async (workspaceId: string, name: string): Promise<IWorkspace | null> =>
  withLock(async () => {
    const data = await readWorkspacesFile();
    if (!data) return null;

    const ws = data.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return null;

    ws.name = name;
    await writeWorkspacesFile(data);
    await writeWorkspacePrompts(ws);

    log.debug(`Renamed: ${workspaceId} → "${name}"`);
    return { ...ws };
  });

export const updateActive = async (updates: {
  activeWorkspaceId?: string;
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
}): Promise<void> =>
  withLock(async () => {
    const data = (await readWorkspacesFile()) ?? emptyState();
    if (updates.activeWorkspaceId !== undefined) data.activeWorkspaceId = updates.activeWorkspaceId;
    if (updates.sidebarCollapsed !== undefined) data.sidebarCollapsed = updates.sidebarCollapsed;
    if (updates.sidebarWidth !== undefined) data.sidebarWidth = updates.sidebarWidth;
    await writeWorkspacesFile(data);
  });

export const updateWorkspaceDirectories = async (workspaceId: string, directories: string[]): Promise<void> =>
  withLock(async () => {
    const data = await readWorkspacesFile();
    if (!data) return;
    const ws = data.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    const current = JSON.stringify(ws.directories);
    if (current === JSON.stringify(directories)) return;
    ws.directories = directories;
    await writeWorkspacesFile(data);
    await writeWorkspacePrompts(ws);
  });

export interface IReorderItem {
  id: string;
  groupId?: string | null;
}

export const reorderWorkspaces = async (items: IReorderItem[]): Promise<boolean> =>
  withLock(async () => {
    const data = (await readWorkspacesFile()) ?? emptyState();
    const byId = new Map(data.workspaces.map((w) => [w.id, w]));
    const validGroupIds = new Set((data.groups ?? []).map((g) => g.id));

    const reordered: IWorkspace[] = [];
    for (const item of items) {
      const ws = byId.get(item.id);
      if (!ws) return false;
      if (item.groupId !== undefined) {
        ws.groupId = item.groupId && validGroupIds.has(item.groupId) ? item.groupId : null;
      }
      reordered.push(ws);
    }

    if (reordered.length !== data.workspaces.length) return false;

    data.workspaces = reordered;
    await writeWorkspacesFile(data);
    return true;
  });

export const createGroup = async (name: string): Promise<IWorkspaceGroup> =>
  withLock(async () => {
    const data = (await readWorkspacesFile()) ?? emptyState();
    const groups = ensureGroups(data);
    const trimmed = name.trim() || `Group ${groups.length + 1}`;
    const group: IWorkspaceGroup = {
      id: `grp-${nanoid(6)}`,
      name: trimmed,
      collapsed: false,
    };
    groups.push(group);
    await writeWorkspacesFile(data);
    log.debug(`Group created: ${group.id} (${group.name})`);
    return group;
  });

export const renameGroup = async (groupId: string, name: string): Promise<IWorkspaceGroup | null> =>
  withLock(async () => {
    const data = await readWorkspacesFile();
    if (!data) return null;
    const group = (data.groups ?? []).find((g) => g.id === groupId);
    if (!group) return null;
    const trimmed = name.trim();
    if (!trimmed) return group;
    group.name = trimmed;
    await writeWorkspacesFile(data);
    return { ...group };
  });

export const setGroupCollapsed = async (groupId: string, collapsed: boolean): Promise<boolean> =>
  withLock(async () => {
    const data = await readWorkspacesFile();
    if (!data) return false;
    const group = (data.groups ?? []).find((g) => g.id === groupId);
    if (!group) return false;
    if (group.collapsed === collapsed) return true;
    group.collapsed = collapsed;
    await writeWorkspacesFile(data);
    return true;
  });

export const ungroupGroup = async (groupId: string): Promise<boolean> =>
  withLock(async () => {
    const data = await readWorkspacesFile();
    if (!data) return false;
    const groups = ensureGroups(data);
    const idx = groups.findIndex((g) => g.id === groupId);
    if (idx === -1) return false;
    for (const ws of data.workspaces) {
      if (ws.groupId === groupId) ws.groupId = null;
    }
    groups.splice(idx, 1);
    await writeWorkspacesFile(data);
    log.info(`Group ungrouped: ${groupId}`);
    return true;
  });

export const reorderGroups = async (groupIds: string[]): Promise<boolean> =>
  withLock(async () => {
    const data = await readWorkspacesFile();
    if (!data) return false;
    const groups = ensureGroups(data);
    const byId = new Map(groups.map((g) => [g.id, g]));
    const reordered: IWorkspaceGroup[] = [];
    for (const id of groupIds) {
      const g = byId.get(id);
      if (!g) return false;
      reordered.push(g);
    }
    if (reordered.length !== groups.length) return false;
    data.groups = reordered;
    await writeWorkspacesFile(data);
    return true;
  });

export const setWorkspaceGroup = async (workspaceId: string, groupId: string | null): Promise<boolean> =>
  withLock(async () => {
    const data = await readWorkspacesFile();
    if (!data) return false;
    const ws = data.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return false;
    const validGroupIds = new Set((data.groups ?? []).map((g) => g.id));
    const nextGroupId = groupId && validGroupIds.has(groupId) ? groupId : null;
    if ((ws.groupId ?? null) === nextGroupId) return true;
    ws.groupId = nextGroupId;
    await writeWorkspacesFile(data);
    return true;
  });

export const validateDirectory = async (directory: string): Promise<{
  valid: boolean;
  error?: string;
  suggestedName?: string;
}> => {
  try {
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) {
      return { valid: false, error: 'Please enter a directory path, not a file' };
    }
  } catch {
    return { valid: false, error: 'Directory does not exist' };
  }

  return { valid: true, suggestedName: path.basename(directory) };
};
