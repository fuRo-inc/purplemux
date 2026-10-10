import { taskSessions, TaskSessionError } from '@/lib/task-session-store';
import { runTaskSessionTurn, finishTaskSession, getTaskSession } from '@/lib/task-session-runtime';
import { z } from 'zod';

export const taskSessionMcpTools = [
  {
    name: 'run_task_session_turn', title: 'Run another turn in an approved Task Session',
    description: 'Requires prior authenticated GUI approval and both administrator write/full-access opt-ins. Supply the exact approved target each turn. Starts a dedicated thread, then pins it across turns. Idempotency key prevents duplicate execution; use get_task_session to poll. Normal GPU/build/train/analysis and same-repo git work within the approved task continues without repeated approval. Full Access is not an OS repo boundary; do not request unrelated destructive or other-device work.',
    inputSchema: { type: 'object', properties: {
      taskId: { type: 'string' }, hostId: { type: 'string' }, workdir: { type: 'string' }, workspaceId: { type: 'string' }, tabId: { type: 'string' },
      instruction: { type: 'string', minLength: 1, maxLength: 16000 }, idempotencyKey: { type: 'string' },
    }, required: ['taskId', 'hostId', 'workdir', 'workspaceId', 'tabId', 'instruction', 'idempotencyKey'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'finish_task_session', title: 'Finish or revoke a Task Session',
    description: 'Invalidate authority, interrupt any active turn and restore saved GUI permissions. revoke=true cancels instead of completing. Further execution requires a new proposal and GUI review.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, revoke: { type: 'boolean' } }, required: ['taskId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'propose_task_session', title: 'Propose a pending Task Session',
    description: 'Propose a task for logged-in GUI review. Specify registered workspace/tab, exact host/cwd, purpose, scope and full-access. Use ttl in seconds (max 86400) or expiresAt. No MCP flag grants approval. After GUI approval, run_task_session_turn continues normal work in this approved session without repeated approvals. Never include secrets.',
    inputSchema: {
      type: 'object', properties: {
        purpose: { type: 'string', minLength: 1, maxLength: 2000 }, hostId: { type: 'string' },
        workdir: { type: 'string' }, scope: { type: 'string', minLength: 1, maxLength: 2000 },
        workspaceId: { type: 'string' }, tabId: { type: 'string' }, requestedPermissions: { type: 'string', enum: ['full-access'] },
        ttl: { type: 'integer', minimum: 1, maximum: 86400 }, expiresAt: { type: 'string', format: 'date-time' }, idempotencyKey: { type: 'string' },
      }, required: ['purpose', 'hostId', 'workdir', 'scope', 'workspaceId', 'tabId', 'requestedPermissions', 'idempotencyKey'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_task_session', title: 'Read Task Session record',
    description: 'Read approval, execution state, bounded turn metadata and audit events by taskId. Poll after run_task_session_turn; raw instructions and stdout are never stored. includeOutput=true reads a bounded live final assistant result from the pinned idle thread; it is unavailable after finish/restart.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, includeOutput: { type: 'boolean' } }, required: ['taskId'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_task_sessions', title: 'List Task Session records',
    description: 'Read management records in pages of 100; use offset for older records. Approval requires explicit authenticated GUI operation.',
    inputSchema: { type: 'object', properties: { offset: { type: 'integer', minimum: 0, maximum: 5000 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

/** Explicit allowlist: no decision operation or client-controlled approval/source fields. */
export const dispatchTaskSessionMcp = async (operation: string, args: unknown) => {
  if (operation === 'run_task_session_turn') return runTaskSessionTurn(args);
  if (operation === 'finish_task_session') {
    const parsed = z.object({ taskId: z.uuid(), revoke: z.boolean().optional() }).strict().safeParse(args);
    if (!parsed.success) throw new TaskSessionError('Invalid finish request');
    return finishTaskSession(parsed.data.taskId, parsed.data.revoke);
  }
  if (operation === 'propose_task_session') {
    const target = z.object({ workspaceId: z.string().min(1), tabId: z.string().min(1), requestedPermissions: z.literal('full-access') }).passthrough().safeParse(args);
    if (!target.success) throw new TaskSessionError('Invalid task session input: registered workspace/tab and requestedPermissions are required');
    return taskSessions.propose(args, 'mcp');
  }
  if (operation === 'get_task_session') {
    const parsed = z.object({ taskId: z.uuid(), includeOutput: z.boolean().optional() }).strict().safeParse(args);
    if (!parsed.success) throw new TaskSessionError('Invalid task session query');
    return getTaskSession(parsed.data.taskId, parsed.data.includeOutput);
  }
  if (operation === 'list_task_sessions') {
    const parsed = z.object({ offset: z.number().int().min(0).max(5000).optional() }).strict().safeParse(args);
    if (!parsed.success) throw new TaskSessionError('Invalid task session query');
    return { records: await taskSessions.list(parsed.data.offset), executionLinked: true };
  }
  throw new TaskSessionError('Unsupported task session operation');
};
