/**
 * MCP-initiated Codex task manager. Runs inside the same Next.js process as
 * the browser GUI, so both surfaces share one CodexGuiRuntime per tab.
 *
 * Everything that can change files is opt-in: PURPLEMUX_MCP_ALLOW_WRITES=1.
 * The execution target is always re-resolved and checked before enqueueing.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolveCodexAppTab } from '@/lib/codex-app-tab';
import { getCodexGuiRuntime, getLoadedCodexGuiRuntime, peekCodexGuiRuntime, type CodexGuiState } from '@/lib/codex-app-gui';

type TaskStatus = 'queued' | 'starting' | 'running' | 'awaiting_approval' |
  'completed' | 'failed' | 'interrupted' | 'unknown';
type TaskMode = 'continue' | 'new';
type TaskSandbox = 'read-only' | 'workspace-write';
interface TaskRecord {
  taskId: string;
  idempotencyKey: string | null;
  instructionHash: string;
  instructionPreview: string;
  workspaceId: string;
  tabId: string;
  hostId: string;
  directory: string;
  mode: TaskMode;
  sandboxMode: TaskSandbox;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  ownerInstance: string;
  threadId: string | null;
  turnId: string | null;
  userItemId: string | null;
  lastTurnStatus: string | null;
  summary: string | null;
  changedFiles: string[];
  diffPreview: string | null;
  interruptRequestedAt: string | null;
  approvalEvents: { requestId: string; decision: 'accept' | 'decline'; commandHash: string; at: string }[];
  error: string | null;
}
const INSTANCE = randomUUID();
const TASK_DIR = path.join(os.homedir(), '.purplemux', 'mcp-tasks');
const ID_RE = /^[a-zA-Z0-9_-]{1,120}$/;
const TASK_ID_RE = /^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/i;
const MAX_INSTRUCTION = 16000;
const MAX_OUTPUT = 10000;
const activeTabs = new Set<string>();
const taskCache = new Map<string, TaskRecord>();
const persistQueues = new Map<string, Promise<void>>();
const unsubs = new Map<string, () => void>();

const writeEnabled = () => process.env.PURPLEMUX_MCP_ALLOW_WRITES === '1';
const requireWriteEnabled = () => {
  if (!writeEnabled()) throw new Error('Codex task writes are disabled: set PURPLEMUX_MCP_ALLOW_WRITES=1 and restart Purplemux');
};
const fail = (message: string): never => { throw new Error(message); };
const asId = (value: unknown, key: string): string => {
  if (typeof value !== 'string' || !ID_RE.test(value)) return fail('Invalid ' + key);
  return value;
};
const fileFor = (taskId: string) => {
  if (!TASK_ID_RE.test(taskId)) return fail('Invalid taskId');
  return path.join(TASK_DIR, taskId + '.json');
};
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const normalizeDirectory = (value: string) => value.replace(/\/+$/, '') || '/';

const persist = async (record: TaskRecord): Promise<void> => {
  const id = record.taskId;
  record.updatedAt = now();
  const bytes = JSON.stringify(record, null, 2);
  const previous = persistQueues.get(id) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    await fs.mkdir(TASK_DIR, { recursive: true, mode: 0o700 });
    const target = fileFor(id);
    const temp = target + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temp, bytes, { mode: 0o600 });
      await fs.rename(temp, target);
    } catch (error) {
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
  });
  persistQueues.set(id, next);
  try { await next; } finally { if (persistQueues.get(id) === next) persistQueues.delete(id); }
};

const load = async (taskId: string): Promise<TaskRecord> => {
  const cached = taskCache.get(taskId);
  if (cached) return cached;
  let record: TaskRecord;
  try { record = JSON.parse(await fs.readFile(fileFor(taskId), 'utf8')) as TaskRecord; }
  catch { return fail('Task not found'); }
  if (record.taskId !== taskId) return fail('Task record corrupted');
  taskCache.set(taskId, record);
  return record;
};

const isFinal = (status: TaskStatus) => ['completed', 'failed', 'interrupted', 'unknown'].includes(status);
const markFinal = async (record: TaskRecord, status: TaskStatus, state?: CodexGuiState) => {
  if (isFinal(record.status)) return;
  record.status = status;
  record.lastTurnStatus = state?.lastTurnStatus ?? record.lastTurnStatus;
  if (state?.error) record.error = state.error.slice(0, 700);
  if (state) {
    const items = itemsFor(record, state);
    record.summary = [...items].reverse().find((item) => item.type === 'assistant')?.text.slice(-MAX_OUTPUT) || null;
    record.changedFiles = [...new Set(items.filter((item) => item.type === 'file-change')
      .flatMap((item) => item.title?.split(', ') || [])
      .filter((name) => name !== 'ファイル変更' && name !== 'file-change'))].slice(0, 100);
    if (record.turnId) {
      const runtime = await getLoadedCodexGuiRuntime(record.workspaceId, record.tabId);
      const diff = runtime?.getTurnDiff(record.turnId) || null;
      if (diff) {
        record.diffPreview = diff.slice(0, 32000);
        const changed = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]);
        if (changed.length) record.changedFiles = [...new Set(changed)].slice(0, 100);
      }
    }
  }
  await persist(record);
  unsubs.get(record.taskId)?.();
  unsubs.delete(record.taskId);
  activeTabs.delete(record.workspaceId + ':' + record.tabId);
};
const itemsFor = (record: TaskRecord, state: CodexGuiState) => {
  const i = state.items.findIndex((item) => item.id === record.userItemId);
  // Never include earlier-thread or unrelated output when the task's user
  // message is no longer in the bounded App Server UI history.
  return i < 0 ? [] : state.items.slice(i + 1);
};
const refresh = async (record: TaskRecord) => {
  if (isFinal(record.status)) return;
  if (record.ownerInstance !== INSTANCE) {
    await markFinal(record, 'unknown');
    record.error = 'Purplemux restarted while this task was active. Verify the Codex thread before retrying.';
    await persist(record);
    return;
  }
  if (record.status === 'queued' || record.status === 'starting') return;
  const live = await peekCodexGuiRuntime(record.workspaceId, record.tabId);
  if (!live || !live.running || live.threadId !== record.threadId) {
    await markFinal(record, 'unknown');
    return;
  }
  if (record.turnId && live.lastTurnId === record.turnId && live.lastTurnStatus) {
    const result = live.lastTurnStatus;
    await markFinal(record, result === 'completed' ? 'completed'
      : result === 'interrupted' ? 'interrupted' : 'failed', live);
    return;
  }
  const next: TaskStatus = live.approvals.length ? 'awaiting_approval' : live.busy ? 'running' : 'unknown';
  if (record.status !== next) {
    if (next === 'unknown') await markFinal(record, next, live);
    else { record.status = next; await persist(record); }
  }
};

const execute = async (record: TaskRecord, instruction: string): Promise<void> => {
  const tabKey = record.workspaceId + ':' + record.tabId;
  try {
    record.status = 'starting';
    await persist(record);
    const { workspace, tab } = await resolveCodexAppTab(record.workspaceId, record.tabId);
    if ((workspace.hostId || 'local') !== record.hostId) return fail('Host changed while task was starting');
    const directory = workspace.hostId ? workspace.remoteDirectory : (tab.cwd || workspace.directories[0]);
    if (!directory || normalizeDirectory(directory) !== record.directory) {
      return fail('Codex working directory changed while task was starting');
    }
    const runtime = await getCodexGuiRuntime(workspace, tab);
    const before = runtime.snapshot();
    if (before.busy) return fail('Codex is already working in this tab');
    // A persisted thread may have been resumed from another working directory.
    // Compare its ACTUAL cwd with the confirmed target, not only the UI tab.
    if (record.mode === 'continue' && before.threadId &&
        (!before.cwd || normalizeDirectory(before.cwd) !== record.directory)) {
      return fail('Codex thread working directory differs from the confirmed target. Choose a new thread explicitly.');
    }
    // Switch threads BEFORE changing permissions. New-task requests must not
    // mutate the old thread's sandbox or approval settings.
    if (record.mode === 'new') await runtime.action('new-thread', {});
    // The default is read-only. Workspace writes require a separate explicit
    // request; Full Access and no-approval policies are never available via MCP.
    await runtime.action('settings', {
      sandboxMode: record.sandboxMode, approvalPolicy: 'on-request',
    });
    const configured = runtime.snapshot();
    if (configured.cwd && normalizeDirectory(configured.cwd) !== record.directory) {
      return fail('Codex working directory changed before task submission');
    }
    const result = await runtime.action('send', { text: instruction });
    record.threadId = result.threadId;
    record.turnId = result.turnId || result.lastTurnId;
    const lastUser = [...result.items].reverse().find((item) => item.type === 'user');
    record.userItemId = lastUser?.id || null;
    record.status = result.approvals.length ? 'awaiting_approval' : 'running';
    await persist(record);
    const unsubscribe = runtime.subscribe((state) => {
      if (state.threadId !== record.threadId || isFinal(record.status)) return;
      void refresh(record).catch(() => {});
    });
    unsubs.set(record.taskId, unsubscribe);
    await refresh(record);
  } catch (error) {
    record.error = (error instanceof Error ? error.message : String(error)).slice(0, 700);
    await markFinal(record, 'failed').catch(() => {});
  } finally {
    // Only one active Codex turn is allowed by CodexGuiRuntime. The queue lock
    // is released after send; the runtime's busy flag rejects overlapping work.
    activeTabs.delete(tabKey);
  }
};

export const submitCodexTask = async (args: Record<string, unknown>) => {
  requireWriteEnabled();
  const workspaceId = asId(args.workspaceId, 'workspaceId');
  const tabId = asId(args.tabId, 'tabId');
  const expectedHostId = asId(args.expectedHostId, 'expectedHostId');
  if (typeof args.expectedDirectory !== 'string' || !args.expectedDirectory.startsWith('/') ||
      args.expectedDirectory.length > 2048) return fail('Expected absolute working directory is required');
  if (args.confirmTarget !== true) return fail('Explicit confirmTarget=true is required');
  if (args.mode !== undefined && args.mode !== 'continue' && args.mode !== 'new') return fail('Invalid mode');
  if (args.sandboxMode !== undefined && args.sandboxMode !== 'read-only' &&
      args.sandboxMode !== 'workspace-write') return fail('Invalid sandboxMode');
  const sandboxMode: TaskSandbox = args.sandboxMode === 'workspace-write' ? 'workspace-write' : 'read-only';
  if (sandboxMode === 'workspace-write' && args.confirmWriteAccess !== true) {
    return fail('confirmWriteAccess=true is required for workspace-write tasks');
  }
  if (args.confirmWriteAccess !== undefined && typeof args.confirmWriteAccess !== 'boolean') {
    return fail('Invalid confirmWriteAccess');
  }
  if (typeof args.instruction !== 'string' || !args.instruction.trim() ||
      args.instruction.length > MAX_INSTRUCTION) return fail('Instruction must contain 1–16000 characters');
  const mode: TaskMode = args.mode === 'new' ? 'new' : 'continue';
  const idempotencyKey = args.idempotencyKey === undefined ? null :
    (typeof args.idempotencyKey === 'string' && /^[a-zA-Z0-9_.-]{8,128}$/.test(args.idempotencyKey)
      ? args.idempotencyKey : fail('Invalid idempotencyKey'));
  const { workspace, tab } = await resolveCodexAppTab(workspaceId, tabId);
  const hostId = workspace.hostId || 'local';
  const directory = workspace.hostId ? workspace.remoteDirectory : (tab.cwd || workspace.directories[0]);
  if (hostId !== expectedHostId || !directory ||
      normalizeDirectory(directory) !== normalizeDirectory(args.expectedDirectory)) {
    return fail('Host or working directory mismatch. Recheck list_workspaces and list_codex_tabs');
  }
  const hash = fingerprint(args.instruction);
  const taskId = idempotencyKey
    ? fingerprint('mcp:' + workspaceId + ':' + tabId + ':' + idempotencyKey).slice(0, 32)
    : randomUUID();
  try {
    const previous = await load(taskId);
    if (previous.instructionHash !== hash || previous.mode !== mode ||
        previous.sandboxMode !== sandboxMode ||
        previous.hostId !== hostId || previous.directory !== normalizeDirectory(directory)) {
      return fail('Idempotency key already used for a different task');
    }
    return { taskId: previous.taskId, status: previous.status, existing: true,
      workspaceId, tabId, hostId, directory: previous.directory, sandboxMode };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'Task not found') throw error;
  }
  const tabKey = workspaceId + ':' + tabId;
  if (activeTabs.has(tabKey)) return fail('A Codex task is already being submitted to this tab');
  // Avoid queued requests racing with already-running browser tasks.
  const live = await peekCodexGuiRuntime(workspaceId, tabId);
  if (live?.busy) return fail('Codex is already running a turn in this tab');
  activeTabs.add(tabKey);
  const record: TaskRecord = {
    taskId, idempotencyKey, instructionHash: hash,
    instructionPreview: args.instruction.trim().slice(0, 220),
    workspaceId, tabId, hostId, directory: normalizeDirectory(directory), mode, sandboxMode,
    status: 'queued', ownerInstance: INSTANCE, createdAt: now(), updatedAt: now(),
    threadId: null, turnId: null, userItemId: null, lastTurnStatus: null,
    summary: null, changedFiles: [], diffPreview: null,
    interruptRequestedAt: null, approvalEvents: [], error: null,
  };
  taskCache.set(taskId, record);
  try {
    await persist(record);
    void execute(record, args.instruction).catch(() => { activeTabs.delete(tabKey); });
  } catch (error) {
    activeTabs.delete(tabKey);
    taskCache.delete(taskId);
    throw error;
  }
  return { taskId, status: 'queued', existing: false,
    workspaceId, tabId, hostId, directory: record.directory, mode, sandboxMode,
    note: 'Task accepted; use get_codex_task to poll for progress and results.' };
};

const summarize = async (record: TaskRecord, includeOutput: boolean, includeDiff: boolean) => {
  await refresh(record);
  const status: Record<string, unknown> = {
    taskId: record.taskId, workspaceId: record.workspaceId, tabId: record.tabId,
    hostId: record.hostId, directory: record.directory, mode: record.mode,
    sandboxMode: record.sandboxMode || 'workspace-write',
    status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt,
    threadId: record.threadId, turnId: record.turnId,
    lastTurnStatus: record.lastTurnStatus, error: record.error,
    hasSummary: !!record.summary, changedFiles: record.changedFiles,
    interruptRequestedAt: record.interruptRequestedAt || null,
    approvalResponseCount: record.approvalEvents?.length || 0,
  };
  if (includeOutput) {
    status.summary = record.summary;
    const live = await peekCodexGuiRuntime(record.workspaceId, record.tabId);
    if (live?.threadId === record.threadId) {
      status.recentItems = itemsFor(record, live).slice(-12).map((item) => ({
        type: item.type, status: item.status || null, title: item.title?.slice(0, 250) || null,
        text: item.text.slice(-2000),
      }));
      status.pendingApprovals = live.approvals.map((approval) => ({
        requestId: approval.requestId, method: approval.method,
        command: approval.command.slice(0, 1000), reason: approval.reason.slice(0, 1000),
      }));
    }
  }
  if (includeDiff && record.turnId) {
    // A read-only status request must NEVER start/resume a Codex process.
    const runtime = await getLoadedCodexGuiRuntime(record.workspaceId, record.tabId);
    const diff = runtime?.getTurnDiff(record.turnId) || record.diffPreview || '';
    status.diff = diff.slice(0, 16000);
    status.diffTruncated = diff.length > 16000;
    status.diffAvailable = diff.length > 0;
  }
  return status;
};

export const getCodexTask = async (args: Record<string, unknown>) => {
  const taskId = String(args.taskId || '');
  if (!TASK_ID_RE.test(taskId)) return fail('Invalid taskId');
  if (args.includeOutput !== undefined && typeof args.includeOutput !== 'boolean') return fail('Invalid includeOutput');
  if (args.includeDiff !== undefined && typeof args.includeDiff !== 'boolean') return fail('Invalid includeDiff');
  return summarize(await load(taskId), args.includeOutput === true, args.includeDiff === true);
};

export const listCodexTasks = async (args: Record<string, unknown>) => {
  if (args.workspaceId !== undefined) asId(args.workspaceId, 'workspaceId');
  const limit = args.limit === undefined ? 20 : Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail('limit must be 1–50');
  const files = (await fs.readdir(TASK_DIR).catch((): string[] => []))
    .filter((name) => TASK_ID_RE.test(name.replace(/\.json$/, '')) && name.endsWith('.json'));
  const records: TaskRecord[] = [];
  for (const filename of files.slice(-500)) {
    try {
      const record = await load(filename.slice(0, -5));
      if (!args.workspaceId || record.workspaceId === args.workspaceId) records.push(record);
    } catch { /* Ignore corrupt task records. */ }
  }
  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const selected = records.slice(0, limit);
  return { tasks: await Promise.all(selected.map(async (record) => {
    await refresh(record);
    return {
      taskId: record.taskId, workspaceId: record.workspaceId, tabId: record.tabId,
      hostId: record.hostId, directory: record.directory,
      sandboxMode: record.sandboxMode || 'workspace-write',
      status: record.status, createdAt: record.createdAt, threadId: record.threadId,
      instructionPreview: record.instructionPreview,
    };
  })) };
};

export const interruptCodexTask = async (args: Record<string, unknown>) => {
  requireWriteEnabled();
  if (args.confirmInterrupt !== true) return fail('Explicit confirmInterrupt=true is required');
  const record = await load(String(args.taskId || ''));
  await refresh(record);
  if (isFinal(record.status)) return { taskId: record.taskId, status: record.status, alreadyFinished: true };
  if (!record.threadId || !record.turnId) return fail('Turn not running yet; retry shortly');
  const { workspace, tab } = await resolveCodexAppTab(record.workspaceId, record.tabId);
  const runtime = await getCodexGuiRuntime(workspace, tab);
  const state = runtime.snapshot();
  if (state.threadId !== record.threadId || state.turnId !== record.turnId) {
    return fail('Active Codex turn changed; refusing to interrupt another task');
  }
  await runtime.action('interrupt', {});
  record.interruptRequestedAt = now();
  await persist(record);
  return { taskId: record.taskId, status: 'interrupt_requested', threadId: record.threadId,
    turnId: record.turnId, note: 'Use get_codex_task to confirm completion.' };
};

export const respondCodexApproval = async (args: Record<string, unknown>) => {
  requireWriteEnabled();
  const record = await load(String(args.taskId || ''));
  await refresh(record);
  if (isFinal(record.status) || !record.threadId) return fail('Task is not active');
  if (args.decision !== 'accept' && args.decision !== 'decline') return fail('Invalid approval decision');
  // Accepting an escalation or file modification is a higher-trust operation
  // than assigning ordinary sandboxed work. Require a separate operator opt-in.
  if (args.decision === 'accept' && process.env.PURPLEMUX_MCP_ALLOW_APPROVALS !== '1') {
    return fail('MCP approval acceptance is disabled. Set PURPLEMUX_MCP_ALLOW_APPROVALS=1 only after operator review.');
  }
  if (args.confirmApproval !== true) return fail('Explicit confirmApproval=true is required');
  if ((typeof args.requestId !== 'number' && typeof args.requestId !== 'string') ||
      String(args.requestId).length > 128) return fail('Invalid approval requestId');
  if (typeof args.expectedCommand !== 'string' || args.expectedCommand.length > 1000) {
    return fail('Expected approval command is required');
  }
  const { workspace, tab } = await resolveCodexAppTab(record.workspaceId, record.tabId);
  const runtime = await getCodexGuiRuntime(workspace, tab);
  const state = runtime.snapshot();
  if (state.threadId !== record.threadId || state.turnId !== record.turnId || !state.busy) {
    return fail('Active Codex turn changed; refusing to answer another task approval');
  }
  const approval = state.approvals.find((entry) => String(entry.requestId) === String(args.requestId));
  if (!approval || approval.command !== args.expectedCommand) {
    return fail('Approval request changed. Re-read get_codex_task(includeOutput=true).');
  }
  await runtime.action('approve', { requestId: approval.requestId, decision: args.decision });
  record.approvalEvents = [
    ...(record.approvalEvents || []).slice(-19),
    { requestId: String(approval.requestId),
      decision: args.decision as 'accept' | 'decline',
      commandHash: fingerprint(approval.command), at: now() },
  ];
  await persist(record);
  return { taskId: record.taskId, requestId: approval.requestId, decision: args.decision,
    status: 'approval_response_sent' };
};
