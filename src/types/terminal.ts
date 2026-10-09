import type { TCliState } from '@/types/timeline';

export type TConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'session-ended';

export type TDisconnectReason = 'max-connections' | 'pty-error' | 'session-not-found' | 'reconnect-exhausted' | null;

export type TPanelType = 'terminal' | 'claude-code' | 'codex-cli' | 'codex-chat' | 'agent-sessions' | 'web-browser' | 'diff';
export type TDiffViewMode = 'split' | 'unified';
export type TDiffTab = 'changes' | 'history';

export interface IDiffSettings {
  activeTab?: TDiffTab;
  viewMode?: TDiffViewMode;
  panelOpen?: boolean;
  panelSize?: number;
}

export interface IAgentState {
  providerId: string;
  sessionId: string | null;
  jsonlPath: string | null;
  summary: string | null;
}

export interface ITab {
  id: string;
  sessionName: string;
  name: string;
  order: number;
  title?: string;
  cwd?: string;
  panelType?: TPanelType;
  agentState?: IAgentState;
  /** @deprecated use agentState; kept for disk back-compat */
  claudeSessionId?: string | null;
  /** @deprecated use agentState; kept for disk back-compat */
  claudeJsonlPath?: string | null;
  /** @deprecated use agentState; kept for disk back-compat */
  claudeSummary?: string | null;
  lastUserMessage?: string | null;
  lastCommand?: string | null;
  cliState?: TCliState;
  dismissedAt?: number | null;
  webUrl?: string | null;
  terminalRatio?: number;
  terminalCollapsed?: boolean;
}

export interface ISplitNode {
  type: 'split';
  orientation: 'horizontal' | 'vertical';
  ratio: number;
  children: [TLayoutNode, TLayoutNode];
}

export interface IPaneNode {
  type: 'pane';
  id: string;
  tabs: ITab[];
  activeTabId: string | null;
}

export type TLayoutNode = ISplitNode | IPaneNode;

export interface ILayoutData {
  root: TLayoutNode;
  activePaneId: string | null;
  diffSettings?: IDiffSettings;
  updatedAt: string;
}

export interface IWorkspace {
  id: string;
  name: string;
  directories: string[];
  groupId?: string | null;
  hostId?: string;
  remoteDirectory?: string;
}

export interface IWorkspaceGroup {
  id: string;
  name: string;
  collapsed?: boolean;
}

export interface IWorkspacesData {
  workspaces: IWorkspace[];
  groups?: IWorkspaceGroup[];
  activeWorkspaceId?: string;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  updatedAt: string;
}
