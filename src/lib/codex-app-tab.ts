import { getWorkspaceById } from '@/lib/workspace-store';
import { readLayoutFile, resolveLayoutFile, collectAllTabs } from '@/lib/layout-store';
import type { IWorkspace, ITab } from '@/types/terminal';

const ID_RE = /^[a-zA-Z0-9_-]{1,120}$/;

export const resolveCodexAppTab = async (
  workspaceId: unknown,
  tabId: unknown,
): Promise<{ workspace: IWorkspace; tab: ITab }> => {
  if (typeof workspaceId !== 'string' || typeof tabId !== 'string' ||
      !ID_RE.test(workspaceId) || !ID_RE.test(tabId)) {
    throw new Error('Invalid workspace or tab ID');
  }
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) throw new Error('Workspace not found');
  const layout = await readLayoutFile(resolveLayoutFile(workspaceId));
  const tab = layout ? collectAllTabs(layout.root).find((value) => value.id === tabId) : null;
  if (!tab || tab.panelType !== 'codex-chat') {
    throw new Error('Codex Chat tab not found');
  }
  return { workspace, tab };
};
