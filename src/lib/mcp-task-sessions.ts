import { taskSessions, TaskSessionError } from '@/lib/task-session-store';
import { z } from 'zod';

export const taskSessionMcpTools = [
  {
    name: 'propose_task_session', title: 'Propose a pending Task Session',
    description: 'Create a management request only. GUI approval records do not change Codex execution permissions. Never include secrets. Host/workdir must match an existing workspace; TTL is at most 24 hours.',
    inputSchema: {
      type: 'object', properties: {
        purpose: { type: 'string', minLength: 1, maxLength: 2000 }, hostId: { type: 'string' },
        workdir: { type: 'string' }, scope: { type: 'string', minLength: 1, maxLength: 2000 },
        expiresAt: { type: 'string', format: 'date-time' }, idempotencyKey: { type: 'string' },
      }, required: ['purpose', 'hostId', 'workdir', 'scope', 'expiresAt', 'idempotencyKey'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_task_session', title: 'Read Task Session record',
    description: 'Read a management record and audit events by taskId. No execution credentials or permissions are issued.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false },
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
  if (operation === 'propose_task_session') return taskSessions.propose(args, 'mcp');
  if (operation === 'get_task_session') {
    const parsed = z.object({ taskId: z.uuid() }).strict().safeParse(args);
    if (!parsed.success) throw new TaskSessionError('Invalid task session query');
    return taskSessions.detail(parsed.data.taskId);
  }
  if (operation === 'list_task_sessions') {
    const parsed = z.object({ offset: z.number().int().min(0).max(5000).optional() }).strict().safeParse(args);
    if (!parsed.success) throw new TaskSessionError('Invalid task session query');
    return { records: await taskSessions.list(parsed.data.offset), executionLinked: false };
  }
  throw new TaskSessionError('Unsupported task session operation');
};
