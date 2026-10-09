import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { History, Plus, Globe } from 'lucide-react';
import Spinner from '@/components/ui/spinner';
import ClaudeCodeIcon from '@/components/icons/claude-code-icon';
import OpenAIIcon from '@/components/icons/openai-icon';
import ProcessIcon from '@/components/icons/process-icon';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { TPanelType } from '@/types/terminal';
import { useLayoutStore } from '@/hooks/use-layout';
import useIsMobile from '@/hooks/use-is-mobile';
import useIsMac from '@/hooks/use-is-mac';
import { buildClaudeLaunchCommand } from '@/lib/providers/claude/client';
import { fetchCodexLaunchCommand } from '@/lib/providers/codex/client';
import { notifyCodexLaunchFailed } from '@/lib/codex-notifications';
import useConfigStore from '@/hooks/use-config-store';
import useWorkspaceStore from '@/hooks/use-workspace-store';
import { useAgentInstallCheck } from '@/hooks/use-agent-install-check';

interface IPaneNewTabMenuProps {
  paneId: string;
  isCreating: boolean;
  activePanelType?: TPanelType;
  onCreateTab: (panelType?: TPanelType, options?: { command?: string; resumeSessionId?: string }) => void;
}

const useCodexI18n = () => {
  const t = useTranslations('terminal');
  return {
    notInstalled: t('codexNotInstalled'),
    copyCommand: t('codexCopyCommand'),
    copied: t('codexCopied'),
    copyConfigPath: t('codexCopyConfigPath'),
    configParseFailed: t('codexConfigParseFailed'),
    launchFailed: t('codexLaunchFailed'),
    resumeFailed: t('codexResumeFailed'),
    approvalSendFailed: t('codexApprovalSendFailed'),
    approvalNotApplied: t('codexApprovalNotApplied'),
    retry: t('codexRetry'),
  };
};

const defaultKeyForPanelType = (panelType?: TPanelType): string => {
  switch (panelType) {
    case 'terminal': return 'terminal';
    case 'web-browser': return 'web-browser';
    case 'codex-cli': return 'codex';
    case 'agent-sessions': return 'agent-sessions';
    case 'diff':
    case 'claude-code':
    default: return 'claude';
  }
};

const PaneNewTabMenu = ({ paneId, isCreating, activePanelType, onCreateTab }: IPaneNewTabMenuProps) => {
  const t = useTranslations('terminal');
  const isMac = useIsMac();
  const mod = isMac ? '⌘' : 'Ctrl+';
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const wsId = useLayoutStore((s) => s.workspaceId);
  const isRemoteWorkspace = useWorkspaceStore((s) => s.workspaces.some((w) => w.id === wsId && !!w.hostId));
  const codexI18n = useCodexI18n();
  const { ensureAgentInstalled, installDialogs } = useAgentInstallCheck();

  const menuItems = useMemo(() => {
    const all = [
      { key: 'claude', type: 'claude-code' as const, icon: <ClaudeCodeIcon className="h-3.5 w-3.5" />, label: t('claudeNewConversation'), startAgent: 'claude' as const },
      { key: 'codex', type: 'codex-cli' as const, icon: <OpenAIIcon className="h-3.5 w-3.5" />, label: t('codexNewConversation'), startAgent: 'codex' as const },
      { key: 'agent-sessions', type: 'agent-sessions' as const, icon: <History className="h-3.5 w-3.5 text-muted-foreground" />, label: t('sessionList') },
      { key: 'terminal', type: 'terminal' as const, icon: <ProcessIcon className="h-3.5 w-3.5 text-muted-foreground" />, label: 'Terminal' },
      { key: 'web-browser', type: 'web-browser' as const, icon: <Globe className="h-3.5 w-3.5 text-muted-foreground" />, label: 'Web Browser' },
    ];
    if (isRemoteWorkspace) return all.filter((item) => item.key === 'codex' || item.key === 'terminal');
    return isMobile ? all.filter((item) => item.key !== 'web-browser') : all;
  }, [isMobile, isRemoteWorkspace, t]);

  const [activeIndex, setActiveIndex] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const openMenu = useCallback(() => {
    const targetKey = defaultKeyForPanelType(activePanelType);
    const idx = menuItems.findIndex((i) => i.key === targetKey);
    setActiveIndex(idx >= 0 ? idx : 0);
    setOpen(true);
  }, [activePanelType, menuItems]);

  const handleOpenChange = (next: boolean) => {
    if (next) openMenu();
    else setOpen(false);
  };

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ paneId: string }>).detail;
      if (detail?.paneId !== paneId) return;
      openMenu();
    };
    window.addEventListener('open-new-tab-menu', handler);
    return () => window.removeEventListener('open-new-tab-menu', handler);
  }, [paneId, openMenu]);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  const launchCodexNewConversation = useCallback(async () => {
    const workspace = useWorkspaceStore.getState().workspaces.find((w) => w.id === wsId);
    if (workspace?.hostId) {
      // Remote Codex has the same Chat / Terminal modes as local Codex.
      // The server launches the CLI in this tab's persistent remote tmux.
      onCreateTab('codex-cli');
      return;
    }
    if (!await ensureAgentInstalled('codex')) return;
    try {
      const cmd = await fetchCodexLaunchCommand(wsId);
      onCreateTab('codex-cli', { command: cmd });
    } catch {
      notifyCodexLaunchFailed(codexI18n);
    }
  }, [codexI18n, ensureAgentInstalled, onCreateTab, wsId]);

  const handleStartAgent = useCallback(async (agent: 'claude' | 'codex') => {
    setOpen(false);
    if (agent === 'claude') {
      if (!await ensureAgentInstalled('claude')) return;
      const cmd = buildClaudeLaunchCommand({
        workspaceId: wsId,
        dangerouslySkipPermissions: useConfigStore.getState().dangerouslySkipPermissions,
      });
      onCreateTab('claude-code', { command: cmd });
      return;
    }
    void launchCodexNewConversation();
  }, [ensureAgentInstalled, launchCodexNewConversation, onCreateTab, wsId]);

  const handleOpenList = (item: typeof menuItems[number]) => {
    setOpen(false);
    onCreateTab(item.type);
  };

  const handleSelect = (item: typeof menuItems[number]) => {
    if ('startAgent' in item && item.startAgent) {
      void handleStartAgent(item.startAgent);
      return;
    }
    handleOpenList(item);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % menuItems.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + menuItems.length) % menuItems.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = menuItems[activeIndex];
      if (item) handleSelect(item);
    }
  };

  return (
    <>
    <div className="flex items-center border-l border-r border-border px-0.5">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                className={cn(
                  'flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground',
                  isCreating && 'pointer-events-none opacity-50',
                )}
                disabled={isCreating}
                aria-label={t('openNewTab')}
              />
            }
          >
            {isCreating ? (
              <Spinner className="h-3 w-3" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('newTabTooltip', { shortcut: `${mod}T` })}</TooltipContent>
        </Tooltip>
        <PopoverContent side="bottom" align="start" className="w-max min-w-52 max-w-[calc(100vw-1rem)] gap-0 p-0.5" onKeyDown={handleKeyDown}>
          {menuItems.map((item, idx) => (
            <div
              key={item.key}
              className={cn('flex rounded-sm', activeIndex === idx && 'bg-accent')}
              onMouseEnter={() => setActiveIndex(idx)}
            >
              <button
                ref={(el) => { itemRefs.current[idx] = el; }}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2.5 py-2 text-xs text-foreground hover:bg-accent focus:outline-none"
                onClick={() => void handleSelect(item)}
              >
                {item.icon}
                <span className="min-w-0 flex-1 truncate text-left">
                  {item.label}
                </span>
              </button>
            </div>
          ))}
        </PopoverContent>
      </Popover>
    </div>
    {installDialogs}
    </>
  );
};

export default PaneNewTabMenu;
