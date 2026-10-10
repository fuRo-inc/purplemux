/** Management records only; this module never imports a Codex execution API. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TaskSession, TaskSessionAudit } from '@/types/task-session';

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
const inputSchema = z.object({
  purpose: text, hostId: id, workdir, scope: text,
  expiresAt: z.iso.datetime({ offset: true }), idempotencyKey: id,
}).strict();
const recordSchema = inputSchema.omit({ idempotencyKey: true }).extend({
  id: z.uuid(), status: z.enum(['pending', 'approved', 'rejected', 'revoked', 'expired']),
  source: z.enum(['gui', 'mcp']), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  sessionId: z.uuid().optional(),
});
const auditSchema = z.object({
  id: z.uuid(), taskId: z.uuid(), event: recordSchema.shape.status,
  actor: z.enum(['gui:user', 'mcp', 'system']), at: z.iso.datetime(),
});
const stateSchema = z.object({
  version: z.literal(1), records: z.array(recordSchema).max(5000),
  audit: z.array(auditSchema).max(25000),
  keys: z.record(z.string(), z.object({ fingerprint: z.string(), taskId: z.uuid() })),
});
type State = z.infer<typeof stateSchema>;
export type TaskSessionTargetValidator = (hostId: string, workdir: string) => Promise<void>;

/** Passive validation: read configuration only; never contact SSH or mutate a workspace. */
export const validateTaskSessionTarget: TaskSessionTargetValidator = async (hostId, cwd) => {
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
    private readonly clock = Date.now) {}

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
    state.audit.push({ id: randomUUID(), taskId: record.id, event, actor, at: record.updatedAt });
  }

  async propose(input: unknown, source: 'gui' | 'mcp'): Promise<TaskSession> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new TaskSessionError('Invalid task session input (unknown fields or credential material are forbidden)');
    const { idempotencyKey, ...fields } = parsed.data;
    fields.expiresAt = new Date(fields.expiresAt).toISOString();
    const fingerprint = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    const key = createHash('sha256').update(source + ':' + idempotencyKey).digest('hex');
    return this.transaction(async (state) => {
      const previous = state.keys[key];
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new TaskSessionError('Idempotency key conflicts with an earlier request', 409);
        return state.records.find((r) => r.id === previous.taskId)!;
      }
      const ttl = Date.parse(fields.expiresAt) - this.clock();
      if (ttl <= 0 || ttl > TASK_SESSION_MAX_TTL_MS) throw new TaskSessionError('expiresAt must be in the future and within 24 hours');
      await this.validateTarget(fields.hostId, fields.workdir);
      if (Object.keys(state.keys).length >= 10000) throw new TaskSessionError('Record capacity reached', 409);
      if (Date.parse(fields.expiresAt) <= this.clock()) throw new TaskSessionError('Task session expired', 409);
      const duplicate = state.records.find((r) => r.source === source && ['pending', 'approved'].includes(r.status) &&
        createHash('sha256').update(JSON.stringify({ purpose: r.purpose, hostId: r.hostId, workdir: r.workdir, scope: r.scope, expiresAt: r.expiresAt })).digest('hex') === fingerprint);
      if (duplicate) { state.keys[key] = { fingerprint, taskId: duplicate.id }; return duplicate; }
      if (state.records.length >= 5000) throw new TaskSessionError('Record capacity reached', 409);
      const now = new Date(this.clock()).toISOString();
      const record: TaskSession = { ...fields, id: randomUUID(), source, status: 'pending', createdAt: now, updatedAt: now };
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
  async audit() { return this.transaction(async (s) => s.audit.slice(-200).reverse()); }
  /** Only the authenticated GUI route calls this method; no MCP dispatch path exists. */
  async decide(taskId: unknown, action: unknown, expectedStatus?: 'pending' | 'approved') {
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
        await this.validateTarget(record.hostId, record.workdir);
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
}

export const taskSessions = new TaskSessionStore(path.join(os.homedir(), '.purplemux', 'task-sessions'), validateTaskSessionTarget);
