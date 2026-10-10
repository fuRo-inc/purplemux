/** Next-process coordinator; durable approval remains in TaskSessionStore. */
import type { TaskSession, TaskSessionTurn, TaskSessionAudit } from '@/types/task-session';
import { z } from 'zod';
import { taskSessions, TaskSessionError, fullAccessEnabled } from '@/lib/task-session-store';
import { resolveCodexAppTab } from '@/lib/codex-app-tab';
import { getCodexGuiRuntime, getLoadedCodexGuiRuntime, type CodexGuiRuntime } from '@/lib/codex-app-gui';

const targetSchema = z.object({
  executionCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  taskId: z.uuid(), hostId: z.string(), workdir: z.string(), workspaceId: z.string(), tabId: z.string(),
  instruction: z.string().trim().min(1).max(16000), idempotencyKey: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/),
}).strict();
type ActiveLease = { runtime: CodexGuiRuntime; sessionId: string; unsubscribe: () => void; timer: ReturnType<typeof setTimeout> };
const processState = globalThis as unknown as { __purplemuxTaskSessionLeases?: Map<string, ActiveLease> };
const active = processState.__purplemuxTaskSessionLeases ||= new Map<string, ActiveLease>();

export const releaseTaskSession = async (taskId: string) => {
  const lease = active.get(taskId);
  if (lease) {
    // Delete first so callbacks from interruption cannot resurrect this session.
    active.delete(taskId); clearInterval(lease.timer); lease.unsubscribe();
    await lease.runtime.finishTaskSession(lease.sessionId);
    await taskSessions.acknowledgeOwnerRelease(taskId);
    return;
  }
  // Also handle setup between durable reservation and listener registration.
  const { record } = await taskSessions.detail(taskId);
  if (record.workspaceId && record.tabId && record.sessionId) {
    const runtime = await getLoadedCodexGuiRuntime(record.workspaceId, record.tabId);
    await runtime?.finishTaskSession(record.sessionId);
    await taskSessions.acknowledgeOwnerRelease(taskId);
  }
};

export const finishTaskSession = async (taskId: string, revoke = false, actor: TaskSessionAudit['actor'] = 'mcp', expectedStatus?: string) => {
  // Revoke durable authority first, then interrupt and restore the runtime.
  const record = await taskSessions.finish(taskId, revoke, actor, expectedStatus);
  await releaseTaskSession(taskId);
  return record;
};

export const runTaskSessionTurn = async (input: unknown) => {
  const parsed = targetSchema.safeParse(input);
  if (!parsed.success) throw new TaskSessionError('Invalid turn request');
  const args = parsed.data;
  const reserved = await taskSessions.beginTurn(args.taskId, args, args.instruction, args.idempotencyKey, args.executionCapability);
  if (reserved.existing) return { taskId: args.taskId, turn: reserved.turn, existing: true };
  void executeTurn(args, reserved.record, reserved.turn).catch(() => {});
  return { taskId: args.taskId, turn: reserved.turn, existing: false };
};

const executeTurn = async (args: z.infer<typeof targetSchema>, record: TaskSession, turn: TaskSessionTurn) => {
  const validate = async () => { await taskSessions.assertTurn(record.id, turn.id, args); };
  let runtime: CodexGuiRuntime | undefined;
  let lost = false;
  const onLost = () => {
    if (lost) return;
    lost = true;
    // Lost thread/runtime authority must not leave an elevated child running.
    if (runtime?.snapshot().running && runtime.snapshot().taskPermissionsActive) runtime.terminate();
    const lease = active.get(record.id);
    if (lease) { active.delete(record.id); clearInterval(lease.timer); lease.unsubscribe(); }
    const result = runtime?.snapshot().lastTurnStatus === 'failed' ? 'failed' : 'unknown';
    void taskSessions.settleTurn(record.id, turn.id, result).then(() => taskSessions.finish(record.id, true)).then(() => releaseTaskSession(record.id)).catch(() => {});
  };
  try {
    const { workspace, tab } = await resolveCodexAppTab(args.workspaceId, args.tabId);
    await validate();
    runtime = await getCodexGuiRuntime(workspace, tab);
    const instruction = `Approved development task: ${record.purpose}\nScope: ${record.scope}\nTarget: ${record.hostId}:${record.workdir}\nContinue normal work within this approved task. Do not perform unrelated deletion or substantial operations on other devices. Scope is an instruction, not an OS sandbox.\n\n${args.instruction}`;
    const state = await runtime.runTaskSessionTurn({ hostId: args.hostId, workspaceId: args.workspaceId, tabId: args.tabId, directory: args.workdir, text: instruction, sessionId: record.sessionId!,
      targetFingerprint: record.targetFingerprint!, expiresAt: record.expiresAt, pinnedThreadId: record.pinnedThreadId, validate, onLost });
    if (lost || !state.running || !state.threadId || !(state.turnId || state.lastTurnId)) throw new TaskSessionError('Session runtime lost', 409);
    await taskSessions.bindTurn(record.id, turn.id, state.threadId, (state.turnId || state.lastTurnId)!);
    // Replace the previous turn listener, retaining the runtime's long-lived lease.
    const previous = active.get(record.id);
    if (previous) { clearInterval(previous.timer); previous.unsubscribe(); }
    let registered = false;
    let settling = false;
    const inspect = async () => {
      if (!registered || settling || !runtime) return;
      settling = true;
      try {
        const { record: latest } = await taskSessions.detail(record.id);
        if (latest.status !== 'approved' || !fullAccessEnabled()) {
          await taskSessions.finish(record.id, true); await releaseTaskSession(record.id); return;
        }
        await taskSessions.heartbeat(record.id);
        const live = runtime.snapshot();
        if (!live.running || live.threadId !== state.threadId || !live.taskPermissionsActive) { onLost(); return; }
        const expectedTurn = state.turnId || state.lastTurnId;
        if (live.lastTurnId === expectedTurn && live.lastTurnStatus) {
          const result = live.lastTurnStatus === 'completed' ? 'completed' : 'failed';
          await taskSessions.settleTurn(record.id, turn.id, result);
          if (result !== 'completed') await releaseTaskSession(record.id);
        }
      } catch {
        // Storage/validation failure must revoke execution, never silently keep authority.
        runtime.terminate(); onLost();
      } finally { settling = false; }
    };
    const unsubscribe = runtime.subscribe(() => { void inspect(); });
    const timer = setInterval(() => { void inspect(); }, 1000); timer.unref();
    active.set(record.id, { runtime, sessionId: record.sessionId!, unsubscribe, timer }); registered = true;
    await inspect();
    return { taskId: record.id, turn: (await taskSessions.detail(record.id)).record.turns!.at(-1), existing: false };
  } catch (error) {
    await runtime?.finishTaskSession(record.sessionId!).catch(() => { runtime?.terminate(); });
    await taskSessions.settleTurn(record.id, turn.id, 'failed');
    await releaseTaskSession(record.id);
    throw error;
  }
};

/** Explicit, ephemeral assistant result read; never starts Codex or writes stdout. */
export const getTaskSession = async (taskId: string, includeOutput = false) => {
  const detail = await taskSessions.detail(taskId);
  if (!includeOutput) return detail;
  const { record } = detail;
  const turn = record.turns?.at(-1);
  if (record.status !== 'approved' || !record.workspaceId || !record.tabId || !turn?.turnId) return { ...detail, output: null };
  const runtime = await getLoadedCodexGuiRuntime(record.workspaceId, record.tabId);
  const live = runtime?.snapshot();
  if (!live?.taskPermissionsActive || live.threadId !== record.pinnedThreadId || live.busy || live.lastTurnId !== turn.turnId) return { ...detail, output: null };
  const userIndex = live.items.map((item) => item.type).lastIndexOf('user');
  const output = userIndex < 0 ? null : live.items.slice(userIndex + 1).filter((item) => item.type === 'assistant').map((item) => item.text).join('\n').slice(-6000);
  return { ...detail, output };
};
