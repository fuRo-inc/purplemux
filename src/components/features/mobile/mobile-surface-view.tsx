import { useState, useRef, useCallback, useEffect } from 'react';
import { Plus, WifiOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Spinner from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { IDiffSettings, ITab, TPanelType } from '@/types/terminal';
import WebBrowserPanel from '@/components/features/workspace/web-browser-panel';
import DiffPanel from '@/components/features/workspace/diff-panel';
import useTerminal from '@/hooks/use-terminal';
import useTerminalWebSocket from '@/hooks/use-terminal-websocket';
import useTabMetadataStore from '@/hooks/use-tab-metadata-store';
import TerminalContainer from '@/components/features/workspace/terminal-container';
import ConnectionStatus from '@/components/features/workspace/connection-status';
import MobileClaudeCodePanel from '@/components/features/mobile/mobile-claude-code-panel';
import MobileCodexPanel from '@/components/features/mobile/mobile-codex-panel';
import AgentSessionsPanel from '@/components/features/workspace/agent-sessions-panel';
import MobileTerminalToolbar from '@/components/features/mobile/mobile-terminal-toolbar';
import MobileTerminalHistory from '@/components/features/mobile/mobile-terminal-history';
import PaneAgentModePrompt from '@/components/features/workspace/pane-agent-mode-prompt';
import { formatTabTitle, isShellProcess } from '@/lib/tab-title';
import { isAppShortcut, isClearShortcut, isFocusInputShortcut, isShiftEnter } from '@/lib/keyboard-shortcuts';
import type { TCliState } from '@/types/timeline';
import useTerminalTheme from '@/hooks/use-terminal-theme';
import useTabStore, { getInitialTabStateFromLayoutTab, selectSessionView } from '@/hooks/use-tab-store';
import { useLayoutStore } from '@/hooks/use-layout';
import useConfigStore, { type TGitAskProvider } from '@/hooks/use-config-store';
import { resolveLineHeight } from '@/lib/terminal-line-height';
import useTrustPromptDetector from '@/hooks/use-trust-prompt-detector';
import useCodexUpdatePromptDetector from '@/hooks/use-codex-update-prompt-detector';
import { useAgentInstallCheck } from '@/hooks/use-agent-install-check';
import { buildClaudeLaunchCommand } from '@/lib/providers/claude/client';
import { fetchCodexLaunchCommand } from '@/lib/providers/codex/client';
import { sendCodexQuitCommand } from '@/lib/agent-terminal-commands';
import { toast } from 'sonner';
import type { IAgentSessionEntry } from '@/hooks/use-agent-sessions';
import {
  applyAgentCheckResult,
  isAgentPanelType,
  type IAgentCheckResponse,
  type TAgentPanelType,
} from '@/lib/agent-check';
import { reloadForReconnectRecovery } from '@/lib/ws-reload-recovery';


interface ITermActions {
  write: (data: Uint8Array) => void;
  reset: () => void;
  fit: () => { cols: number; rows: number };
  focus: () => void;
  getBufferText: () => string;
}

interface IWsActions {
  sendStdin: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
}

interface IAgentModePrompt {
  tabId: string;
  providerId: string;
  displayName: string;
  panelType: TAgentPanelType;
  sessionId: string | null;
  resumable: boolean;
}

const NOOP_TERM_ACTIONS: ITermActions = {
  write: () => {},
  reset: () => {},
  fit: () => ({ cols: 40, rows: 24 }),
  focus: () => {},
  getBufferText: () => '',
};

const NOOP_WS_ACTIONS: IWsActions = {
  sendStdin: () => {},
  sendResize: () => {},
};

interface IMobileSurfaceViewProps {
  paneId: string;
  tabs: ITab[];
  activeTabId: string | null;
  panelType: TPanelType;
  onCreateTab: (paneId: string, panelType?: TPanelType, command?: string) => Promise<ITab | null>;
  onDeleteTab: (paneId: string, tabId: string) => Promise<void>;
  onSwitchTab: (paneId: string, tabId: string) => void;
  onRemoveTabLocally: (paneId: string, tabId: string) => void;
  onUpdateTabPanelType: (paneId: string, tabId: string, panelType: TPanelType) => void;
  onUpdateDiffSettings: (patch: Partial<IDiffSettings>) => void;
  onCliStateChange?: (state: TCliState) => void;
  onOpenNewTabDialog?: () => void;
}

const MOBILE_FONT_SIZE = 11;

const MobileSurfaceView = ({
  paneId,
  tabs,
  activeTabId,
  panelType,
  onCreateTab,
  onDeleteTab,
  onSwitchTab,
  onRemoveTabLocally: _onRemoveTabLocally,
  onUpdateTabPanelType,
  onUpdateDiffSettings,
  onCliStateChange,
  onOpenNewTabDialog,
}: IMobileSurfaceViewProps) => {
  const t = useTranslations('mobile');
  const tt = useTranslations('terminal');
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const isClaudeCode = panelType === 'claude-code';
  const isCodex = panelType === 'codex-cli';
  const isAgentSessionList = panelType === 'agent-sessions';
  const isAgentPanel = isClaudeCode || isCodex;
  const usesHiddenTerminal = isAgentPanel || isAgentSessionList;
  const isWebBrowser = panelType === 'web-browser';
  const isDiff = panelType === 'diff';
  const { ensureAgentInstalled, installDialogs } = useAgentInstallCheck();

  const activeTabCwd = useTabMetadataStore(
    (state) => (activeTabId ? state.metadata[activeTabId]?.cwd : undefined),
  );
  const layoutWsId = useLayoutStore((state) => state.workspaceId);
  const diffSettings = useLayoutStore((state) => state.layout?.diffSettings);

  const { theme: terminalTheme } = useTerminalTheme();
  const configLineHeight = useConfigStore((s) => s.lineHeight);
  const configLineHeightCustom = useConfigStore((s) => s.lineHeightCustom);
  const [hasEverConnected, setHasEverConnected] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [showTerminal, setShowTerminal] = useState(true);

  const termActionsRef = useRef<ITermActions>(NOOP_TERM_ACTIONS);
  const wsActionsRef = useRef<IWsActions>(NOOP_WS_ACTIONS);
  const connectedSessionRef = useRef<string | null>(null);
  const prevConnectedTabIdRef = useRef<string | null>(null);
  const closingTabIdRef = useRef<string | null>(null);
  const [attemptedTabId, setAttemptedTabId] = useState<string | null>(null);

  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waitingForResizeRef = useRef(false);

  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);

  useEffect(() => {
    tabsRef.current = tabs;
    activeTabIdRef.current = activeTabId;
  });

  const fetchAndUpdateCwd = useCallback(async () => {
    const tabId = activeTabIdRef.current;
    const tab = tabId ? tabsRef.current.find((t) => t.id === tabId) : null;
    if (!tab) return;
    try {
      const res = await fetch(`/api/layout/cwd?session=${tab.sessionName}`);
      if (!res.ok) return;
      const { cwd } = await res.json();
      if (cwd) useTabMetadataStore.getState().setCwd(tab.id, cwd);
    } catch { /* ignore */ }
  }, []);

  const clearRef = useRef<() => void>(() => {});
  const focusInputRef = useRef<(() => void) | undefined>(undefined);
  const setInputValueRef = useRef<((v: string) => void) | undefined>(undefined);

  const pendingRestartRef = useRef<string | null>(null);
  const pendingAgentInputRef = useRef<{ text: string; provider: TGitAskProvider } | null>(null);
  const codexRelaunchRef = useRef<() => void | Promise<void>>(() => {});
  const lastTitleRef = useRef('');
  const agentProcess = useTabStore((s) => activeTabId ? s.tabs[activeTabId]?.agentProcess ?? null : null);
  const claudeSessionId = useTabStore((s) => activeTabId ? s.tabs[activeTabId]?.agentSessionId ?? null : null);
  const sessionView = useTabStore((s) => activeTabId ? selectSessionView(s.tabs, activeTabId) : null);
  const claudeCliState = useTabStore((s) => activeTabId ? s.tabs[activeTabId]?.cliState ?? 'inactive' : 'inactive');
  const agentModeShownTabsRef = useRef<Set<string>>(new Set());
  const [agentModePrompt, setAgentModePrompt] = useState<IAgentModePrompt | null>(null);

  const handleAgentCheckResult = useCallback((tabId: string, data: IAgentCheckResponse) => {
    if (data.running !== true || !isAgentPanelType(data.providerPanelType)) {
      setAgentModePrompt((prev) => (prev?.tabId === tabId ? null : prev));
      return;
    }

    const providerId = typeof data.providerId === 'string' && data.providerId
      ? data.providerId
      : data.providerPanelType;
    const promptKey = `${tabId}:${providerId}`;
    if (agentModeShownTabsRef.current.has(promptKey)) return;
    agentModeShownTabsRef.current.add(promptKey);

    const displayName = typeof data.providerDisplayName === 'string' && data.providerDisplayName
      ? data.providerDisplayName
      : providerId;
    setAgentModePrompt({
      tabId,
      providerId,
      displayName,
      panelType: data.providerPanelType,
      sessionId: typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : null,
      resumable: data.resumable === true,
    });
  }, []);

  const { trustPrompt, onTerminalData: onTrustData, onTrustResponse } = useTrustPromptDetector({
    enabled: (isClaudeCode || isCodex) && claudeCliState === 'inactive',
    getBufferText: () => termActionsRef.current.getBufferText(),
    sendStdin: (data) => wsActionsRef.current.sendStdin(data),
  });
  const {
    updatePrompt: codexUpdatePrompt,
    onTerminalData: onCodexUpdateData,
    onRespond: onCodexUpdateResponse,
  } = useCodexUpdatePromptDetector({
    enabled: isCodex && claudeCliState === 'inactive',
    scopeKey: activeTabId,
    getBufferText: () => termActionsRef.current.getBufferText(),
    sendStdin: (data) => wsActionsRef.current.sendStdin(data),
    onUpdated: () => { void codexRelaunchRef.current(); },
  });

  const handleCliStateChange = useCallback((state: TCliState) => {
    onCliStateChange?.(state);
  }, [onCliStateChange]);

   
  const handleInputVisibleChange = useCallback((_visible: boolean) => {}, []);

  const handleCustomKeyEvent = useCallback((event: KeyboardEvent): boolean => {
    if (isAppShortcut(event)) {
      event.preventDefault();
      if (isClearShortcut(event)) clearRef.current();
      if (isFocusInputShortcut(event)) focusInputRef.current?.();
      return false;
    }
    if (isShiftEnter(event)) {
      event.preventDefault();
      wsActionsRef.current.sendStdin('\n');
      return false;
    }
    return true;
  }, []);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyContent, setHistoryContent] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyRequestIdRef = useRef(0);

  const openTerminalHistory = useCallback(async () => {
    const workspaceId = layoutWsId;
    const session = activeTab?.sessionName;
    if (!workspaceId || !session) return;

    const requestId = ++historyRequestIdRef.current;
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError(null);
    // Release the virtual keyboard while browsing terminal history.
    if (document.activeElement instanceof HTMLElement &&
        document.activeElement.matches('.xterm-helper-textarea')) {
      document.activeElement.blur();
    }
    try {
      const query = new URLSearchParams({ workspace: workspaceId, session });
      const response = await fetch(`/api/terminal/history?${query}`, { cache: 'no-store' });
      const data: { content?: string; error?: string } = await response.json();
      if (!response.ok) throw new Error(data.error || '履歴の取得に失敗しました');
      if (requestId !== historyRequestIdRef.current) return;
      setHistoryContent(data.content ?? '');
    } catch (err) {
      if (requestId !== historyRequestIdRef.current) return;
      setHistoryError(err instanceof Error ? err.message : '通信エラー');
    } finally {
      if (requestId === historyRequestIdRef.current) setHistoryLoading(false);
    }
  }, [layoutWsId, activeTab?.sessionName]);

  const closeTerminalHistory = useCallback(() => {
    historyRequestIdRef.current++;
    setHistoryOpen(false);
    setHistoryLoading(false);
    setHistoryError(null);
    setHistoryContent(null);
  }, []);

  useEffect(() => {
    closeTerminalHistory();
    return () => { historyRequestIdRef.current++; };
  }, [layoutWsId, activeTab?.sessionName, closeTerminalHistory]);

  const { terminalRef, write, clear, reset, fit, focus, isReady, getBufferText, copyTerminalText } = useTerminal({
    theme: terminalTheme.colors,
    fontSize: isAgentPanel ? undefined : MOBILE_FONT_SIZE,
    lineHeight: resolveLineHeight(configLineHeight, configLineHeightCustom),
    onInput: (data) => wsActionsRef.current.sendStdin(data),
    onHistoryRequested: () => { if (!historyOpen && !historyLoading) void openTerminalHistory(); },
    onResize: (cols, rows) => {
      wsActionsRef.current.sendResize(cols, rows);
      if (waitingForResizeRef.current) {
        if (showTimerRef.current) clearTimeout(showTimerRef.current);
        showTimerRef.current = setTimeout(() => {
          waitingForResizeRef.current = false;
          setShowTerminal(true);
        }, 200);
      }
    },
    onTitleChange: (title) => {
      const tabId = activeTabIdRef.current;
      if (!tabId) return;
      const activeTab = tabsRef.current.find((t) => t.id === tabId);
      if (!activeTab) return;
      if (activeTab.panelType === 'web-browser' || activeTab.panelType === 'agent-sessions') return;
      if (title === lastTitleRef.current) return;
      lastTitleRef.current = title;
      const formatted = formatTabTitle(title, activeTab?.panelType);
      useTabMetadataStore.getState().setTitle(tabId, formatted);
      if (isShellProcess(title) && pendingRestartRef.current) {
        const cmd = pendingRestartRef.current;
        pendingRestartRef.current = null;
        wsActionsRef.current.sendStdin(`${cmd}\r`);
      }
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (tab) {
        const prevCheckedAt = useTabStore.getState().tabs[tabId]?.agentProcessCheckedAt ?? 0;
        fetch(`/api/check-agent?session=${tab.sessionName}`)
          .then((res) => res.json())
          .then((data: IAgentCheckResponse) => {
            if (activeTab?.panelType === 'terminal') handleAgentCheckResult(tabId, data);
            const running = data.running === true && isAgentPanelType(data.providerPanelType);
            const current = useTabStore.getState().tabs[tabId];
            if (current && current.agentProcessCheckedAt !== prevCheckedAt) {
              if (current.agentProcess !== running) {
                setTimeout(() => {
                  fetch(`/api/check-agent?session=${tab.sessionName}`)
                    .then((r) => r.json())
                    .then((retryData: IAgentCheckResponse) => {
                      if (activeTab?.panelType === 'terminal') handleAgentCheckResult(tabId, retryData);
                      applyAgentCheckResult(tabId, retryData);
                    })
                    .catch(() => {});
                }, 500);
              }
              return;
            }
            applyAgentCheckResult(tabId, data);
          })
          .catch(() => {});
      }
      fetchAndUpdateCwd();
    },
    customKeyEventHandler: handleCustomKeyEvent,
  });

  useEffect(() => {
    clearRef.current = clear;
  });

  const handleSessionEnded = useCallback(async () => {
    if (closingTabIdRef.current) return;

    const currentTabs = tabsRef.current;
    const currentActiveTabId = activeTabIdRef.current;
    if (!currentActiveTabId) return;

    closingTabIdRef.current = currentActiveTabId;

    const sorted = [...currentTabs].sort((a, b) => a.order - b.order);
    const idx = sorted.findIndex((t) => t.id === currentActiveTabId);
    const adjacent = sorted[idx + 1] || sorted[idx - 1];

    if (adjacent) {
      onSwitchTab(paneId, adjacent.id);
    }

    try {
      await onDeleteTab(paneId, currentActiveTabId);
    } finally {
      closingTabIdRef.current = null;
    }
  }, [paneId, onSwitchTab, onDeleteTab]);

  const {
    status,
    retryCount,
    disconnectReason,
    connect,
    reconnect,
    sendStdin,
    sendWebStdin,
    sendResize,
  } = useTerminalWebSocket({
    onData: (data) => {
      termActionsRef.current.write(data);
      onTrustData();
      onCodexUpdateData();
    },
    onConnected: () => {
      setHasEverConnected(true);
      setAttemptedTabId(activeTabIdRef.current);
      prevConnectedTabIdRef.current = activeTabIdRef.current;
      const tabId = activeTabIdRef.current;
      if (tabId) useTabStore.getState().setTerminalConnected(tabId, true);
      const { cols, rows } = termActionsRef.current.fit();
      wsActionsRef.current.sendResize(cols, rows);
      fetchAndUpdateCwd();
    },
    onSessionEnded: handleSessionEnded,
  });

  useEffect(() => {
    termActionsRef.current = { write, reset, fit, focus, getBufferText };
    wsActionsRef.current = { sendStdin, sendResize };
  });

  useEffect(() => {
    if (!isReady) connectedSessionRef.current = null;
  }, [isReady]);

  useEffect(() => {
    if (!isReady || !activeTabId) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    if (tab.panelType === 'web-browser') {
      connectedSessionRef.current = null;
      lastTitleRef.current = '';
      return;
    }
    if (connectedSessionRef.current === tab.sessionName) return;

    if (connectedSessionRef.current !== null) reset();

    const tabStore = useTabStore.getState();
    const existingTabState = tabStore.tabs[activeTabId];

    tabStore.initTab(activeTabId, {
      terminalConnected: false,
      panelType: tab.panelType,
      ...(!existingTabState ? getInitialTabStateFromLayoutTab(tab) : {}),
    });

    connectedSessionRef.current = tab.sessionName;
    connect(tab.sessionName);
  }, [isReady, activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    useTabStore.getState().setTerminalConnected(tabId, status === 'connected');
  }, [status]);

  useEffect(() => {
    if (status === 'disconnected' && hasEverConnected) {
      setAttemptedTabId(activeTabIdRef.current);
    }
  }, [status, hasEverConnected]);

  useEffect(() => {
    if (
      status === 'disconnected' &&
      hasEverConnected &&
      prevConnectedTabIdRef.current &&
      prevConnectedTabIdRef.current !== activeTabId &&
      tabs.some((t) => t.id === prevConnectedTabIdRef.current)
    ) {
      connectedSessionRef.current = null;
      onSwitchTab(paneId, prevConnectedTabIdRef.current);
    }
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isReady || status !== 'connected') return;
    const timer = setTimeout(() => {
      const { cols, rows } = fit();
      wsActionsRef.current.sendResize(cols, rows);
    }, 300);
    return () => clearTimeout(timer);
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isAgentPanel) {
      waitingForResizeRef.current = false;
      if (showTimerRef.current) clearTimeout(showTimerRef.current);
      fetchAndUpdateCwd();
      return;
    }
    if (isReady && status === 'connected') {
      waitingForResizeRef.current = true;
      queueMicrotask(() => setShowTerminal(false));
      showTimerRef.current = setTimeout(() => {
        waitingForResizeRef.current = false;
        setShowTerminal(true);
      }, 200);
      return () => {
        if (showTimerRef.current) clearTimeout(showTimerRef.current);
        waitingForResizeRef.current = false;
      };
    }
    queueMicrotask(() => setShowTerminal(true));
  }, [isAgentPanel]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreateTab = useCallback(async () => {
    setIsCreating(true);
    await onCreateTab(paneId);
    setIsCreating(false);
  }, [paneId, onCreateTab]);

  const buildClaudeCommand = useCallback((resumeSessionId?: string | null): string =>
    buildClaudeLaunchCommand({
      workspaceId: layoutWsId,
      dangerouslySkipPermissions: useConfigStore.getState().dangerouslySkipPermissions,
      resumeSessionId,
    }), [layoutWsId]);

  const handleNewClaudeSession = useCallback(async () => {
    if (status !== 'connected' || !activeTabId) return;
    if (!await ensureAgentInstalled('claude')) return;
    useTabStore.getState().setSessionView(activeTabId, 'check');
    sendStdin(`${buildClaudeCommand(null)}\r`);
  }, [status, sendStdin, activeTabId, buildClaudeCommand, ensureAgentInstalled]);

  const handleRestartClaudeSession = useCallback(async () => {
    if (status !== 'connected' || !activeTabId) return;
    if (!await ensureAgentInstalled('claude')) return;
    pendingRestartRef.current = buildClaudeCommand(null);
    useTabStore.getState().setSessionView(activeTabId, 'check');
    sendStdin('/exit\r');
  }, [status, sendStdin, activeTabId, buildClaudeCommand, ensureAgentInstalled]);

  const buildCodexCommand = useCallback(
    () => fetchCodexLaunchCommand(layoutWsId),
    [layoutWsId],
  );

  const markAgentLaunch = useCallback((tabId: string, options?: { resetAgentSession?: boolean }) => {
    fetch('/api/status/agent-launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId, resetAgentSession: options?.resetAgentSession === true }),
    }).catch(() => {});
  }, []);

  const handleNewCodexSession = useCallback(async () => {
    if (status !== 'connected' || !activeTabId) return;
    if (!await ensureAgentInstalled('codex')) return;
    let command: string;
    try {
      command = await buildCodexCommand();
    } catch {
      toast.error(tt('codexLaunchFailed'));
      return;
    }
    markAgentLaunch(activeTabId, { resetAgentSession: true });
    useTabStore.getState().setSessionView(activeTabId, 'check');
    sendStdin(`${command}\r`);
  }, [status, sendStdin, activeTabId, buildCodexCommand, ensureAgentInstalled, markAgentLaunch, tt]);

  const handleNewClaudeFromSessionList = useCallback(async () => {
    if (!activeTabId) return;
    if (!await ensureAgentInstalled('claude')) return;
    onUpdateTabPanelType(paneId, activeTabId, 'claude-code');
    void handleNewClaudeSession();
  }, [activeTabId, ensureAgentInstalled, handleNewClaudeSession, onUpdateTabPanelType, paneId]);

  const handleNewCodexFromSessionList = useCallback(async () => {
    if (!activeTabId) return;
    if (!await ensureAgentInstalled('codex')) return;
    onUpdateTabPanelType(paneId, activeTabId, 'codex-cli');
    void handleNewCodexSession();
  }, [activeTabId, ensureAgentInstalled, handleNewCodexSession, onUpdateTabPanelType, paneId]);

  const handleSelectAgentSession = useCallback(async (session: IAgentSessionEntry) => {
    if (status !== 'connected' || !activeTabId) return;
    const nextPanelType = session.provider === 'codex' ? 'codex-cli' : 'claude-code';
    if (!await ensureAgentInstalled(session.provider)) return;
    onUpdateTabPanelType(paneId, activeTabId, nextPanelType);
    useTabStore.getState().setSessionView(activeTabId, 'check');

    if (session.provider === 'codex') {
      let command: string;
      try {
        command = await fetchCodexLaunchCommand(layoutWsId, session.sessionId);
      } catch {
        toast.error(tt('codexLaunchFailed'));
        return;
      }
      markAgentLaunch(activeTabId, { resetAgentSession: false });
      sendStdin(`${command}\r`);
      return;
    }

    sendStdin(`${buildClaudeCommand(session.sessionId)}\r`);
  }, [activeTabId, buildClaudeCommand, ensureAgentInstalled, layoutWsId, markAgentLaunch, onUpdateTabPanelType, paneId, sendStdin, status, tt]);

  const handleRelaunchCodexSession = useCallback(async () => {
    if (status !== 'connected' || !activeTabId) return;
    if (!await ensureAgentInstalled('codex')) return;
    let command: string;
    try {
      command = await buildCodexCommand();
    } catch {
      toast.error(tt('codexLaunchFailed'));
      return;
    }
    markAgentLaunch(activeTabId, { resetAgentSession: true });
    useTabStore.getState().setSessionView(activeTabId, 'check');
    sendStdin(`${command}\r`);
  }, [status, sendStdin, activeTabId, buildCodexCommand, ensureAgentInstalled, markAgentLaunch, tt]);

  useEffect(() => {
    codexRelaunchRef.current = handleRelaunchCodexSession;
  }, [handleRelaunchCodexSession]);

  const handleRestartCodexSession = useCallback(async () => {
    if (status !== 'connected' || !activeTabId) return;
    if (!await ensureAgentInstalled('codex')) return;
    let command: string;
    try {
      command = await buildCodexCommand();
    } catch {
      toast.error(tt('codexLaunchFailed'));
      return;
    }
    pendingRestartRef.current = command;
    markAgentLaunch(activeTabId, { resetAgentSession: true });
    useTabStore.getState().setSessionView(activeTabId, 'check');
    sendCodexQuitCommand(sendStdin);
  }, [status, sendStdin, activeTabId, buildCodexCommand, ensureAgentInstalled, markAgentLaunch, tt]);

  useEffect(() => {
    const handleStartAgentRequest = (event: Event) => {
      const detail = (event as CustomEvent<{
        tabId?: string;
        provider?: TGitAskProvider;
      }>).detail;
      if (detail?.tabId !== activeTabId) return;
      if (detail.provider !== 'claude' && detail.provider !== 'codex') return;
      const provider = detail.provider;
      void (async () => {
        if (!await ensureAgentInstalled(provider)) return;
        onUpdateTabPanelType(paneId, activeTabId, provider === 'codex' ? 'codex-cli' : 'claude-code');
        if (provider === 'codex') {
          void handleNewCodexSession();
          return;
        }
        void handleNewClaudeSession();
      })();
    };

    window.addEventListener('purplemux-start-agent', handleStartAgentRequest);
    return () => window.removeEventListener('purplemux-start-agent', handleStartAgentRequest);
  }, [activeTabId, ensureAgentInstalled, handleNewClaudeSession, handleNewCodexSession, onUpdateTabPanelType, paneId]);

  useEffect(() => {
    if (!pendingRestartRef.current || agentProcess === true) return;
    if (status !== 'connected') return;
    if (!isShellProcess(lastTitleRef.current)) return;
    const cmd = pendingRestartRef.current;
    pendingRestartRef.current = null;
    const tabId = activeTabIdRef.current;
    if (tabId) markAgentLaunch(tabId);
    sendStdin(`${cmd}\r`);
  }, [agentProcess, status, sendStdin, markAgentLaunch]);

  useEffect(() => {
    if (!activeTabId || agentProcess !== true || panelType !== 'terminal') {
      setAgentModePrompt(null);
      return;
    }
    if (agentModePrompt?.tabId !== activeTabId) return;
  }, [activeTabId, agentProcess, panelType, agentModePrompt]);

  useEffect(() => {
    if (!activeTabId || agentProcess !== true || panelType !== 'terminal') return;
    if (agentModePrompt?.tabId === activeTabId) return;
    const sessionName = activeTab?.sessionName;
    if (!sessionName) return;

    let cancelled = false;
    fetch(`/api/check-agent?session=${sessionName}`)
      .then((res) => res.json())
      .then((data: IAgentCheckResponse) => {
        if (!cancelled) handleAgentCheckResult(activeTabId, data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeTabId, activeTab?.sessionName, agentProcess, panelType, agentModePrompt?.tabId, handleAgentCheckResult]);

  const handleSwitchToAgentMode = useCallback(async () => {
    const prompt = agentModePrompt;
    if (!activeTabId || !prompt || prompt.tabId !== activeTabId) return;
    setAgentModePrompt(null);
    onUpdateTabPanelType(paneId, activeTabId, prompt.panelType);
    if (status !== 'connected') return;

    const resumeSessionId = prompt.resumable ? prompt.sessionId : null;
    if (prompt.panelType === 'codex-cli') {
      if (!await ensureAgentInstalled('codex')) return;
      let command: string;
      try {
        command = await fetchCodexLaunchCommand(layoutWsId, resumeSessionId);
      } catch {
        toast.error(tt('codexLaunchFailed'));
        return;
      }
      pendingRestartRef.current = command;
      markAgentLaunch(activeTabId, { resetAgentSession: !resumeSessionId });
      useTabStore.getState().setSessionView(activeTabId, 'check');
      sendCodexQuitCommand(sendStdin);
      return;
    }

    if (!await ensureAgentInstalled('claude')) return;
    pendingRestartRef.current = buildClaudeCommand(resumeSessionId);
    useTabStore.getState().setSessionView(activeTabId, 'check');
    sendStdin('\x03');
    setTimeout(() => sendStdin('\x03'), 300);
  }, [activeTabId, agentModePrompt, buildClaudeCommand, ensureAgentInstalled, layoutWsId, markAgentLaunch, onUpdateTabPanelType, paneId, sendStdin, status, tt]);

  const handleSendToAgent = useCallback(async (text: string, provider: TGitAskProvider) => {
    if (!activeTabId) return;
    if (!await ensureAgentInstalled(provider)) return;
    pendingAgentInputRef.current = { text, provider };
    onUpdateTabPanelType(paneId, activeTabId, provider === 'codex' ? 'codex-cli' : 'claude-code');
  }, [activeTabId, ensureAgentInstalled, paneId, onUpdateTabPanelType]);

  useEffect(() => {
    const handleGitAgentRequest = (event: Event) => {
      const detail = (event as CustomEvent<{
        paneId?: string;
        text?: string;
        provider?: TGitAskProvider;
      }>).detail;
      if (detail?.paneId !== paneId || !detail.text || !detail.provider) return;
      void handleSendToAgent(detail.text, detail.provider);
    };

    window.addEventListener('purplemux-send-to-agent', handleGitAgentRequest);
    return () => window.removeEventListener('purplemux-send-to-agent', handleGitAgentRequest);
  }, [paneId, handleSendToAgent]);

  useEffect(() => {
    const pending = pendingAgentInputRef.current;
    if (!pending) return;
    const targetPanelType: TPanelType = pending.provider === 'codex' ? 'codex-cli' : 'claude-code';
    if (panelType !== targetPanelType) return;
    pendingAgentInputRef.current = null;
    const timer = window.setTimeout(() => {
      setInputValueRef.current?.(pending.text);
      focusInputRef.current?.();
    }, 100);
    return () => window.clearTimeout(timer);
  }, [panelType]);

  const handleWebUrlChange = useCallback((url: string) => {
    if (!activeTabId || !layoutWsId) return;
    fetch(`/api/layout/pane/${paneId}/tabs/${activeTabId}?workspace=${layoutWsId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webUrl: url }),
    }).catch(() => {});
  }, [activeTabId, paneId, layoutWsId]);

  // Keep the terminal pane above the mobile software keyboard.
  // iOS Safari often changes visualViewport without changing CSS 100vh.
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [keyboardViewportHeight, setKeyboardViewportHeight] = useState<number | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const surface = surfaceRef.current;
      if (!surface) return;
      const focused = document.activeElement;
      const keyboardOpen = window.innerHeight - viewport.height - viewport.offsetTop > 120;
      if (!keyboardOpen || !focused || !surface.contains(focused)) {
        setKeyboardViewportHeight(null);
        return;
      }
      const top = surface.getBoundingClientRect().top;
      setKeyboardViewportHeight(Math.max(180, viewport.height + viewport.offsetTop - top));
    };
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, []);

  const noTabs = tabs.length === 0;
  const ready = isWebBrowser || isDiff || isAgentSessionList || (isReady && status === 'connected' && !noTabs);
  const isFirstConnectionForTab =
    activeTabId !== null && attemptedTabId !== activeTabId;

  const autoRestartedTabsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (status !== 'disconnected' || disconnectReason !== 'session-not-found') return;
    if (isFirstConnectionForTab) return;
    if (!activeTabId || !activeTab) return;
    const effectivePanelType = activeTab.panelType ?? 'terminal';
    if (effectivePanelType !== 'terminal') return;
    if (activeTab.lastCommand) return;
    if (autoRestartedTabsRef.current.has(activeTabId)) return;
    autoRestartedTabsRef.current.add(activeTabId);
    (async () => {
      const ok = await useLayoutStore.getState().restartTabInPane(paneId, activeTabId);
      if (ok) reconnect();
    })();
  }, [status, disconnectReason, activeTabId, activeTab, isFirstConnectionForTab, paneId, reconnect]);

  return (
    <div
      ref={surfaceRef}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      style={{
        backgroundColor: terminalTheme.colors.background,
        overscrollBehavior: 'none',
        ...(keyboardViewportHeight !== null ? { height: keyboardViewportHeight, maxHeight: keyboardViewportHeight, flex: 'none' } : {}),
      }}
    >
      {isWebBrowser && activeTabId && (
        <WebBrowserPanel
          key={activeTabId}
          tabId={activeTabId}
          initialUrl={activeTab?.webUrl}
          onUrlChange={handleWebUrlChange}
        />
      )}

      {isDiff && activeTab && (
        <DiffPanel
          key={activeTab.sessionName}
          sessionName={activeTab.sessionName}
          onSendToAgent={handleSendToAgent}
          settings={diffSettings}
          onSettingsChange={onUpdateDiffSettings}
        />
      )}

      {isAgentSessionList && activeTab && (
        <AgentSessionsPanel
          key={activeTab.sessionName}
          sessionName={activeTab.sessionName}
          cwd={activeTabCwd || activeTab.cwd}
          onSelectSession={handleSelectAgentSession}
          onNewClaudeSession={handleNewClaudeFromSessionList}
          onNewCodexSession={handleNewCodexFromSessionList}
        />
      )}

      {isClaudeCode && activeTab && (
        <MobileClaudeCodePanel
          tabId={activeTabId ?? undefined}
          wsId={layoutWsId ?? undefined}
          sessionName={activeTab.sessionName}
          claudeSessionId={claudeSessionId}
          cwd={activeTabCwd}
          sendStdin={sendWebStdin}
          terminalWsConnected={status === 'connected'}
          focusTerminal={focus}
          focusInputRef={focusInputRef}
          setInputValueRef={setInputValueRef}
          onCliStateChange={handleCliStateChange}
          onInputVisibleChange={handleInputVisibleChange}
          onRestartSession={handleRestartClaudeSession}
          onNewSession={handleNewClaudeSession}
          trustPrompt={trustPrompt}
          onTrustResponse={onTrustResponse}
        />
      )}

      {isCodex && activeTab && (
        <MobileCodexPanel
          tabId={activeTabId ?? undefined}
          wsId={layoutWsId ?? undefined}
          sessionName={activeTab.sessionName}
          cwd={activeTabCwd || activeTab.cwd}
          sendStdin={sendWebStdin}
          terminalWsConnected={status === 'connected'}
          focusTerminal={focus}
          focusInputRef={focusInputRef}
          setInputValueRef={setInputValueRef}
          onNewSession={handleNewCodexSession}
          onRestart={handleRestartCodexSession}
          updatePrompt={codexUpdatePrompt}
          onUpdatePromptResponse={onCodexUpdateResponse}
          trustPrompt={trustPrompt}
          onTrustResponse={onTrustResponse}
        />
      )}

      {!isWebBrowser && !isDiff && (
        <TerminalContainer
          ref={terminalRef}
          className={cn(
            !usesHiddenTerminal && 'transition-opacity duration-150',
            usesHiddenTerminal ? 'absolute inset-0 pointer-events-none opacity-0' : 'min-h-0 flex-1',
            !usesHiddenTerminal && ready && showTerminal ? 'opacity-100' : '',
            !usesHiddenTerminal && (!ready || !showTerminal) ? 'opacity-0' : '',
          )}
        />
      )}

      {!isAgentPanel && !isWebBrowser && !isDiff && !isAgentSessionList && status === 'connected' && (
        <MobileTerminalToolbar sendStdin={sendWebStdin} terminalConnected={status === 'connected'} onCopy={() => void copyTerminalText()} onFocusTerminal={focus} />
      )}

      {historyOpen && (
        <MobileTerminalHistory
          content={historyContent}
          loading={historyLoading}
          error={historyError}
          onClose={closeTerminalHistory}
          onReload={() => void openTerminalHistory()}
        />
      )}

      {agentModePrompt && agentModePrompt.tabId === activeTabId && panelType === 'terminal' && (
        <PaneAgentModePrompt
          modeName={agentModePrompt.displayName}
          onSwitch={handleSwitchToAgentMode}
          onDismiss={() => setAgentModePrompt(null)}
          className="bottom-28"
        />
      )}

      {noTabs && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3">
          <Button className="gap-1.5" onClick={onOpenNewTabDialog ?? handleCreateTab} disabled={isCreating}>
            {isCreating ? (
              <Spinner className="h-3 w-3" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {tt('openNewTab')}
          </Button>
        </div>
      )}


      {!noTabs && !isWebBrowser && status === 'disconnected' && !isFirstConnectionForTab && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3">
          <WifiOff className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            {disconnectReason === 'max-connections'
              ? t('disconnectedMaxConnections')
              : disconnectReason === 'pty-error'
                ? t('disconnectedPtyError')
                : disconnectReason === 'session-not-found'
                  ? tt('disconnectedSessionNotFound')
                  : t('cannotConnectServer')}
          </span>
          {disconnectReason === 'session-not-found' && activeTabId ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const ok = await useLayoutStore.getState().restartTabInPane(paneId, activeTabId);
                  if (ok) reconnect();
                }}
              >
                {t('restart')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDeleteTab(paneId, activeTabId)}
              >
                {tt('closeTabLabel')}
              </Button>
            </div>
          ) : disconnectReason === 'reconnect-exhausted' ? (
            <Button variant="outline" size="sm" onClick={() => reloadForReconnectRecovery('terminal')}>
              {t('restart')}
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={reconnect}>
              {t('reconnect')}
            </Button>
          )}
        </div>
      )}

      {!noTabs && !isWebBrowser && !isDiff && !(isAgentPanel && sessionView === 'check') && (
        <ConnectionStatus
          status={status}
          retryCount={retryCount}
          disconnectReason={disconnectReason}
          onReconnect={reconnect}
        />
      )}
      {installDialogs}
    </div>
  );
};

export default MobileSurfaceView;
