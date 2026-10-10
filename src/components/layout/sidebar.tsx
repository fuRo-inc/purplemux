import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronsLeft,
  ChevronsRight,
  Plus,
  FolderPlus,
  Server,
  Settings,
  LogOut,
} from 'lucide-react';
import useTabStore from '@/hooks/use-tab-store';
import { useNotificationCount, NotificationPanel } from '@/components/features/workspace/notification-sheet';
import AppLogo from '@/components/layout/app-logo';
import ShortcutKey from '@/components/shortcut-key';
import useShortcutHints from '@/hooks/use-shortcut-hints';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import type { ITab, IWorkspace, IWorkspaceGroup } from '@/types/terminal';
import useWorkspaceStore from '@/hooks/use-workspace-store';
import WorkspaceItem from '@/components/features/workspace/workspace-item';
import WorkspaceGroupHeader from '@/components/features/workspace/workspace-group-header';
import dynamic from 'next/dynamic';

const SettingsDialog = dynamic(
  () => import('@/components/features/workspace/settings-dialog'),
  { ssr: false },
);
const RemoteWorkspaceDialog = dynamic(
  () => import('@/components/features/workspace/remote-workspace-dialog'),
  { ssr: false },
);
const CheatSheetDialog = dynamic(
  () => import('@/components/features/shortcuts/cheat-sheet-dialog'),
  { ssr: false },
);
import { useSelectWorkspace } from '@/hooks/use-sidebar-actions';
import useSidebarItems from '@/hooks/use-sidebar-items';
import useWorkspaceLayouts from '@/hooks/use-workspace-layouts';
import useWebviewStore from '@/hooks/use-webview-store';
import IconRenderer from '@/components/features/settings/icon-renderer';
import SidebarRateLimits from '@/components/layout/sidebar-rate-limits';
import isElectron from '@/hooks/use-is-electron';

const MIN_WIDTH = 160;
const MAX_WIDTH = 480;

const handleLogout = async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
};

const Sidebar = () => {
  const t = useTranslations('sidebar');
  const tc = useTranslations('common');
  const router = useRouter();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const groups = useWorkspaceStore((s) => s.groups);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const collapsed = useWorkspaceStore((s) => s.sidebarCollapsed);
  const width = useWorkspaceStore((s) => s.sidebarWidth);
  const isLoading = useWorkspaceStore((s) => s.isLoading);
  const hasBusy = useTabStore((s) => {
    for (const t of Object.values(s.tabs)) {
      if (t.cliState === 'busy') return true;
    }
    return false;
  });
  const { attentionCount, busyCount } = useNotificationCount();
  const sessionsBadge = attentionCount + busyCount;
  const selectWorkspace = useSelectWorkspace();
  const { items: sidebarItems } = useSidebarItems();
  const activeWebviewId = useWebviewStore((s) => s.activeId);
  const workspaceLayouts = useWorkspaceLayouts();
  const workspaceTabs = useMemo(() => {
    const map: Record<string, ITab[]> = {};
    for (const [wsId, panes] of Object.entries(workspaceLayouts)) {
      map[wsId] = panes.flatMap((pane) => [...pane.tabs].sort((a, b) => a.order - b.order));
    }
    return map;
  }, [workspaceLayouts]);

  const settingsOpen = useWorkspaceStore((s) => s.isSettingsDialogOpen);
  const setSettingsOpen = useWorkspaceStore((s) => s.setSettingsDialogOpen);
  const storedSidebarTab = useWorkspaceStore((s) => s.sidebarTab);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const sidebarTab = mounted ? storedSidebarTab : 'workspace';

  const handleSidebarTabChange = useCallback((v: string) => {
    useWorkspaceStore.getState().setSidebarTab(v as 'workspace' | 'sessions');
  }, []);
  const showShortcuts = useShortcutHints();

  useEffect(() => {
    if (workspaces.length === 0) {
      useWorkspaceStore.getState().fetchWorkspaces();
    }
  }, [workspaces.length]);

  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener('open-settings', handler);
    return () => window.removeEventListener('open-settings', handler);
  }, [setSettingsOpen]);

  const [isCreating, setIsCreating] = useState(false);
  const [remoteDialogOpen, setRemoteDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<IWorkspace | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [fadingOutIds, setFadingOutIds] = useState<Set<string>>(new Set());
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    position: number;
    groupId: string | null;
    edge: 'before' | 'after' | 'group-start';
  } | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(width);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizing.current = true;
      setIsDragging(true);
      startX.current = e.clientX;
      startWidth.current = width;

      const handleMouseMove = (ev: MouseEvent) => {
        if (!isResizing.current) return;
        const delta = ev.clientX - startX.current;
        const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta));
        lastWidth = newWidth;
        useWorkspaceStore.getState().setSidebarWidth(newWidth);
      };

      let lastWidth = startWidth.current;

      const handleMouseUp = () => {
        isResizing.current = false;
        setIsDragging(false);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        useWorkspaceStore.getState().saveSidebarWidth(lastWidth);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width],
  );

  const handleCreateWorkspace = useCallback(async () => {
    setIsCreating(true);
    try {
      const ws = await useWorkspaceStore.getState().createWorkspace('');
      if (ws) {
        selectWorkspace(ws.id);
      }
    } finally {
      setIsCreating(false);
    }
  }, [selectWorkspace]);

  const handleCreateGroup = useCallback(async () => {
    const defaultName = t('defaultGroupName');
    await useWorkspaceStore.getState().createGroup(defaultName);
  }, [t]);

  const handleRenameGroup = useCallback((groupId: string, name: string) => {
    useWorkspaceStore.getState().renameGroup(groupId, name);
  }, []);

  const handleToggleGroup = useCallback((groupId: string) => {
    useWorkspaceStore.getState().toggleGroupCollapsed(groupId);
  }, []);

  const handleUngroup = useCallback((groupId: string) => {
    useWorkspaceStore.getState().ungroupGroup(groupId);
  }, []);

  const handleDeleteRequest = useCallback(
    (workspaceId: string) => {
      const ws = workspaces.find((w) => w.id === workspaceId);
      if (ws) setDeleteTarget(ws);
    },
    [workspaces],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;

    const { id } = deleteTarget;
    setDeleteTarget(null);
    setDeletingIds((prev) => new Set(prev).add(id));

    const isActive = id === activeWorkspaceId;
    if (isActive) {
      const idx = workspaces.findIndex((w) => w.id === id);
      const adjacent = workspaces[idx + 1] || workspaces[idx - 1];
      if (adjacent) {
        selectWorkspace(adjacent.id);
      }
    }

    const store = useWorkspaceStore.getState();
    store.markPendingDelete(id);
    try {
      const success = await store.deleteWorkspace(id);

      if (!success) {
        setDeletingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        return;
      }

      setFadingOutIds((prev) => new Set(prev).add(id));
      await new Promise<void>((resolve) => setTimeout(resolve, 150));

      store.removeWorkspace(id);
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setFadingOutIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });

      if (workspaces.length <= 1) {
        store.fetchWorkspaces();
      }
    } finally {
      store.unmarkPendingDelete(id);
    }
  }, [deleteTarget, activeWorkspaceId, workspaces, selectWorkspace]);

  const handleRename = useCallback(
    (workspaceId: string, name: string) => {
      useWorkspaceStore.getState().renameWorkspace(workspaceId, name);
    },
    [],
  );

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    requestAnimationFrame(() => {
      (e.target as HTMLElement).style.opacity = '0.4';
    });
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    (e.target as HTMLElement).style.opacity = '';
    setDragIndex(null);
    setDropTarget(null);
  }, []);

  const handleWsDragOver = useCallback(
    (e: React.DragEvent, position: number, groupId: string | null) => {
      if (dragIndex === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      const edge: 'before' | 'after' = e.clientY < midpoint ? 'before' : 'after';
      setDropTarget({ position, groupId, edge });
    },
    [dragIndex],
  );

  const handleGroupHeaderDragOver = useCallback(
    (e: React.DragEvent, firstWsPosition: number, groupId: string) => {
      if (dragIndex === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropTarget({ position: firstWsPosition, groupId, edge: 'group-start' });
    },
    [dragIndex],
  );

  const handleUngroupedAreaDragOver = useCallback(
    (e: React.DragEvent, lastPosition: number) => {
      if (dragIndex === null) return;
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropTarget({ position: lastPosition, groupId: null, edge: 'after' });
    },
    [dragIndex],
  );

  const handleWsDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (dragIndex === null || !dropTarget) {
        setDragIndex(null);
        setDropTarget(null);
        return;
      }
      const insertBefore =
        dropTarget.edge === 'before' || dropTarget.edge === 'group-start'
          ? dropTarget.position
          : dropTarget.position + 1;
      const finalIdx = dragIndex < insertBefore ? insertBefore - 1 : insertBefore;
      const current = useWorkspaceStore.getState().workspaces[dragIndex];
      const groupChanged =
        current && (current.groupId ?? null) !== (dropTarget.groupId ?? null);
      if (finalIdx !== dragIndex || groupChanged) {
        useWorkspaceStore
          .getState()
          .reorderWorkspaces(dragIndex, finalIdx, dropTarget.groupId);
      }
      setDragIndex(null);
      setDropTarget(null);
    },
    [dragIndex, dropTarget],
  );

  const handleToggleCollapse = useCallback(() => {
    useWorkspaceStore.getState().toggleSidebar();
  }, []);

  const isNavActive = (path: string) => router.pathname.startsWith(path);

  type TRenderEntry = { ws: IWorkspace; flatIdx: number };
  type TRenderSection =
    | { type: 'group'; group: IWorkspaceGroup; workspaces: TRenderEntry[]; firstWsPosition: number }
    | { type: 'ungrouped'; workspaces: TRenderEntry[]; lastPosition: number };

  const renderedSections = useMemo<TRenderSection[]>(() => {
    const byGroup = new Map<string, TRenderEntry[]>();
    const ungrouped: TRenderEntry[] = [];
    workspaces.forEach((ws, flatIdx) => {
      const gid = ws.groupId ?? null;
      if (gid && groups.some((g) => g.id === gid)) {
        const list = byGroup.get(gid) ?? [];
        list.push({ ws, flatIdx });
        byGroup.set(gid, list);
      } else {
        ungrouped.push({ ws, flatIdx });
      }
    });

    const sections: TRenderSection[] = [];
    for (const g of groups) {
      const list = byGroup.get(g.id) ?? [];
      const firstWsPosition = list[0]?.flatIdx ?? workspaces.length;
      sections.push({ type: 'group', group: g, workspaces: list, firstWsPosition });
    }
    sections.push({
      type: 'ungrouped',
      workspaces: ungrouped,
      lastPosition: ungrouped.length > 0 ? ungrouped[ungrouped.length - 1].flatIdx : workspaces.length - 1,
    });
    return sections;
  }, [workspaces, groups]);

  const renderWorkspaceRow = (entry: TRenderEntry) => {
    const { ws, flatIdx } = entry;
    const isDropBefore =
      dropTarget?.position === flatIdx &&
      dropTarget.edge === 'before' &&
      dragIndex !== null &&
      dragIndex !== flatIdx;
    const isDropAfter =
      dropTarget?.position === flatIdx &&
      dropTarget.edge === 'after' &&
      dragIndex !== null &&
      dragIndex !== flatIdx;

    return (
      <div
        key={ws.id}
        draggable
        onDragStart={(e) => handleDragStart(e, flatIdx)}
        onDragEnd={handleDragEnd}
        onDragOver={(e) => handleWsDragOver(e, flatIdx, ws.groupId ?? null)}
        onDrop={handleWsDrop}
        style={{
          opacity: fadingOutIds.has(ws.id) ? 0 : undefined,
          transition: 'opacity 150ms ease-out',
          borderTop: isDropBefore ? '2px solid var(--focus-indicator)' : undefined,
          borderBottom: isDropAfter ? '2px solid var(--focus-indicator)' : undefined,
        }}
      >
        <WorkspaceItem
          workspace={ws}
          isActive={ws.id === activeWorkspaceId && router.pathname === '/' && !activeWebviewId}
          isDeleting={deletingIds.has(ws.id)}
          shortcutLabel={flatIdx < 8 ? `⌘${flatIdx + 1}` : flatIdx === workspaces.length - 1 ? '⌘9' : undefined}
          showShortcut={showShortcuts}
          tabs={workspaceTabs[ws.id]}
          onSelect={selectWorkspace}
          onRename={handleRename}
          onDelete={handleDeleteRequest}
        />
      </div>
    );
  };

  return (
    <div className="relative flex shrink-0">
      <div
        className="flex shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar"
        suppressHydrationWarning
        style={{
          width: isLoading ? 'var(--initial-sb-w, 200px)' : (collapsed ? 0 : width),
          minWidth: isLoading ? 'var(--initial-sb-mw, 160px)' : (collapsed ? 0 : MIN_WIDTH),
          maxWidth: MAX_WIDTH,
          borderRightStyle: collapsed ? 'none' : undefined,
          transition: isDragging ? 'none' : 'width 200ms ease, min-width 200ms ease',
        }}
        role="navigation"
        aria-label={t('workspaceList')}
      >
        <div
          className="relative z-[60] flex h-12 shrink-0 items-center justify-between border-b border-sidebar-border px-3 pl-traffic-light"
          {...(isElectron ? { style: { WebkitAppRegion: 'drag' } as React.CSSProperties } : {})}
        >
          <AppLogo shimmer={hasBusy} className="pointer-events-none" />
          <div
            className="flex items-center gap-0.5"
            {...(isElectron ? { style: { WebkitAppRegion: 'no-drag' } as React.CSSProperties } : {})}
          >
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <button
                    className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-sidebar-accent"
                    aria-label={tc('logout')}
                  />
                }
              >
                <LogOut className="h-3.5 w-3.5" />
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{tc('logout')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {tc('logoutConfirm')}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{tc('cancel')}</AlertDialogCancel>
                  <AlertDialogAction onClick={handleLogout}>{tc('logout')}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        <div className="shrink-0 border-b border-sidebar-border px-2 py-1.5">
          <Tabs
            value={sidebarTab}
            onValueChange={handleSidebarTabChange}
            className="gap-0"
          >
            <TabsList className="h-7 w-full">
              <TabsTrigger value="workspace" className="relative h-full flex-1 px-2.5 text-[11px] tracking-wide">
                WORKSPACE
                {sidebarTab !== 'workspace' && (
                  <ShortcutKey
                    mac="⌘⇧B"
                    other="^⇧B"
                    className={cn(
                      'absolute -right-0.5 -top-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-medium leading-none text-muted-foreground transition-opacity duration-200 pointer-events-none',
                      showShortcuts ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                )}
              </TabsTrigger>
              <TabsTrigger value="sessions" className="relative h-full flex-1 px-2.5 text-[11px] tracking-wide">
                SESSIONS
                {sessionsBadge > 0 && (
                  <span className="ml-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded bg-[var(--ui-coral)] px-0.5 text-[9px] font-medium leading-none text-white">
                    {sessionsBadge}
                  </span>
                )}
                {sidebarTab !== 'sessions' && (
                  <ShortcutKey
                    mac="⌘⇧B"
                    other="^⇧B"
                    className={cn(
                      'absolute -right-0.5 -top-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-medium leading-none text-muted-foreground transition-opacity duration-200 pointer-events-none',
                      showShortcuts ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                )}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {sidebarTab === 'workspace' ? (
          <div
            className="flex-1 overflow-y-auto"
            style={{ scrollbarWidth: 'none' }}
            onDragOver={(e) => {
              if (dragIndex === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }}
          >
            {!isLoading && workspaces.length === 0 && (
              <div className="flex flex-col items-center gap-2 p-4">
                <span className="text-xs text-muted-foreground">
                  {t('noWorkspaces')}
                </span>
              </div>
            )}

            {renderedSections.map((section) => {
              if (section.type === 'group') {
                return (
                  <div key={`group-${section.group.id}`}>
                    <div
                      onDragOver={(e) =>
                        handleGroupHeaderDragOver(e, section.firstWsPosition, section.group.id)
                      }
                      onDrop={handleWsDrop}
                      style={{
                        borderBottom:
                          dropTarget?.edge === 'group-start' && dropTarget.groupId === section.group.id
                            ? '2px solid var(--focus-indicator)'
                            : undefined,
                      }}
                    >
                      <WorkspaceGroupHeader
                        group={section.group}
                        count={section.workspaces.length}
                        onToggle={handleToggleGroup}
                        onRename={handleRenameGroup}
                        onUngroup={handleUngroup}
                      />
                    </div>
                    {!section.group.collapsed &&
                      section.workspaces.map((entry) => renderWorkspaceRow(entry))}
                    {!section.group.collapsed && section.workspaces.length === 0 && (
                      <div
                        className={cn(
                          'flex h-6 items-center px-3 text-[11px] italic text-muted-foreground/50',
                          dragIndex !== null &&
                            dropTarget?.edge === 'group-start' &&
                            dropTarget.groupId === section.group.id &&
                            'border-b-2 border-[var(--focus-indicator)]',
                        )}
                        onDragOver={(e) =>
                          handleGroupHeaderDragOver(e, section.firstWsPosition, section.group.id)
                        }
                        onDrop={handleWsDrop}
                      >
                        {t('emptyGroup')}
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <div
                  key="ungrouped"
                  className="min-h-[8px]"
                  onDragOver={(e) =>
                    handleUngroupedAreaDragOver(e, section.lastPosition)
                  }
                  onDrop={handleWsDrop}
                >
                  {section.workspaces.map((entry) => renderWorkspaceRow(entry))}
                </div>
              );
            })}
          </div>
        ) : (
          <NotificationPanel className="px-2 pt-2 pb-2" />
        )}

        <div className="shrink-0 border-t border-sidebar-border">
          {sidebarTab === 'workspace' && (
            <div className="relative flex h-9 items-stretch">
              <button
                className="flex flex-1 items-center gap-2 px-3 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent disabled:opacity-50"
                onClick={handleCreateWorkspace}
                disabled={isCreating}
                aria-label={t('addWorkspace')}
              >
                <Plus className="h-3.5 w-3.5" />
                Local
              </button>
              <button className="flex items-center gap-1 border-l border-sidebar-border px-2 text-xs text-muted-foreground hover:bg-sidebar-accent" onClick={() => setRemoteDialogOpen(true)} title="New Remote Workspace">
                <Server className="h-3.5 w-3.5" /> Remote
              </button>
              <ShortcutKey
                mac="⌘N"
                other="^N"
                className={cn(
                  'pointer-events-none absolute right-9 top-1/2 -translate-y-1/2 rounded bg-muted px-1 py-0.5 text-[10px] font-medium leading-none text-muted-foreground transition-opacity duration-200',
                  showShortcuts ? 'opacity-100' : 'opacity-0',
                )}
              />
              <button
                className="flex w-9 items-center justify-center text-muted-foreground transition-colors hover:bg-sidebar-accent"
                onClick={handleCreateGroup}
                aria-label={t('newGroup')}
                title={t('newGroup')}
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          <SidebarRateLimits />

          <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-0.5">
              {sidebarItems.map((item) => {
                const isExternal = item.url.startsWith('http://') || item.url.startsWith('https://');
                const isActive = isExternal
                  ? activeWebviewId === item.id
                  : isNavActive(item.url) && !activeWebviewId;
                const shortcutMap: Record<string, { mac: string; other: string }> = {
                  'builtin-notes': { mac: '⌘⇧E', other: '^⇧E' },
                  'builtin-stats': { mac: '⌘⇧U', other: '^⇧U' },
                };
                const shortcut = shortcutMap[item.id];
                return (
                  <div key={item.id} className="relative">
                    <button
                      className={cn(
                        'flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-sidebar-accent',
                        isActive ? 'text-foreground' : 'text-muted-foreground',
                      )}
                      onClick={() => {
                        if (isExternal) {
                          useWebviewStore.getState().open(item.id, item.url, item.name);
                        } else {
                          useWebviewStore.getState().hide();
                          router.push(item.url);
                        }
                      }}
                      aria-label={item.name}
                      title={item.name}
                    >
                      <IconRenderer name={item.icon} className="h-3.5 w-3.5" />
                    </button>
                    {shortcut && (
                      <ShortcutKey
                        mac={shortcut.mac}
                        other={shortcut.other}
                        className={cn(
                          'absolute -right-0.5 -top-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-medium leading-none text-muted-foreground transition-opacity duration-200 pointer-events-none',
                          showShortcuts ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                    )}
                  </div>
                );
              })}
              <Link href="/task-sessions" title="Task Sessions — 承認記録のみ、実行権限は未連携" className="rounded px-1 text-xs text-muted-foreground hover:bg-sidebar-accent">Tasks</Link>
              <div className="relative">
                <button
                  className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-sidebar-accent"
                  onClick={() => setSettingsOpen(true)}
                  aria-label={tc('settings')}
                >
                  <Settings className="h-3.5 w-3.5" />
                </button>
                <ShortcutKey
                  mac="⌘,"
                  other="^,"
                  className={cn(
                    'absolute -right-0.5 -top-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-medium leading-none text-muted-foreground transition-opacity duration-200 pointer-events-none',
                    showShortcuts ? 'opacity-100' : 'opacity-0',
                  )}
                />
              </div>
            </div>
            <div className="relative">
              <button
                className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-sidebar-accent"
                onClick={handleToggleCollapse}
                aria-label={t('collapseSidebar')}
              >
                <ChevronsLeft className="h-3.5 w-3.5" />
              </button>
              <ShortcutKey
                mac="⌘B"
                other="^B"
                className={cn(
                  'absolute -right-0.5 -top-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-medium leading-none text-muted-foreground transition-opacity duration-200 pointer-events-none',
                  showShortcuts ? 'opacity-100' : 'opacity-0',
                )}
              />
            </div>
          </div>
        </div>
      </div>

      {!collapsed && (
        <div
          className="group relative shrink-0"
          style={{
            width: '6px',
            marginLeft: '-3px',
            marginRight: '-3px',
            cursor: 'col-resize',
            zIndex: 10,
          }}
          onMouseDown={handleResizeStart}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 20 : 4;
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              const newWidth = Math.max(MIN_WIDTH, width - step);
              useWorkspaceStore.getState().setSidebarWidth(newWidth);
            } else if (e.key === 'ArrowRight') {
              e.preventDefault();
              const newWidth = Math.min(MAX_WIDTH, width + step);
              useWorkspaceStore.getState().setSidebarWidth(newWidth);
            }
          }}
          onKeyUp={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              useWorkspaceStore.getState().saveSidebarWidth(useWorkspaceStore.getState().sidebarWidth);
            }
          }}
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={width}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          tabIndex={0}
          suppressHydrationWarning
        >
          <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-muted-foreground/50 group-active:bg-muted-foreground" />
        </div>
      )}

      {collapsed && (
        <div className="flex w-8 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
          <button
            className="flex flex-1 items-center justify-center text-muted-foreground transition-colors hover:bg-sidebar-accent"
            onClick={handleToggleCollapse}
            aria-label={t('expandSidebar')}
            aria-expanded="false"
          >
            <ChevronsRight className="h-4 w-4" />
          </button>
        </div>
      )}

      {settingsOpen && <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />}
      <RemoteWorkspaceDialog open={remoteDialogOpen} onOpenChange={setRemoteDialogOpen} onCreated={selectWorkspace} />
      <CheatSheetDialog />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteWorkspace')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deleteWorkspaceConfirm', { name: deleteTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-ui-red hover:bg-ui-red/80"
              onClick={handleDeleteConfirm}
            >
              {tc('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Sidebar;
