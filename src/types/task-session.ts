export type TaskSessionStatus = 'pending' | 'approved' | 'rejected' | 'revoked' | 'expired' | 'completed';
export interface TaskSession {
  id: string;
  purpose: string;
  hostId: string;
  workdir: string;
  scope: string;
  workspaceId?: string;
  tabId?: string;
  requestedPermissions?: 'full-access';
  fullAccessWarningAcceptedAt?: string;
  executionState?: 'idle' | 'running' | 'unknown' | 'complete';
  ownerInstance?: string;
  ownerLease?: { pid: number; processStart: string; expiresAt: string; releasedAt?: string };
  targetFingerprint?: string;
  targetConnection?: { address: string; username: string; port: number };
  pinnedThreadId?: string;
  turns?: TaskSessionTurn[];
  expiresAt: string;
  status: TaskSessionStatus;
  source: 'gui' | 'mcp';
  createdAt: string;
  updatedAt: string;
  /** Record identifier only. Never an execution credential. */
  sessionId?: string;
}
export interface TaskSessionAudit {
  id: string;
  taskId: string;
  event: TaskSessionStatus | 'turn-started' | 'turn-completed' | 'turn-failed';
  turnId?: string;
  threadId?: string;
  instructionHash?: string;
  result?: string;
  actor: 'gui:user' | 'mcp' | 'system';
  at: string;
}

export interface TaskSessionTurn {
  id: string;
  keyHash: string;
  instructionHash: string;
  /** Instructions are hashed only; raw input/output and secrets are never persisted. */
  instructionPreview: string;
  startedAt: string;
  finishedAt?: string;
  threadId?: string;
  turnId?: string;
  result: 'running' | 'completed' | 'failed' | 'unknown';
}
