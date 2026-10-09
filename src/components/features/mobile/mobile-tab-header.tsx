import { useEffect, useState } from 'react';
import { X, Plus, GitCompareArrows, Copy, History, MessageSquare, TerminalSquare } from 'lucide-react';
import { useTranslations } from 'next-intl';
import ClaudeCodeIcon from '@/components/icons/claude-code-icon';
import OpenAIIcon from '@/components/icons/openai-icon';
import TabStatusIndicator from '@/components/features/workspace/tab-status-indicator';
import CopyPaneDrawer from '@/components/features/workspace/copy-pane-drawer';
import useTabStore from '@/hooks/use-tab-store';
import ProcessIcon from '@/components/icons/process-icon';
import { cn } from '@/lib/utils';
import useGitStatusStore, {
  formatGitStatusSummary,
  getGitStatusIndicators,
} from '@/hooks/use-git-status-store';
import type { TGitStatusIndicatorTone } from '@/hooks/use-git-status-store';
import { getAgentPanelTypeFromProvider, isAgentPanel, tryAgentSwitch } from '@/lib/agent-switch-lock';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
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
import type { TPanelType } from '@/types/terminal';

const iconButtonClassName = 'relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';
const iconClassName = 'h-4 w-4 shrink-0';
const GIT_STATUS_REFRESH_MS = 15_000;

const gitIndicatorToneClass: Record<TGitStatusIndicatorTone, string> = {
  dirty: 'text-muted-foreground/75',
  sync: 'text-muted-foreground/75',
  stash: 'text-muted-foreground/65',
};

type TModeButton = {
  type: Extract<TPanelType, 'terminal' | 'claude-code' | 'codex-cli'>;
  label: string;
  startAction?: boolean;
};

const canSwitchMode = (panelType: TPanelType) =>
  panelType === 'terminal' || panelType === 'claude-code' || panelType === 'codex-cli';

const getButtonLabel = (mode: TModeButton) =>
  mode.startAction ? `Start ${mode.label}` : mode.label;

const getAgentLabel = (panelType: TPanelType): string => {
  if (panelType === 'claude-code' || panelType === 'codex-cli') return 'Chat';
  return 'Terminal';
};

const processMatchesAgent = (panelType: TPanelType | undefined, process: string | undefined): boolean => {
  if (!process) return false;
  const normalized = process.toLowerCase();
  if (panelType === 'claude-code') return normalized === 'claude';
  if (panelType === 'codex-cli') return normalized === 'codex';
  return false;
};

interface IMobileTabHeaderProps {
  tabId: string;
  tabName: string;
  sessionName: string | null;
  cwdKey: string | null;
  panelType: TPanelType;
  onSwitchPanelType: (type: TPanelType) => void;
  onCreateTab: () => void;
  onOpenGit: () => void;
  onClose: () => void;
}

const MobileTabHeader = ({
  tabId,
  tabName,
  sessionName,
  cwdKey,
  panelType,
  onSwitchPanelType,
  onCreateTab,
  onOpenGit,
  onClose,
}: IMobileTabHeaderProps) => {
  const t = useTranslations('mobile');
  const tc = useTranslations('common');
  const tt = useTranslations('terminal');
  const [copyOpen, setCopyOpen] = useState(false);
  const [modeDrawerOpen, setModeDrawerOpen] = useState(false);
  const showCopy = panelType === 'terminal' && !!sessionName;
  const tabEntry = useTabStore((s) => s.tabs[tabId]);
  const gitPhase = useGitStatusStore((state) => state.phase);
  const gitStatus = useGitStatusStore((state) => state.status);
  const gitBranch = useGitStatusStore((state) => state.branch);
  const resetGitStatusForTarget = useGitStatusStore((state) => state.resetForTarget);
  const fetchGitStatusForTarget = useGitStatusStore((state) => state.fetchForTarget);
  const gitIndicators = getGitStatusIndicators(gitStatus);
  const gitTitle = formatGitStatusSummary(gitPhase, gitBranch, gitStatus, 'Open Git');
  const hasGitInlineStatus = gitIndicators.length > 0 || gitPhase === 'error';

  useEffect(() => {
    const target = { cwdKey, tmuxSession: sessionName };
    resetGitStatusForTarget(target);
    void fetchGitStatusForTarget(target);

    if (!cwdKey || !sessionName) return undefined;

    const timer = window.setInterval(() => {
      void fetchGitStatusForTarget(target);
    }, GIT_STATUS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [cwdKey, fetchGitStatusForTarget, resetGitStatusForTarget, sessionName]);
  const switchable = canSwitchMode(panelType);
  const runtimeAgentPanelType = getAgentPanelTypeFromProvider(tabEntry?.agentProviderId);
  const hasDetectedAgent = !!runtimeAgentPanelType
    && (tabEntry?.agentProcess === true || processMatchesAgent(runtimeAgentPanelType, tabEntry?.currentProcess));
  const visibleAgentPanelType = isAgentPanel(panelType)
    ? panelType
    : hasDetectedAgent
      ? runtimeAgentPanelType
      : undefined;
  const modeButtons: TModeButton[] = [
    { type: 'terminal', label: 'Terminal' },
    ...(visibleAgentPanelType
      ? [{
          type: visibleAgentPanelType,
          label: getAgentLabel(visibleAgentPanelType),
        }]
      : [
          { type: 'claude-code' as const, label: 'Claude', startAction: true },
          { type: 'codex-cli' as const, label: 'Codex', startAction: true },
        ]),
  ];
  const processColor = tabEntry?.terminalStatus === 'server'
    ? 'text-ui-green'
    : tabEntry?.terminalStatus === 'running'
      ? 'text-ui-blue'
      : 'text-muted-foreground/50';

  const renderTabIcon = () => {
    if (panelType === 'claude-code') return <ClaudeCodeIcon size={16} />;
    if (panelType === 'codex-cli') return <OpenAIIcon size={16} className="shrink-0 text-foreground" aria-label="Codex" />;
    if (panelType === 'diff') return <GitCompareArrows className={cn(iconClassName, 'text-muted-foreground')} />;
    if (panelType === 'agent-sessions') return <History className={cn(iconClassName, 'text-muted-foreground')} />;
    return (
      <ProcessIcon
        process={tabEntry?.currentProcess}
        className={cn(iconClassName, processColor)}
      />
    );
  };

  const renderModeIcon = (mode: TModeButton) => {
    if (mode.type === 'terminal') return <TerminalSquare className={cn(iconClassName, 'text-muted-foreground')} />;
    return <MessageSquare className={cn(iconClassName, 'text-muted-foreground')} />;
  };

  const handleSelectMode = (mode: TModeButton) => {
    if (panelType === mode.type) {
      setModeDrawerOpen(false);
      return;
    }
    if (!tryAgentSwitch({
      current: panelType,
      target: mode.type,
      cliState: tabEntry?.cliState,
      agentProcess: tabEntry?.agentProcess,
      runningAgentPanelType: runtimeAgentPanelType,
    })) return;
    setModeDrawerOpen(false);
    if (mode.startAction && (mode.type === 'claude-code' || mode.type === 'codex-cli')) {
      window.dispatchEvent(new CustomEvent('purplemux-start-agent', {
        detail: {
          tabId,
          provider: mode.type === 'codex-cli' ? 'codex' : 'claude',
        },
      }));
      return;
    }
    onSwitchPanelType(mode.type);
  };

  return (
    <div className="flex h-11 shrink-0 items-center border-b border-border/50 bg-background">
      <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1">
          <TabStatusIndicator tabId={tabId} panelType={panelType} />
          {renderTabIcon()}
          <span className="min-w-0 flex-1 truncate text-xs text-foreground">{tabName}</span>
          {switchable && (
            <button
              type="button"
              className="h-7 rounded border border-border/70 bg-muted/30 px-2 text-xs text-muted-foreground"
              onClick={() => setModeDrawerOpen(true)}
              aria-label="Select tab mode"
            >
              {getAgentLabel(panelType)}
            </button>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 pr-0.5">
        {showCopy && (
          <button
            className={iconButtonClassName}
            onClick={() => setCopyOpen(true)}
            aria-label={tt('copyPaneLabel')}
            title={tt('copyPaneLabel')}
          >
            <Copy className={iconClassName} />
          </button>
        )}

        <button
          className={cn(
            iconButtonClassName,
            hasGitInlineStatus && 'w-auto gap-1 px-2',
          )}
          onClick={onOpenGit}
          aria-label="Open Git"
          title={gitTitle}
        >
          <GitCompareArrows className={iconClassName} />
          {gitPhase === 'error' && (
            <span className="text-[10px] font-semibold leading-none text-negative/70" aria-hidden="true">!</span>
          )}
          {gitIndicators.map((indicator) => (
            <span
              key={indicator.key}
              className={cn(
                'flex h-4 min-w-0 items-center justify-center text-[10px] font-medium leading-none',
                gitIndicatorToneClass[indicator.tone],
              )}
              aria-hidden="true"
            >
              {indicator.label}
            </span>
          ))}
        </button>

        <button
          className={iconButtonClassName}
          onClick={onCreateTab}
          aria-label={t('newTab')}
          title={t('newTab')}
        >
          <Plus className={iconClassName} />
        </button>

        <AlertDialog>
          <AlertDialogTrigger
            className={cn(iconButtonClassName, 'hover:text-ui-red')}
            aria-label={t('closeTab')}
            title={t('closeTab')}
          >
            <X className={iconClassName} />
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('closeTab')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('closeTabConfirm', { name: tabName })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{tc('cancel')}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-ui-red hover:bg-ui-red/80"
                onClick={onClose}
              >
                {tc('close')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <CopyPaneDrawer
        open={copyOpen}
        onOpenChange={setCopyOpen}
        sessionName={sessionName}
      />

      <Drawer open={modeDrawerOpen} onOpenChange={setModeDrawerOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>View as</DrawerTitle>
          </DrawerHeader>
          <div className="flex flex-col gap-1 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            {modeButtons.map((mode) => (
              <button
                key={mode.type}
                type="button"
                className={cn(
                  'flex min-h-11 items-center gap-3 rounded-md px-3 text-left text-sm text-foreground hover:bg-accent',
                  panelType === mode.type && 'bg-accent font-medium',
                )}
                onClick={() => handleSelectMode(mode)}
              >
                {renderModeIcon(mode)}
                <span>{getButtonLabel(mode)}</span>
              </button>
            ))}
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
};

export default MobileTabHeader;
