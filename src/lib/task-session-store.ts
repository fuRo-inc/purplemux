/** Durable approval and turn reservations. Never starts a Codex process. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TaskSession, TaskSessionAudit, TaskSessionTurn } from '@/types/task-session';

export class TaskSessionError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
export const TASK_SESSION_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/);
// Reject common credential material instead of persisting it or echoing it in errors.
const text = z.string().trim().min(1).max(2000).refine((s) =>
  !/[\x00-\x08\x0b-\x1f\x7f]/.test(s) &&
  !/(?:-----BEGIN .*PRIVATE KEY|\b(?:sk-|ghp_|github_pat_)[a-zA-Z0-9_-]{16,}|\bBearer\s+\S+|\b(?:password|token|secret|api[_-]?key)\s*[:=]\s*\S+)/i.test(s));
const workdir = z.string().max(4096).refine((s) =>
  s.startsWith('/') && path.posix.normalize(s) === s &&
  !/[\x00-\x1f\x7f]/.test(s) && !s.includes('://'));
const processState = globalThis as unknown as { __purplemuxTaskSessionInstance?: string };
export const TASK_SESSION_INSTANCE = processState.__purplemuxTaskSessionInstance ||= randomUUID();
export const fullAccessEnabled = () => process.env.PURPLEMUX_MCP_ALLOW_WRITES === '1' && process.env.PURPLEMUX_MCP_ALLOW_FULL_ACCESS === '1';
const targetFields = { workspaceId: id.optional(), tabId: id.optional(), requestedPermissions: z.literal('full-access').optional() };
const inputSchema = z.object({
  purpose: text, hostId: id, workdir, scope: text,
  expiresAt: z.iso.datetime({ offset: true }).optional(), ttl: z.number().int().min(1).max(86400).optional(), idempotencyKey: id, ...targetFields,
}).strict();
const turnSchema = z.object({
  id: z.uuid(), keyHash: z.string(), instructionHash: z.string(), instructionPreview: z.string().max(220),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(), threadId: z.string().optional(), turnId: z.string().optional(),
  result: z.enum(['running', 'completed', 'failed', 'unknown']),
});
const recordSchema = inputSchema.omit({ idempotencyKey: true, ttl: true }).extend({
  expiresAt: z.iso.datetime({ offset: true }),
  fullAccessWarningAcceptedAt: z.iso.datetime().optional(), executionState: z.enum(['idle', 'running', 'unknown', 'complete']).optional(),
  ownerInstance: z.string().optional(), pinnedThreadId: z.string().optional(), turns: z.array(turnSchema).max(1000).optional(),
  id: z.uuid(), status: z.enum(['pending', 'approved', 'rejected', 'revoked', 'expired', 'completed']),
  source: z.enum(['gui', 'mcp']), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  sessionId: z.uuid().optional(),
});
const auditSchema = z.object({
  id: z.uuid(), taskId: z.uuid(), event: z.enum(['pending', 'approved', 'rejected', 'revoked', 'expired', 'completed', 'turn-started', 'turn-completed', 'turn-failed']),
  turnId: z.string().optional(), threadId: z.string().optional(), instructionHash: z.string().optional(), result: z.string().optional(),
  actor: z.enum(['gui:user', 'mcp', 'system']), at: z.iso.datetime(),
});
const stateSchema = z.object({
  version: z.literal(1), records: z.array(recordSchema).max(5000),
  audit: z.array(auditSchema).max(25000),
  keys: z.record(z.string(), z.object({ fingerprint: z.string(), taskId: z.uuid() })),
});
type State = z.infer<typeof stateSchema>;
export type TaskSessionTargetValidator = (hostId: string, workdir: string, workspaceId?: string, tabId?: string) => Promise<void>;

/** Passive validation: read configuration only; never contact SSH or mutate a workspace. */
export const validateTaskSessionTarget: TaskSessionTargetValidator = async (hostId, cwd, workspaceId, tabId) => {
  if (workspaceId && tabId) {
    const { resolveCodexAppTab } = await import('@/lib/codex-app-tab');
    const { workspace, tab } = await resolveCodexAppTab(workspaceId, tabId);
    const directory = workspace.hostId ? workspace.remoteDirectory : (tab.cwd || workspace.directories[0]);
    if ((workspace.hostId || 'local') !== hostId || directory !== cwd) throw new TaskSessionError('Host/cwd/workspace/tab mismatch');
    if (hostId === 'local') {
      if (!(await fs.stat(cwd)).isDirectory()) throw new TaskSessionError('Workspace directory unavailable');
    } else {
      try {
        const hosts = JSON.parse(await fs.readFile(path.join(os.homedir(), '.purplemux', 'hosts.json'), 'utf8'));
        if (!hosts.hosts?.some((h: { id: string }) => h.id === hostId)) throw new Error();
      } catch { throw new TaskSessionError('Host is no longer registered'); }
    }
    return;
  }
  const base = path.join(os.homedir(), '.purplemux');
  try {
    if (hostId !== 'local') {
      const hosts = JSON.parse(await fs.readFile(path.join(base, 'hosts.json'), 'utf8'));
      if (!hosts.hosts?.some((h: { id: string }) => h.id === hostId)) throw new Error();
    }
    const state = JSON.parse(await fs.readFile(path.join(base, 'workspaces.json'), 'utf8'));
    const matched = state.workspaces?.some((w: { hostId?: string; remoteDirectory?: string; directories: string[] }) =>
      (w.hostId || 'local') === hostId &&
      (hostId === 'local' ? w.directories?.includes(cwd) : w.remoteDirectory === cwd));
    if (!matched) throw new Error();
    if (hostId === 'local' && !(await fs.stat(cwd)).isDirectory()) throw new Error();
  } catch { throw new TaskSessionError('Host/workdir must match an existing configured workspace'); }
};

export class TaskSessionStore {
  constructor(private readonly directory: string, private readonly validateTarget: TaskSessionTargetValidator,
    private readonly clock = Date.now, private readonly instance: string = TASK_SESSION_INSTANCE) {}

  private async transaction<T>(fn: (state: State) => Promise<T>): Promise<T> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.directory)).isSymbolicLink()) throw new TaskSessionError('Storage unavailable', 503);
    const lock = path.join(this.directory, 'lock');
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await fs.mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new TaskSessionError('Storage busy; retry later', 503);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const file = path.join(this.directory, 'records.json');
    const tmp = path.join(this.directory, randomUUID() + '.tmp');
    try {
      let state: State;
      try {
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { state = stateSchema.parse(JSON.parse(await handle.readFile('utf8'))); }
        finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new TaskSessionError('Storage unavailable', 503);
        state = { version: 1, records: [], audit: [], keys: {} };
      }
      for (const record of state.records) {
        if (record.status === 'approved' && record.ownerInstance && record.ownerInstance !== this.instance) {
          record.executionState = 'unknown';
          this.transition(state, record, 'revoked', 'system');
        }
        if (['pending', 'approved'].includes(record.status) && Date.parse(record.expiresAt) <= this.clock()) {
          this.transition(state, record, 'expired', 'system');
        }
      }
      // Persist expiry even if the requested operation fails.
      let result!: T;
      let failure: unknown;
      try { result = await fn(state); } catch (error) { failure = error; }
      stateSchema.parse(state);
      const handle = await fs.open(tmp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(tmp, file);
      const dirHandle = await fs.open(this.directory, 'r');
      try { await dirHandle.sync(); } finally { await dirHandle.close(); }
      if (failure) throw failure;
      return result;
    } finally {
      await fs.unlink(tmp).catch(() => {});
      await fs.rmdir(lock);
    }
  }

  private transition(state: State, record: TaskSession, event: TaskSession['status'], actor: TaskSessionAudit['actor']) {
    record.status = event;
    record.updatedAt = new Date(this.clock()).toISOString();
    if (['revoked', 'expired', 'completed'].includes(event)) {
      if (record.ownerInstance || event === 'completed') record.executionState = event === 'completed' ? 'complete' : 'unknown';
      for (const turn of record.turns || []) {
        if (turn.result !== 'running') continue;
        turn.result = 'unknown'; turn.finishedAt = record.updatedAt;
        state.audit.push({ id: randomUUID(), taskId: record.id, event: 'turn-failed', actor,
          at: record.updatedAt, instructionHash: turn.instructionHash, threadId: turn.threadId, turnId: turn.turnId || turn.id, result: 'unknown' });
      }
    }
    state.audit.push({ id: randomUUID(), taskId: record.id, event, actor, at: record.updatedAt });
  }

  async propose(input: unknown, source: 'gui' | 'mcp'): Promise<TaskSession> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new TaskSessionError('Invalid task session input (unknown fields or credential material are forbidden)');
    const { idempotencyKey, ...fields } = parsed.data;
    if ((!fields.expiresAt && fields.ttl === undefined) || (fields.expiresAt && fields.ttl !== undefined)) throw new TaskSessionError('Specify expiresAt or ttl');
    if ([fields.workspaceId, fields.tabId, fields.requestedPermissions].some(Boolean) &&
        ![fields.workspaceId, fields.tabId, fields.requestedPermissions].every(Boolean)) throw new TaskSessionError('workspaceId, tabId and requestedPermissions are required together');
    const expiresAt = new Date(fields.expiresAt || this.clock() + fields.ttl! * 1000).toISOString();
    const normalized = { purpose: fields.purpose, hostId: fields.hostId, workdir: fields.workdir, scope: fields.scope, expiresAt,
      ...(fields.workspaceId ? { workspaceId: fields.workspaceId, tabId: fields.tabId, requestedPermissions: fields.requestedPermissions } : {}) };
    const fingerprint = createHash('sha256').update(JSON.stringify(fields.ttl === undefined ? normalized : { ...normalized, expiresAt: undefined, ttl: fields.ttl })).digest('hex');
    const key = createHash('sha256').update(source + ':' + idempotencyKey).digest('hex');
    return this.transaction(async (state) => {
      const previous = state.keys[key];
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new TaskSessionError('Idempotency key conflicts with an earlier request', 409);
        return state.records.find((r) => r.id === previous.taskId)!;
      }
      const ttl = Date.parse(normalized.expiresAt) - this.clock();
      if (ttl <= 0 || ttl > TASK_SESSION_MAX_TTL_MS) throw new TaskSessionError('expiresAt must be in the future and within 24 hours');
      await this.validateTarget(normalized.hostId, normalized.workdir, normalized.workspaceId, normalized.tabId);
      if (Object.keys(state.keys).length >= 10000) throw new TaskSessionError('Record capacity reached', 409);
      if (Date.parse(normalized.expiresAt) <= this.clock()) throw new TaskSessionError('Task session expired', 409);
      const duplicate = state.records.find((r) => r.source === source && ['pending', 'approved'].includes(r.status) &&
        createHash('sha256').update(JSON.stringify({ purpose: r.purpose, hostId: r.hostId, workdir: r.workdir, scope: r.scope, expiresAt: r.expiresAt, ...(r.workspaceId ? { workspaceId: r.workspaceId, tabId: r.tabId, requestedPermissions: r.requestedPermissions } : {}) })).digest('hex') === fingerprint);
      if (duplicate) { state.keys[key] = { fingerprint, taskId: duplicate.id }; return duplicate; }
      if (state.records.length >= 5000) throw new TaskSessionError('Record capacity reached', 409);
      const now = new Date(this.clock()).toISOString();
      const record: TaskSession = { ...normalized, id: randomUUID(), source, status: 'pending', createdAt: now, updatedAt: now };
      state.records.push(record);
      state.keys[key] = { fingerprint, taskId: record.id };
      this.transition(state, record, 'pending', source === 'mcp' ? 'mcp' : 'gui:user');
      return record;
    });
  }

  async list(offset = 0) {
    if (!Number.isInteger(offset) || offset < 0 || offset > 5000) throw new TaskSessionError('Invalid list offset');
    return this.transaction(async (s) => s.records.slice().reverse().slice(offset, offset + 100));
  }
  async detail(taskId: unknown) {
    if (!z.uuid().safeParse(taskId).success) throw new TaskSessionError('Invalid task ID');
    return this.transaction(async (s) => {
      const record = s.records.find((r) => r.id === taskId);
      if (!record) throw new TaskSessionError('Task session not found', 404);
      return { record, audit: s.audit.filter((e) => e.taskId === taskId) };
    });
  }
  async pendingCount() { return this.transaction(async (s) => s.records.filter((r) => r.status === 'pending').length); }
  async audit() { return this.transaction(async (s) => s.audit.slice(-200).reverse()); }
  /** Only the authenticated GUI route calls this method; no MCP dispatch path exists. */
  async decide(taskId: unknown, action: unknown, expectedStatus?: 'pending' | 'approved', warningAccepted = false) {
    if (!z.uuid().safeParse(taskId).success || !['approved', 'rejected', 'revoked'].includes(String(action)) ||
        (expectedStatus !== undefined && !['pending', 'approved'].includes(expectedStatus))) {
      throw new TaskSessionError('Invalid decision');
    }
    return this.transaction(async (s) => {
      const record = s.records.find((r) => r.id === taskId);
      if (!record) throw new TaskSessionError('Task session not found', 404);
      if (expectedStatus !== undefined && record.status !== expectedStatus) {
        throw new TaskSessionError('Task session status changed; refresh and confirm again', 409);
      }
      if (record.status === action) return record;
      const allowed = record.status === 'pending' ? ['approved', 'rejected', 'revoked'] : record.status === 'approved' ? ['revoked'] : [];
      if (!allowed.includes(String(action))) throw new TaskSessionError('Task session cannot make this transition', 409);
      if (action === 'approved') {
        await this.validateTarget(record.hostId, record.workdir, record.workspaceId, record.tabId);
        if (record.requestedPermissions === 'full-access') {
          if (!warningAccepted) throw new TaskSessionError('Full Access GUI warning confirmation required');
          record.fullAccessWarningAcceptedAt = new Date(this.clock()).toISOString();
        }
        if (Date.parse(record.expiresAt) <= this.clock()) {
          this.transition(s, record, 'expired', 'system');
          throw new TaskSessionError('Task session expired', 409);
        }
        record.sessionId = randomUUID();
      }
      this.transition(s, record, action as TaskSession['status'], 'gui:user');
      return record;
    });
  }
  private async checkExecution(record: TaskSession, target: { hostId: string; workdir: string; workspaceId: string; tabId: string }) {
    if (!fullAccessEnabled()) throw new TaskSessionError('Full Access execution disabled: both administrator opt-in flags are required', 403);
    if (record.status !== 'approved' || Date.parse(record.expiresAt) <= this.clock()) throw new TaskSessionError('An unexpired GUI-approved Task Session is required', 403);
    if (!record.sessionId || !record.fullAccessWarningAcceptedAt || record.requestedPermissions !== 'full-access' || !record.workspaceId || !record.tabId) {
      throw new TaskSessionError('Legacy approval is not executable; propose a new session for GUI review', 403);
    }
    if (record.hostId !== target.hostId || record.workdir !== target.workdir || record.workspaceId !== target.workspaceId || record.tabId !== target.tabId) {
      throw new TaskSessionError('Host/cwd/workspace/tab mismatch', 409);
    }
    await this.validateTarget(record.hostId, record.workdir, record.workspaceId, record.tabId);
    if (Date.parse(record.expiresAt) <= this.clock()) throw new TaskSessionError('Task session expired', 403);
  }

  async beginTurn(taskId: string, target: { hostId: string; workdir: string; workspaceId: string; tabId: string }, instruction: string, key: string) {
    if (!z.uuid().safeParse(taskId).success || !id.safeParse(key).success || !instruction.trim() || instruction.length > 16000) throw new TaskSessionError('Invalid turn request');
    const hash = createHash('sha256').update(instruction).digest('hex');
    const keyHash = createHash('sha256').update(key).digest('hex');
    return this.transaction(async (s) => {
      const record = s.records.find((r) => r.id === taskId);
      if (!record) throw new TaskSessionError('Task session not found', 404);
      await this.checkExecution(record, target);
      const previous = record.turns?.find((t) => t.keyHash === keyHash);
      if (previous) {
        if (previous.instructionHash !== hash) throw new TaskSessionError('Idempotency key conflict', 409);
        return { record, turn: previous, existing: true };
      }
      if (record.executionState === 'running' || s.records.some((r) => r.id !== taskId && r.status === 'approved' && r.ownerInstance && r.workspaceId === target.workspaceId && r.tabId === target.tabId)) throw new TaskSessionError('Tab already has an active lease or turn', 409);
      if ((record.turns?.length || 0) >= 1000 || s.audit.length >= 24900) throw new TaskSessionError('Audit capacity reached', 409);
      const turn: TaskSessionTurn = { id: randomUUID(), keyHash, instructionHash: hash,
        instructionPreview: '[instruction omitted; SHA-256 only]', startedAt: new Date(this.clock()).toISOString(), result: 'running' };
      (record.turns ||= []).push(turn);
      record.executionState = 'running'; record.ownerInstance = this.instance;
      s.audit.push({ id: randomUUID(), taskId, event: 'turn-started', actor: 'mcp', at: turn.startedAt, instructionHash: hash, turnId: turn.id });
      return { record, turn, existing: false };
    });
  }

  async assertTurn(taskId: string, turnId: string, target: { hostId: string; workdir: string; workspaceId: string; tabId: string }) {
    return this.transaction(async (s) => {
      const record = s.records.find((r) => r.id === taskId);
      if (!record) throw new TaskSessionError('Task session not found', 404);
      await this.checkExecution(record, target);
      if (record.ownerInstance !== this.instance || record.executionState !== 'running' || record.turns?.at(-1)?.id !== turnId) throw new TaskSessionError('Turn reservation lost', 409);
      return record;
    });
  }

  async bindTurn(taskId: string, id: string, threadId: string, turnId: string) {
    return this.transaction(async (s) => {
      const r = s.records.find((r) => r.id === taskId)!;
      if (!r || r.status !== 'approved' || r.ownerInstance !== this.instance || r.turns?.at(-1)?.id !== id) throw new TaskSessionError('Session changed while starting', 409);
      if (r.pinnedThreadId && r.pinnedThreadId !== threadId) throw new TaskSessionError('Pinned thread changed', 409);
      r.pinnedThreadId = threadId;
      Object.assign(r.turns!.at(-1)!, { threadId, turnId });
    });
  }

  async settleTurn(taskId: string, id: string, result: 'completed' | 'failed' | 'unknown') {
    return this.transaction(async (s) => {
      const r = s.records.find((r) => r.id === taskId)!;
      const t = r?.turns?.find((t) => t.id === id);
      if (!t || t.result !== 'running') return;
      t.result = result; t.finishedAt = new Date(this.clock()).toISOString();
      r.executionState = result === 'completed' && r.status === 'approved' ? 'idle' : 'unknown';
      s.audit.push({ id: randomUUID(), taskId, event: result === 'completed' ? 'turn-completed' : 'turn-failed', actor: 'system', at: t.finishedAt,
        instructionHash: t.instructionHash, threadId: t.threadId, turnId: t.turnId || t.id, result });
      if (result !== 'completed' && r.status === 'approved') this.transition(s, r, 'revoked', 'system');
    });
  }

  async finish(taskId: string, revoke = false, actor: TaskSessionAudit['actor'] = 'mcp', expectedStatus?: string) {
    return this.transaction(async (s) => {
      const r = s.records.find((r) => r.id === taskId);
      if (!r) throw new TaskSessionError('Task session not found', 404);
      if (expectedStatus && r.status !== expectedStatus) throw new TaskSessionError('Task session status changed', 409);
      if (['pending', 'approved'].includes(r.status)) this.transition(s, r, revoke ? 'revoked' : 'completed', actor);
      if (r.status === 'completed') r.executionState = 'complete';
      else if (r.status !== 'approved') r.executionState = 'unknown';
      return r;
    });
  }

}

export const taskSessions = new TaskSessionStore(path.join(os.homedir(), '.purplemux', 'task-sessions'), validateTaskSessionTarget);
