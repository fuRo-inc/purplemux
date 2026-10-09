import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { nanoid } from 'nanoid';
import { createSession, hasSession, killSession, resolveExistingDir, sendKeys, workspaceSessionName } from '@/lib/tmux';
import { getWorkspaceById } from '@/lib/workspace-store';
import { buildRemoteShellCommand } from '@/lib/remote-workspace';
import { broadcastSync } from '@/lib/sync-server';
import { createLogger } from '@/lib/logger';
import {
  collectPanes,
  collectAllTabs,
  findPane,
  replacePane,
  removePaneWithFocus,
  updateRatioAtPath,
  equalizeNode,
  isEqualized,
} from '@/lib/layout-tree';
import type { ITab, TLayoutNode, IPaneNode, ILayoutData, TPanelType, IDiffSettings } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';
import type { IAgentProvider } from '@/lib/providers/types';
import { claudeProvider } from '@/lib/providers/claude';
import { defaultTabNameForPanelType, resolveTabNameForPanelTypeChange } from '@/lib/tab-name';

const log = createLogger('layout');

const BASE_DIR = path.join(os.homedir(), '.purplemux');

interface ILayoutReconciler {
  reconcileWorkspaceTabs: (wsId: string, validTabIds: readonly string[]) => void;
  removeWorkspaceTabs: (wsId: string) => void;
}

const g = globalThis as unknown as {
  __ptLayoutLock?: Promise<void>;
  __ptLayoutContentCache?: Map<string, string>;
  __ptLayoutReconciler?: ILayoutReconciler | null;
};
if (!g.__ptLayoutLock) g.__ptLayoutLock = Promise.resolve();
if (!g.__ptLayoutContentCache) g.__ptLayoutContentCache = new Map();
if (g.__ptLayoutReconciler === undefined) g.__ptLayoutReconciler = null;

export const setLayoutReconciler = (reconciler: ILayoutReconciler | null): void => {
  g.__ptLayoutReconciler = reconciler;
};

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = g.__ptLayoutLock!;
  g.__ptLayoutLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

export const generatePaneId = (): string => `pane-${nanoid(6)}`;
export const generateTabId = (): string => `tab-${nanoid(6)}`;

export const resolveLayoutDir = (wsId: string): string =>
  path.join(BASE_DIR, 'workspaces', wsId);

export const resolveLayoutFile = (wsId: string): string =>
  path.join(resolveLayoutDir(wsId), 'layout.json');

const createDefaultTab = (wsId: string, paneId: string, order = 0, cwd?: string): ITab => {
  const tabId = generateTabId();
  const tab: ITab = {
    id: tabId,
    sessionName: workspaceSessionName(wsId, paneId, tabId),
    name: '',
    order,
  };
  if (cwd) tab.cwd = cwd;
  return tab;
};

const createDefaultPaneNode = (wsId: string, cwd?: string): { pane: IPaneNode; tab: ITab } => {
  const paneId = generatePaneId();
  const tab = createDefaultTab(wsId, paneId, 0, cwd);
  return {
    pane: { type: 'pane', id: paneId, tabs: [tab], activeTabId: tab.id },
    tab,
  };
};

export const readLayoutFile = async (filePath: string): Promise<ILayoutData | null> => {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  try {
    return JSON.parse(raw) as ILayoutData;
  } catch {
    log.warn(`${filePath} parse failed`);
    try {
      await fs.copyFile(filePath, filePath.replace(/\.json$/, '.json.bak'));
    } catch {}
    return null;
  }
};

const extractWsIdFromPath = (filePath: string): string | null => {
  const match = filePath.match(/workspaces\/(ws-[^/]+)\//);
  return match?.[1] ?? null;
};

export const writeLayoutFile = async (data: ILayoutData, filePath: string): Promise<void> => {
  const contentKey = JSON.stringify({ root: data.root, activePaneId: data.activePaneId, diffSettings: data.diffSettings });
  const cache = g.__ptLayoutContentCache!;

  if (cache.get(filePath) === contentKey) return;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpFile = filePath + '.tmp';
  try {
    await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmpFile, filePath);
  } catch (err) {
    await fs.unlink(tmpFile).catch(() => {});
    throw err;
  }

  cache.set(filePath, contentKey);

  const wsId = extractWsIdFromPath(filePath);
  if (wsId) {
    const reconciler = g.__ptLayoutReconciler;
    if (reconciler) {
      const validTabIds = collectAllTabs(data.root).map((t) => t.id);
      reconciler.reconcileWorkspaceTabs(wsId, validTabIds);
    }
    broadcastSync({ type: 'layout', workspaceId: wsId });
  }
};

export const removeLayoutFile = async (wsId: string): Promise<void> => {
  await fs.rm(resolveLayoutDir(wsId), { recursive: true, force: true });
  clearLayoutCache(wsId);
  const reconciler = g.__ptLayoutReconciler;
  if (reconciler) {
    reconciler.removeWorkspaceTabs(wsId);
  }
  broadcastSync({ type: 'layout', workspaceId: wsId });
};

export const clearLayoutCache = (wsId: string): void => {
  const filePath = resolveLayoutFile(wsId);
  g.__ptLayoutContentCache!.delete(filePath);
};

export { collectPanes, collectAllTabs, normalizeTree } from '@/lib/layout-tree';

const syncWorkspaceDirectories = (wsId: string, root: TLayoutNode): void => {
  const cwds = [...new Set(
    collectAllTabs(root)
      .map((t) => t.cwd)
      .filter((c): c is string => !!c),
  )];
  if (cwds.length > 0) {
    import('@/lib/workspace-store').then(({ updateWorkspaceDirectories }) => {
      updateWorkspaceDirectories(wsId, cwds).catch(() => {});
    }).catch(() => {});
  }
};

const isAgentPanelType = (panelType: TPanelType | undefined): boolean =>
  panelType === 'claude-code' || panelType === 'codex-cli';

export const crossCheckLayout = async (
  layout: ILayoutData,
  tmuxSessions: string[],
  wsId: string,
  defaultCwd?: string,
): Promise<boolean> => {
  let changed = false;
  const tmuxSet = new Set(tmuxSessions);
  const panes = collectPanes(layout.root);
  const layoutSessions = new Set<string>();

  for (const pane of panes) {
    for (const tab of pane.tabs) {
      if (tab.panelType === 'web-browser') continue;
      layoutSessions.add(tab.sessionName);

      if (!tmuxSet.has(tab.sessionName) && isAgentPanelType(tab.panelType)) {
        const cwd = tab.cwd || defaultCwd;
        log.debug(`crossCheck: agent tab session recreated: ${tab.sessionName} (cwd: ${cwd})`);
        await createSession(tab.sessionName, 80, 24, cwd);
        changed = true;
      }
    }
  }

  const orphans = tmuxSessions.filter((s) => !layoutSessions.has(s));
  if (orphans.length > 0) {
    changed = true;
    const firstPane = panes[0];
    if (firstPane) {
      let maxOrder = firstPane.tabs.length > 0 ? Math.max(...firstPane.tabs.map((t) => t.order)) : -1;
      for (const sessionName of orphans) {
        maxOrder++;
        firstPane.tabs.push({
          id: generateTabId(),
          sessionName,
          name: '',
          order: maxOrder,
        });
      }
      if (!firstPane.activeTabId && firstPane.tabs.length > 0) {
        firstPane.activeTabId = firstPane.tabs[0].id;
      }
    }
  }

  if (changed) {
    layout.updatedAt = new Date().toISOString();
    const finalPanes = collectPanes(layout.root);
    if (layout.activePaneId && !finalPanes.some((p) => p.id === layout.activePaneId)) {
      layout.activePaneId = finalPanes[0]?.id ?? null;
    }
  }

  return changed;
};

export interface ICreateLayoutOptions {
  panelType?: TPanelType;
}

export const createDefaultLayout = async (wsId: string, cwd: string, options?: ICreateLayoutOptions): Promise<ILayoutData> => {
  const { pane, tab } = createDefaultPaneNode(wsId, cwd);
  if (options?.panelType) tab.panelType = options.panelType;
  await createSession(tab.sessionName, 80, 24, cwd);
  return {
    root: pane,
    activePaneId: pane.id,
    updatedAt: new Date().toISOString(),
  };
};

export const getLayout = async (wsId: string, defaultCwd?: string): Promise<ILayoutData> =>
  withLock(async () => {
    const filePath = resolveLayoutFile(wsId);
    const existing = await readLayoutFile(filePath);
    if (existing) return existing;

    const { pane, tab } = createDefaultPaneNode(wsId, defaultCwd);
    await createSession(tab.sessionName, 80, 24, defaultCwd);

    const layout: ILayoutData = {
      root: pane,
      activePaneId: pane.id,
      updatedAt: new Date().toISOString(),
    };
    await writeLayoutFile(layout, filePath);
    return layout;
  });

export const createPane = async (wsId: string, cwd?: string): Promise<{ paneId: string; tab: ITab }> => {
  const paneId = generatePaneId();
  const tabId = generateTabId();
  const sessionName = workspaceSessionName(wsId, paneId, tabId);

  await createSession(sessionName, 80, 24, cwd);

  const tab: ITab = { id: tabId, sessionName, name: '', order: 0, ...(cwd ? { cwd } : {}) };
  return { paneId, tab };
};

export const deletePane = async (
  paneId: string,
  sessions: string[] = [],
): Promise<void> => {
  for (const session of sessions) {
    try {
      await killSession(session);
    } catch {
      // session already gone
    }
  }
};

export const addTabToPane = async (wsId: string, paneId: string, name?: string, cwd?: string, panelType?: string, command?: string): Promise<ITab | null> =>
  withLock(async () => {
    const filePath = resolveLayoutFile(wsId);
    const layout = await readLayoutFile(filePath);
    if (!layout) return null;

    const pane = collectPanes(layout.root).find((p) => p.id === paneId);
    if (!pane) return null;

    const isWebBrowser = panelType === 'web-browser';
    const tabId = generateTabId();
    const sessionName = workspaceSessionName(wsId, paneId, tabId);
    if (!isWebBrowser) {
      const workspace = await getWorkspaceById(wsId);
      if (workspace?.hostId) {
        if (panelType && panelType !== 'terminal' && panelType !== 'codex-cli') {
          throw new Error('Remote workspace supports Terminal and Codex only');
        }
        await createSession(sessionName, 80, 24, undefined);
        await sendKeys(sessionName, await buildRemoteShellCommand(workspace, panelType === 'codex-cli' || command === 'remote-codex' ? 'codex' : undefined));
      } else {
        await createSession(sessionName, 80, 24, cwd);
        if (command) {
          await sendKeys(sessionName, command);
        }
      }
    }

    const nextOrder = pane.tabs.length > 0 ? Math.max(...pane.tabs.map((t) => t.order)) + 1 : 0;
    const defaultName = defaultTabNameForPanelType(panelType as ITab['panelType']);
    const tabName = name?.trim() || defaultName;
    const tab: ITab = { id: tabId, sessionName, name: tabName, order: nextOrder, ...(cwd ? { cwd } : {}), ...(panelType ? { panelType: panelType as ITab['panelType'] } : {}) };

    pane.tabs.push(tab);
    pane.activeTabId = tabId;
    layout.updatedAt = new Date().toISOString();
    await writeLayoutFile(layout, filePath);
    syncWorkspaceDirectories(wsId,layout.root);

    return tab;
  });

export const removeTabFromPane = async (wsId: string, paneId: string, tabId: string): Promise<boolean> => {
  const tabInfo = await withLock(async () => {
    const filePath = resolveLayoutFile(wsId);
    const layout = await readLayoutFile(filePath);
    if (!layout) return null;

    const pane = collectPanes(layout.root).find((p) => p.id === paneId);
    if (!pane) return null;

    const tab = pane.tabs.find((t) => t.id === tabId);
    if (!tab) return null;
    return { sessionName: tab.sessionName, panelType: tab.panelType };
  });

  if (!tabInfo) return false;

  if (tabInfo.panelType !== 'web-browser') {
    await killSession(tabInfo.sessionName);
  }

  return withLock(async () => {
    const filePath = resolveLayoutFile(wsId);
    const layout = await readLayoutFile(filePath);
    if (!layout) return false;

    const pane = collectPanes(layout.root).find((p) => p.id === paneId);
    if (!pane) return false;

    const idx = pane.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return false;

    pane.tabs.splice(idx, 1);

    if (pane.activeTabId === tabId) {
      pane.activeTabId = pane.tabs[0]?.id ?? null;
    }

    if (pane.tabs.length === 0 && collectPanes(layout.root).length > 1) {
      removePaneWithFocus(layout, paneId);
    }

    pane.tabs.forEach((t, i) => { t.order = i; });
    layout.updatedAt = new Date().toISOString();
    await writeLayoutFile(layout, filePath);
    syncWorkspaceDirectories(wsId, layout.root);

    return true;
  });
};

export const renameTabInPane = async (wsId: string, paneId: string, tabId: string, name: string): Promise<ITab | null> =>
  withLock(async () => {
    const filePath = resolveLayoutFile(wsId);
    const layout = await readLayoutFile(filePath);
    if (!layout) return null;

    const pane = collectPanes(layout.root).find((p) => p.id === paneId);
    if (!pane) return null;

    const tab = pane.tabs.find((t) => t.id === tabId);
    if (!tab) return null;

    tab.name = name;
    layout.updatedAt = new Date().toISOString();
    await writeLayoutFile(layout, filePath);

    return { ...tab };
  });

export const restartTabSession = async (wsId: string, paneId: string, tabId: string, command?: string): Promise<boolean> =>
  withLock(async () => {
    const filePath = resolveLayoutFile(wsId);
    const layout = await readLayoutFile(filePath);
    if (!layout) return false;

    const pane = collectPanes(layout.root).find((p) => p.id === paneId);
    if (!pane) return false;

    const tab = pane.tabs.find((t) => t.id === tabId);
    if (!tab) return false;

    const exists = await hasSession(tab.sessionName);
    if (exists) return true;

    const effectiveCwd = await resolveExistingDir(tab.cwd);
    const cwdLost = Boolean(tab.cwd && tab.cwd !== effectiveCwd);

    await createSession(tab.sessionName, 80, 24, effectiveCwd);
    if (command && !cwdLost) {
      await sendKeys(tab.sessionName, command);
    }

    if (cwdLost) {
      log.warn(`tab cwd missing, falling back to ${effectiveCwd}: ${tab.sessionName} (was ${tab.cwd})`);
      tab.cwd = effectiveCwd;
      delete tab.lastCommand;
      layout.updatedAt = new Date().toISOString();
      await writeLayoutFile(layout, filePath);
    }
    return true;
  });

export const reconcileTabCwd = async (sessionName: string): Promise<void> =>
  withLock(async () => {
    const parsed = parseSessionName(sessionName);
    if (!parsed) return;

    const filePath = resolveLayoutFile(parsed.wsId);
    const layout = await readLayoutFile(filePath);
    if (!layout) return;

    const pane = collectPanes(layout.root).find((p) => p.id === parsed.paneId);
    if (!pane) return;
    const tab = pane.tabs.find((t) => t.id === parsed.tabId);
    if (!tab || !tab.cwd) return;

    const effectiveCwd = await resolveExistingDir(tab.cwd);
    if (effectiveCwd === tab.cwd) return;

    log.warn(`tab cwd missing, clearing: ${sessionName} (was ${tab.cwd})`);
    tab.cwd = effectiveCwd;
    delete tab.lastCommand;
    layout.updatedAt = new Date().toISOString();
    await writeLayoutFile(layout, filePath);
  });

export const getFirstPaneTabs = async (wsId: string): Promise<{ tabs: ITab[]; activeTabId: string | null }> =>
  withLock(async () => {
    const layout = await readLayoutFile(resolveLayoutFile(wsId));
    if (!layout) return { tabs: [], activeTabId: null };
    const first = collectPanes(layout.root)[0];
    if (!first) return { tabs: [], activeTabId: null };
    return {
      tabs: [...first.tabs].sort((a, b) => a.order - b.order),
      activeTabId: first.activeTabId,
    };
  });

export const parseSessionName = (sessionName: string): { wsId: string; paneId: string; tabId: string } | null => {
  const match = sessionName.match(/^pt-(ws-.*?)-(pane-.*?)-(tab-.+)$/);
  if (!match) return null;
  return { wsId: match[1], paneId: match[2], tabId: match[3] };
};

const mutateTab = async (
  sessionName: string,
  mutator: (tab: ITab) => boolean,
): Promise<void> => {
  const parsed = parseSessionName(sessionName);
  if (!parsed) return;

  await withLock(async () => {
    const filePath = resolveLayoutFile(parsed.wsId);
    const layout = await readLayoutFile(filePath);
    if (!layout) return;

    const tab = collectAllTabs(layout.root).find((t) => t.sessionName === sessionName);
    if (!tab) return;
    if (!mutator(tab)) return;

    layout.updatedAt = new Date().toISOString();
    await writeLayoutFile(layout, filePath);
  });
};

export const updateTabAgentSessionId = (
  sessionName: string,
  provider: IAgentProvider,
  sessionId: string | null,
): Promise<void> =>
  mutateTab(sessionName, (tab) => {
    if (provider.readSessionId(tab) === sessionId) return false;
    provider.writeSessionId(tab, sessionId);
    return true;
  });

export const updateTabAgentSummary = (
  sessionName: string,
  provider: IAgentProvider,
  summary: string | null,
): Promise<void> =>
  mutateTab(sessionName, (tab) => {
    if (provider.readSummary(tab) === summary) return false;
    provider.writeSummary(tab, summary);
    return true;
  });

export const updateTabAgentState = (
  sessionName: string,
  provider: IAgentProvider,
  state: {
    sessionId?: string | null;
    jsonlPath?: string | null;
    summary?: string | null;
    lastUserMessage?: string | null;
  },
): Promise<void> =>
  mutateTab(sessionName, (tab) => {
    let changed = false;
    if (state.sessionId !== undefined && provider.readSessionId(tab) !== state.sessionId) {
      provider.writeSessionId(tab, state.sessionId);
      changed = true;
    }
    if (state.jsonlPath !== undefined && provider.readJsonlPath(tab) !== state.jsonlPath) {
      provider.writeJsonlPath(tab, state.jsonlPath);
      changed = true;
    }
    if (state.summary !== undefined && provider.readSummary(tab) !== state.summary) {
      provider.writeSummary(tab, state.summary);
      changed = true;
    }
    if (state.lastUserMessage !== undefined && tab.lastUserMessage !== state.lastUserMessage) {
      tab.lastUserMessage = state.lastUserMessage;
      changed = true;
    }
    return changed;
  });

export const updateTabClaudeSessionId = (
  sessionName: string,
  claudeSessionId: string | null,
): Promise<void> => updateTabAgentSessionId(sessionName, claudeProvider, claudeSessionId);

export const updateTabClaudeSummary = (
  sessionName: string,
  claudeSummary: string | null,
): Promise<void> => updateTabAgentSummary(sessionName, claudeProvider, claudeSummary);

export const updateTabLastUserMessage = (
  sessionName: string,
  lastUserMessage: string | null,
): Promise<void> =>
  mutateTab(sessionName, (tab) => {
    if (tab.lastUserMessage === lastUserMessage) return false;
    tab.lastUserMessage = lastUserMessage;
    return true;
  });

export const updateTabCliStatus = (
  sessionName: string,
  cliState: TCliState,
  dismissedAt?: number | null,
): Promise<void> =>
  mutateTab(sessionName, (tab) => {
    if (tab.cliState === cliState && tab.dismissedAt === dismissedAt) return false;
    tab.cliState = cliState;
    tab.dismissedAt = dismissedAt;
    return true;
  });

const mutate = async (
  wsId: string,
  fn: (layout: ILayoutData) => ILayoutData | null,
): Promise<ILayoutData | null> =>
  withLock(async () => {
    const filePath = resolveLayoutFile(wsId);
    const layout = await readLayoutFile(filePath);
    if (!layout) return null;

    const result = fn(layout);
    if (!result) return null;

    result.updatedAt = new Date().toISOString();
    await writeLayoutFile(result, filePath);
    syncWorkspaceDirectories(wsId, result.root);
    return result;
  });

export const patchLayout = async (
  wsId: string,
  patch: { activePaneId?: string; ratioUpdate?: { path: number[]; ratio: number }; equalize?: boolean; diffSettings?: Partial<IDiffSettings> },
): Promise<ILayoutData | null> =>
  mutate(wsId, (layout) => {
    if (patch.activePaneId !== undefined) {
      const pane = findPane(layout.root, patch.activePaneId);
      if (!pane) return null;
      layout.activePaneId = patch.activePaneId;
    }
    if (patch.ratioUpdate) {
      layout.root = updateRatioAtPath(layout.root, patch.ratioUpdate.path, patch.ratioUpdate.ratio);
    }
    if (patch.equalize) {
      layout.root = equalizeNode(layout.root);
    }
    if (patch.diffSettings) {
      layout.diffSettings = {
        ...(layout.diffSettings ?? {}),
        ...patch.diffSettings,
      };
    }
    return layout;
  });

export const patchPane = async (
  wsId: string,
  paneId: string,
  patch: { activeTabId?: string },
): Promise<ILayoutData | null> =>
  mutate(wsId, (layout) => {
    const pane = findPane(layout.root, paneId);
    if (!pane) return null;
    if (patch.activeTabId !== undefined) {
      if (!pane.tabs.some((t) => t.id === patch.activeTabId)) return null;
      pane.activeTabId = patch.activeTabId;
    }
    return layout;
  });

export const splitPaneInLayout = async (
  wsId: string,
  sourcePaneId: string,
  orientation: 'horizontal' | 'vertical',
  cwd?: string,
  panelType?: string,
): Promise<ILayoutData | null> => {
  const isWebBrowser = panelType === 'web-browser';
  const paneId = generatePaneId();
  const tabId = generateTabId();
  const sessionName = workspaceSessionName(wsId, paneId, tabId);

  if (!isWebBrowser) {
    await createSession(sessionName, 80, 24, cwd);
  }

  const defaultName = defaultTabNameForPanelType(panelType as ITab['panelType']);
  const tab: ITab = { id: tabId, sessionName, name: defaultName, order: 0, ...(cwd ? { cwd } : {}) };
  if (panelType) tab.panelType = panelType as ITab['panelType'];

  const newPane: IPaneNode = { type: 'pane', id: paneId, tabs: [tab], activeTabId: tabId };

  const result = await mutate(wsId, (layout) => {
    const existing = findPane(layout.root, sourcePaneId);
    if (!existing) return null;
    const wasEqualized = isEqualized(layout.root);
    if (cwd) {
      const activeTab = existing.tabs.find((t) => t.id === existing.activeTabId);
      if (activeTab) activeTab.cwd = cwd;
    }
    const splitNode: TLayoutNode = {
      type: 'split',
      orientation,
      ratio: 50,
      children: [{ ...existing }, newPane],
    };
    layout.root = replacePane(layout.root, sourcePaneId, splitNode);
    if (wasEqualized) {
      layout.root = equalizeNode(layout.root);
    }
    layout.activePaneId = paneId;
    return layout;
  });

  if (!result && !isWebBrowser) {
    await killSession(sessionName).catch(() => {});
  }

  return result;
};

export const closePaneInLayout = async (wsId: string, paneId: string): Promise<ILayoutData | null> => {
  let sessions: string[] = [];

  const result = await withLock(async () => {
    const filePath = resolveLayoutFile(wsId);
    const layout = await readLayoutFile(filePath);
    if (!layout) return null;

    const pane = findPane(layout.root, paneId);
    if (!pane) return null;
    if (collectPanes(layout.root).length <= 1) return null;

    sessions = pane.tabs.filter((t) => t.panelType !== 'web-browser').map((t) => t.sessionName);
    const wasEqualized = isEqualized(layout.root);
    removePaneWithFocus(layout, paneId);
    if (wasEqualized) {
      layout.root = equalizeNode(layout.root);
    }
    layout.updatedAt = new Date().toISOString();
    await writeLayoutFile(layout, filePath);
    syncWorkspaceDirectories(wsId, layout.root);
    return layout;
  });

  await Promise.all(sessions.map((s) => killSession(s).catch(() => {})));

  return result;
};

export const reorderTabsInPane = async (
  wsId: string,
  paneId: string,
  tabIds: string[],
): Promise<ILayoutData | null> =>
  mutate(wsId, (layout) => {
    const pane = findPane(layout.root, paneId);
    if (!pane) return null;
    const tabMap = new Map(pane.tabs.map((t) => [t.id, t]));
    const reordered = tabIds
      .map((id, i) => {
        const t = tabMap.get(id);
        return t ? { ...t, order: i } : null;
      })
      .filter((t): t is ITab => t !== null);
    if (reordered.length !== pane.tabs.length) return null;
    pane.tabs = reordered;
    return layout;
  });

export const moveTabBetweenPanes = async (
  wsId: string,
  tabId: string,
  fromPaneId: string,
  toPaneId: string,
  toIndex: number,
): Promise<ILayoutData | null> => {
  return mutate(wsId, (layout) => {
    const fromPane = findPane(layout.root, fromPaneId);
    const toPane = findPane(layout.root, toPaneId);
    if (!fromPane || !toPane) return null;

    const tabIdx = fromPane.tabs.findIndex((t) => t.id === tabId);
    if (tabIdx === -1) return null;

    const [tab] = fromPane.tabs.splice(tabIdx, 1);
    if (fromPane.activeTabId === tabId) {
      fromPane.activeTabId = fromPane.tabs[0]?.id ?? null;
    }
    fromPane.tabs.forEach((t, i) => { t.order = i; });

    toPane.tabs.splice(toIndex, 0, tab);
    toPane.tabs.forEach((t, i) => { t.order = i; });
    toPane.activeTabId = tabId;

    if (fromPane.tabs.length === 0 && collectPanes(layout.root).length > 1) {
      removePaneWithFocus(layout, fromPaneId);
    }

    layout.activePaneId = toPaneId;
    return layout;
  });
};

export const patchTab = async (
  wsId: string,
  paneId: string,
  tabId: string,
  patch: Partial<Pick<ITab, 'name' | 'panelType' | 'title' | 'cwd' | 'lastCommand' | 'webUrl' | 'terminalRatio' | 'terminalCollapsed'>>,
): Promise<ILayoutData | null> => {
  let authoritativeCwd: string | null | undefined;
  let authoritativeTitle: string | null | undefined;
  if (patch.cwd !== undefined || patch.title !== undefined) {
    const tabInfo = await (async () => {
      const filePath = resolveLayoutFile(wsId);
      const layout = await readLayoutFile(filePath);
      if (!layout) return null;
      const tab = findPane(layout.root, paneId)?.tabs.find((t) => t.id === tabId);
      return tab ? { sessionName: tab.sessionName, panelType: patch.panelType ?? tab.panelType } : null;
    })();
    if (tabInfo?.sessionName) {
      const { getSessionCwd, getPaneCurrentCommand } = await import('@/lib/tmux');
      const { formatTabTitle } = await import('@/lib/tab-title');
      if (patch.cwd !== undefined) {
        authoritativeCwd = await getSessionCwd(tabInfo.sessionName);
      }
      if (patch.title !== undefined) {
        const [cmd, cwd] = await Promise.all([
          getPaneCurrentCommand(tabInfo.sessionName),
          authoritativeCwd !== undefined ? Promise.resolve(authoritativeCwd) : getSessionCwd(tabInfo.sessionName),
        ]);
        if (cmd && cwd) {
          authoritativeTitle = formatTabTitle(`${cmd}|${cwd}`, tabInfo.panelType);
        }
      }
    }
  }

  return mutate(wsId, (layout) => {
    const pane = findPane(layout.root, paneId);
    if (!pane) return null;
    const tab = pane.tabs.find((t) => t.id === tabId);
    if (!tab) return null;
    const resolvedTitle = patch.title !== undefined ? (authoritativeTitle ?? patch.title) : undefined;
    if (patch.name !== undefined) tab.name = patch.name;
    if (patch.panelType !== undefined) {
      if (patch.name === undefined) {
        tab.name = resolveTabNameForPanelTypeChange(tab.name, tab.panelType, patch.panelType);
      }
      tab.panelType = patch.panelType;
    }
    if (resolvedTitle !== undefined) tab.title = resolvedTitle;
    if (patch.cwd !== undefined) tab.cwd = authoritativeCwd ?? patch.cwd;
    if (patch.lastCommand !== undefined) tab.lastCommand = patch.lastCommand;
    if (patch.webUrl !== undefined) tab.webUrl = patch.webUrl;
    if (patch.terminalRatio !== undefined) tab.terminalRatio = patch.terminalRatio;
    if (patch.terminalCollapsed !== undefined) tab.terminalCollapsed = patch.terminalCollapsed;
    return layout;
  });
};
