import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { X, ChevronLeft, ChevronRight, AlertTriangle, History } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { ITab, TPanelType } from '@/types/terminal';
import useTabDrag from '@/hooks/use-tab-drag';
import PaneTabItem from '@/components/features/workspace/pane-tab-item';
import PaneNewTabMenu from '@/components/features/workspace/pane-new-tab-menu';
import AgentModeSwitcher from '@/components/features/workspace/agent-mode-switcher';

interface IPaneTabBarProps {
  paneId: string;
  tabs: ITab[];
  activeTabId: string | null;
  tabTitles?: Record<string, string>;
  tabProcesses?: Record<string, string>;
  isLoading: boolean;
  error: string | null;
  isCreating: boolean;
  paneCount: number;
  isSplitting: boolean;
  onSwitchTab: (tabId: string) => void;
  onCreateTab: (panelType?: TPanelType, options?: { command?: string; resumeSessionId?: string }) => void;
  onDeleteTab: (tabId: string) => void;
  onRenameTab: (tabId: string, name: string) => void;
  onSwitchPanelType: (panelType: TPanelType) => void;
  onReorderTabs: (tabIds: string[]) => void;
  onClosePane: () => void;
  onMoveTab: (tabId: string, fromPaneId: string, toIndex: number) => void;
  onFocusPane: () => void;
  onRetry: () => void;
  onOpenHistory?: () => void;
}

const PaneTabBar = ({
  paneId,
  tabs,
  activeTabId,
  tabTitles,
  tabProcesses,
  isLoading,
  error,
  isCreating,
  paneCount,
  isSplitting,
  onSwitchTab,
  onCreateTab,
  onDeleteTab,
  onRenameTab,
  onSwitchPanelType,
  onReorderTabs,
  onClosePane,
  onMoveTab,
  onFocusPane,
  onRetry,
  onOpenHistory,
}: IPaneTabBarProps) => {
  const t = useTranslations('terminal');
  const tc = useTranslations('common');
  const scrollRef = useRef<HTMLDivElement>(null);
  const sortedTabs = useMemo(() => [...tabs].sort((a, b) => a.order - b.order), [tabs]);
  const canSwitchMode = (panelType: TPanelType | undefined) =>
    !panelType || panelType === 'terminal' || panelType === 'claude-code' || panelType === 'codex-cli';

  const {
    draggedTabId,
    dropTarget,
    isDragOverFromOther,
    handleDragOver,
    handleDrop,
    handleTabBarDragEnter,
    handleTabBarDragLeave,
    startDrag,
    endDrag,
    clearDropTarget,
  } = useTabDrag({ paneId, sortedTabs, onReorderTabs, onMoveTab });

  const [showLeftArrow, setShowLeftArrow] = useState(false);
  const [showRightArrow, setShowRightArrow] = useState(false);
  const hasOverflow = showLeftArrow || showRightArrow;

  const checkOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setShowLeftArrow(el.scrollLeft > 0);
    setShowRightArrow(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    checkOverflow();
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(checkOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [checkOverflow, tabs]);

  useEffect(() => {
    if (!activeTabId || !scrollRef.current) return;
    const activeEl = scrollRef.current.querySelector(`[data-tab-id="${activeTabId}"]`);
    activeEl?.scrollIntoView({ behavior: 'instant', inline: 'nearest', block: 'nearest' });
  }, [activeTabId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const delta = e.deltaX + e.deltaY;
      if (delta === 0) return;
      e.preventDefault();
      el.scrollLeft += delta;
      checkOverflow();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [checkOverflow]);

  const scrollBy = (delta: number) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: delta, behavior: 'smooth' });
  };

  const handleRenameTab = (tabId: string, name: string) => {
    onRenameTab(tabId, name);
  };

  if (error) {
    return (
      <div className="flex h-[36px] shrink-0 items-center gap-2 bg-background px-3">
        <AlertTriangle className="h-3.5 w-3.5 text-ui-amber" />
        <span className="text-xs text-muted-foreground">{error}</span>
        <Button
          variant="ghost"
          size="xs"
          className="h-5 px-2 text-xs text-foreground hover:text-foreground"
          onClick={onRetry}
        >
          {tc('retry')}
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-[36px] shrink-0 items-center gap-1.5 bg-background px-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-4 w-16 animate-pulse rounded bg-muted" />
        ))}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex h-[36px] shrink-0 items-stretch border-b border-border transition-colors',
        isDragOverFromOther ? 'bg-accent-color/10' : 'bg-background',
      )}
      onDragEnter={handleTabBarDragEnter}
      onDragLeave={handleTabBarDragLeave}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      {hasOverflow && (
        <button
          className={cn(
            'flex w-5 shrink-0 items-center justify-center text-muted-foreground transition-opacity hover:text-foreground',
            showLeftArrow ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
          onClick={() => scrollBy(-200)}
          tabIndex={showLeftArrow ? 0 : -1}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      )}

      <div
        ref={scrollRef}
        role="tablist"
        className="flex flex-1 items-stretch overflow-x-auto"
        style={{ scrollbarWidth: 'none' }}
        onScroll={checkOverflow}
      >
        {sortedTabs.map((tab) => (
          <PaneTabItem
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            isDragging={tab.id === draggedTabId}
            dropSide={dropTarget?.id === tab.id ? dropTarget.side : null}
            displayTitle={tabTitles?.[tab.id]}
            currentProcess={tabProcesses?.[tab.id]}
            modeSwitcher={tab.id === activeTabId && canSwitchMode(tab.panelType) ? (
              <AgentModeSwitcher
                tabId={tab.id}
                paneId={paneId}
                sessionName={tab.sessionName}
                panelType={tab.panelType ?? 'terminal'}
                onSwitchPanelType={onSwitchPanelType}
              />
            ) : undefined}
            onSwitch={() => onSwitchTab(tab.id)}
            onDelete={() => onDeleteTab(tab.id)}
            onRename={(name) => handleRenameTab(tab.id, name)}
            onFocusPane={onFocusPane}
            onDragStart={(e) => startDrag(e, tab.id)}
            onDragEnd={endDrag}
            onDragOver={(e) => handleDragOver(e, tab.id)}
            onDragLeave={clearDropTarget}
          />
        ))}
      </div>

      {hasOverflow && (
        <button
          className={cn(
            'flex w-5 shrink-0 items-center justify-center text-muted-foreground transition-opacity hover:text-foreground',
            showRightArrow ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
          onClick={() => scrollBy(200)}
          tabIndex={showRightArrow ? 0 : -1}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      )}

      <TooltipProvider>
        <div className="flex shrink-0 items-stretch">
          {onOpenHistory && activeTabId && (sortedTabs.find((tab) => tab.id === activeTabId)?.panelType ?? 'terminal') === 'terminal' && (
            <Tooltip>
              <TooltipTrigger
                className="flex h-9 w-8 items-center justify-center text-muted-foreground hover:text-foreground"
                onClick={(event) => { event.stopPropagation(); onOpenHistory(); }}
                aria-label="ターミナル履歴を表示"
              >
                <History className="h-3.5 w-3.5" />
              </TooltipTrigger>
              <TooltipContent side="bottom">ターミナル履歴</TooltipContent>
            </Tooltip>
          )}
          <PaneNewTabMenu
            paneId={paneId}
            isCreating={isCreating}
            activePanelType={sortedTabs.find((tab) => tab.id === activeTabId)?.panelType}
            onCreateTab={onCreateTab}
          />

          {paneCount >= 2 && (
            <div className="flex items-center px-0.5">
              <Tooltip>
                <TooltipTrigger
                  className={cn(
                    'flex h-7 w-7 items-center justify-center text-muted-foreground',
                    isSplitting ? 'pointer-events-none opacity-30' : 'hover:text-foreground',
                  )}
                  disabled={isSplitting}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClosePane();
                  }}
                  aria-label={t('closeAllTabs')}
                >
                  <X className="h-3.5 w-3.5" />
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('closeAllTabs')}</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      </TooltipProvider>
    </div>
  );
};

export default PaneTabBar;
