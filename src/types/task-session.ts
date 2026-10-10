export type TaskSessionStatus = 'pending' | 'approved' | 'rejected' | 'revoked' | 'expired';
export interface TaskSession {
  id: string;
  purpose: string;
  hostId: string;
  workdir: string;
  scope: string;
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
  event: TaskSessionStatus;
  actor: 'gui:user' | 'mcp' | 'system';
  at: string;
}
