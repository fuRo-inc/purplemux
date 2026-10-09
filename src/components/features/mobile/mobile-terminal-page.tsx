import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { AlertTriangle, RefreshCw, Monitor, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Spinner from '@/components/ui/spinner';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import useLayout, { collectPanes } from '@/hooks/use-layout';
import useWorkspaceStore from '@/hooks/use-workspace-store';
import useTabMetadataStore from '@/hooks/use-tab-metadata-store';
import type { ITabMetadata } from '@/hooks/use-tab-metadata-store';
import type { TPanelType } from '@/types/terminal';
import MobileTabHeader from '@/components/features/mobile/mobile-tab-header';
import MobileSurfaceView from '@/components/features/mobile/mobile-surface-view';
import MobileNewTabDialog from '@/components/features/mobile/mobile-new-tab-dialog';
import MobileGitFullscreen from '@/components/features/mobile/mobile-git-fullscreen';
import { formatTabTitle } from '@/lib/tab-title';
import { dismissTab } from '@/hooks/use-agent-status';
import useTabStore from '@/hooks/use-tab-store';
import type { TCliState } from '@/types/timeline';
import useConfigStore, { type TGitAskProvider } from '@/hooks/use-config-store';
import useMobileLayoutActions from '@/hooks/use-mobile-layout-actions';
import { useAutoDeleteEmptyWorkspace } from '@/hooks/use-auto-delete-empty-workspace';
import { useAgentInstallCheck } from '@/hooks/use-agent-install-check';
import { buildClaudeLaunchCommand } from '@/lib/providers/claude/client';
import { fetchCodexLaunchCommand } from '@/lib/providers/codex/client';

const MobileTerminalPage = () => {
  const t = useTranslations('terminal');
  const tm = useTranslations('mobile');
  const tc = useTranslations('common');
  const { ensureAgentInstalled, installDialogs } = useAgentInstallCheck();
  const isLoading = useWorkspaceStore((s) => s.isLoading);
  const error = useWorkspaceStore((s) => s.error);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const workspaceCount = workspaces.length;
  const prevWorkspaceIdRef = useRef<string | null>(null);

  const handleFetchError = useCallback(() => {
    const prevId = prevWorkspaceIdRef.current;
    if (prevId) {
      useWorkspaceStore.getState().switchWorkspace(prevId);
      toast.error(t('cannotSwitch'));
    }
  }, [t]);

  const layout = useLayout({
    workspaceId: activeWorkspaceId,
    onFetchError: handleFetchError,
  });

  const panes = useMemo(() => {
    if (!layout.layout) return [];
    return collectPanes(layout.layout.root);
  }, [layout.layout]);

  const allTabsEmpty = !!(
    layout.layout &&
    !layout.isLoading &&
    panes.every((p) => p.tabs.length === 0)
  );

  const layoutUpdatedAt = layout.layout?.updatedAt;
  const hydratedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!layout.layout || !layoutUpdatedAt) return;
    if (hydratedRef.current === layoutUpdatedAt) return;
    hydratedRef.current = layoutUpdatedAt;
    const metadata: Record<string, ITabMetadata> = {};
    for (const pane of collectPanes(layout.layout.root)) {
      for (const tab of pane.tabs) {
        if (tab.panelType === 'agent-sessions') continue;
        if (tab.title || tab.cwd) {
          metadata[tab.id] = { title: tab.title, cwd: tab.cwd };
        }
      }
    }
    useTabMetadataStore.getState().hydrate(metadata);
  }, [layoutUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!layout.layout) return;
    const allTabIds = new Set(
      collectPanes(layout.layout.root).flatMap((p) => p.tabs.map((t) => t.id)),
    );
    useTabMetadataStore.getState().retainOnly(allTabIds);
  }, [layout.layout]);

  useAutoDeleteEmptyWorkspace(allTabsEmpty, layout.clearLayout);

  // Derive active pane/tab from layout store (same as desktop)
  const activePaneId = layout.layout?.activePaneId ?? null;
  const currentPane = (activePaneId ? panes.find((p) => p.id === activePaneId) : null) ?? panes[0] ?? null;
  const selectedPaneId = currentPane?.id ?? null;
  const selectedTabId = currentPane?.activeTabId ?? null;
  const currentTab = currentPane?.tabs.find((t) => t.id === selectedTabId) ?? null;
  const currentPanelType: TPanelType = currentTab?.panelType ?? 'terminal';

  const handleSelectWorkspace = useCallback(
    (workspaceId: string) => {
      const { activeWorkspaceId: currentId } = useWorkspaceStore.getState();
      if (workspaceId === currentId) return;

      prevWorkspaceIdRef.current = currentId;
      useTabMetadataStore.getState().reset();
      layout.clearLayout();
      useWorkspaceStore.getState().switchWorkspace(workspaceId);
    },
    [layout],
  );

  useEffect(() => {
    useMobileLayoutActions.getState().register({
      onSelectWorkspace: handleSelectWorkspace,
    });
    return () => useMobileLayoutActions.getState().unregister();
  }, [handleSelectWorkspace]);

  const [newTabDialogOpen, setNewTabDialogOpen] = useState(false);
  const [claudeCliState, setClaudeCliState] = useState<TCliState>('inactive');
  const [gitOpen, setGitOpen] = useState(false);
  const [gitTarget, setGitTarget] = useState<{ sessionName: string; cwdKey: string } | null>(null);

  const handleCliStateChange = useCallback((state: TCliState) => {
    setClaudeCliState(state);
  }, []);

  useEffect(() => {
    if (selectedTabId) dismissTab(selectedTabId);
  }, [selectedTabId]);

  useEffect(() => {
    if (!selectedTabId || currentPanelType !== 'claude-code' || claudeCliState === 'inactive') return;
    if (claudeCliState === 'idle') {
      dismissTab(selectedTabId);
    }
  }, [selectedTabId, claudeCliState, currentPanelType]);

  const currentTabNeedsAttention = useTabStore((s) => {
    if (!selectedTabId) return false;
    const entry = s.tabs[selectedTabId];
    return entry?.cliState === 'ready-for-review' || entry?.cliState === 'needs-input';
  });

  useEffect(() => {
    if (currentTabNeedsAttention && selectedTabId) {
      dismissTab(selectedTabId);
    }
  }, [currentTabNeedsAttention, selectedTabId]);

  const tabMetadata = useTabMetadataStore((s) =>
    selectedTabId ? s.metadata[selectedTabId] : undefined,
  );

  const handleOpenGit = useCallback(() => {
    if (currentTab?.sessionName) {
      setGitTarget({
        sessionName: currentTab.sessionName,
        cwdKey: tabMetadata?.cwd || currentTab.cwd || currentTab.sessionName,
      });
    }
    setGitOpen(true);
  }, [currentTab, tabMetadata?.cwd]);

  const handleSendDiffToAgent = useCallback((text: string, provider: TGitAskProvider) => {
    if (!currentPane?.id) return;
    setGitOpen(false);
    window.dispatchEvent(new CustomEvent('purplemux-send-to-agent', {
      detail: { paneId: currentPane.id, text, provider },
    }));
  }, [currentPane?.id]);

  const currentTabName = useMemo(() => {
    if (!currentTab) return '';
    if (currentTab.name) return currentTab.name;
    if (currentTab.panelType === 'agent-sessions') return t('sessionList');
    const rawTitle = tabMetadata?.title || currentTab.title;
    const formatted = rawTitle ? formatTabTitle(rawTitle, currentTab.panelType) : '';
    if (formatted) return formatted;
    return '';
  }, [currentTab, tabMetadata, t]);

  const handleSwitchPanelType = useCallback((next: TPanelType) => {
    if (!currentPane || !selectedTabId) return;
    layout.updateTabPanelType(currentPane.id, selectedTabId, next);
  }, [currentPane, selectedTabId, layout]);

  const handleOpenNewTabDialog = useCallback(() => {
    setNewTabDialogOpen(true);
  }, []);

  const handleCreateTab = useCallback(async (panelType?: TPanelType, options?: { command?: string; resumeSessionId?: string }) => {
    if (!currentPane) return;
    let cmd: string | undefined;
    if (options?.command === 'claude-new') {
      if (!await ensureAgentInstalled('claude')) return;
      cmd = buildClaudeLaunchCommand({
        workspaceId: activeWorkspaceId,
        dangerouslySkipPermissions: useConfigStore.getState().dangerouslySkipPermissions,
      });
    } else if (options?.command === 'codex-new') {
      if (!await ensureAgentInstalled('codex')) return;
      try {
        cmd = await fetchCodexLaunchCommand(activeWorkspaceId);
      } catch {
        toast.error(t('codexLaunchFailed'));
        return;
      }
    }
    const newTab = await layout.createTabInPane(currentPane.id, panelType, cmd, options?.resumeSessionId);
    if (newTab) {
      useTabStore.getState().initTab(newTab.id, { panelType, workspaceId: activeWorkspaceId ?? '' });
      if (cmd || options?.resumeSessionId) {
        useTabStore.getState().setSessionView(newTab.id, 'check');
      }
    }
  }, [currentPane, ensureAgentInstalled, layout, activeWorkspaceId, t]);

  const handleCloseTab = useCallback(() => {
    if (!currentPane || !selectedTabId) return;
    layout.deleteTabInPane(currentPane.id, selectedTabId);
  }, [currentPane, selectedTabId, layout]);

  if (isLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center">
        <Spinner className="h-4 w-4 text-muted-foreground" />
        <span className="mt-3 text-sm text-muted-foreground">{t('connecting')}</span>
      </div>
    );
  }

  if (error && !workspaceCount) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <AlertTriangle className="h-5 w-5 text-ui-amber" />
        <span className="text-sm text-muted-foreground">{error}</span>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={useWorkspaceStore.getState().fetchWorkspaces}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {tc('retry')}
        </Button>
      </div>
    );
  }

  if (!activeWorkspaceId && !isLoading && !error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <Monitor className="h-8 w-8 text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">{tm('noWorkspace')}</span>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={async () => {
            const created = await useWorkspaceStore.getState().createWorkspace('');
            if (created) useWorkspaceStore.getState().switchWorkspace(created.id);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('newWorkspace')}
        </Button>
      </div>
    );
  }

  if (!layout.layout || layout.isLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center">
        <Spinner className="h-4 w-4 text-muted-foreground" />
      </div>
    );
  }

  if (layout.error && !layout.isLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <AlertTriangle className="h-5 w-5 text-ui-amber" />
        <span className="text-sm text-muted-foreground">{layout.error}</span>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => layout.fetchLayout()}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {tc('retry')}
        </Button>
      </div>
    );
  }

  return (
    <>
      {currentPane && selectedTabId && (
        <MobileTabHeader
          key={selectedTabId}
          tabId={selectedTabId}
          tabName={currentTabName}
          sessionName={currentTab?.sessionName ?? null}
          cwdKey={tabMetadata?.cwd || currentTab?.cwd || currentTab?.sessionName || null}
          panelType={currentPanelType}
          onSwitchPanelType={handleSwitchPanelType}
          onCreateTab={handleOpenNewTabDialog}
          onOpenGit={handleOpenGit}
          onClose={handleCloseTab}
        />
      )}

      {currentPane && selectedTabId && (
        <MobileSurfaceView
          key={`${selectedPaneId}-${selectedTabId}`}
          paneId={currentPane.id}
          tabs={currentPane.tabs}
          activeTabId={selectedTabId}
          panelType={currentPanelType}
          onCreateTab={layout.createTabInPane}
          onDeleteTab={layout.deleteTabInPane}
          onSwitchTab={layout.switchTabInPane}
          onRemoveTabLocally={layout.removeTabLocally}
          onUpdateTabPanelType={layout.updateTabPanelType}
          onUpdateDiffSettings={layout.updateDiffSettings}
          onCliStateChange={handleCliStateChange}
          onOpenNewTabDialog={handleOpenNewTabDialog}
        />
      )}

      <MobileNewTabDialog
        open={newTabDialogOpen}
        onOpenChange={setNewTabDialogOpen}
        onCreateTab={handleCreateTab}
      />

      <MobileGitFullscreen
        open={gitOpen}
        sessionName={gitTarget?.sessionName}
        onClose={() => setGitOpen(false)}
        onSendToAgent={handleSendDiffToAgent}
        settings={layout.layout?.diffSettings}
        onSettingsChange={layout.updateDiffSettings}
      />
      {installDialogs}
    </>
  );
};

export default MobileTerminalPage;
