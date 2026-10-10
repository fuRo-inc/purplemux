import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateTaskSessionGui } from '@/lib/task-session-gui-auth';
import { TaskSessionError, taskSessions } from '@/lib/task-session-store';
import { releaseTaskSession, finishTaskSession } from '@/lib/task-session-runtime';
import { z } from 'zod';

export const config = { api: { bodyParser: { sizeLimit: '1kb' } } };
const decision = z.object({ action: z.enum(['approved', 'rejected', 'revoked', 'completed']), confirm: z.literal(true),
  fullAccessWarningAccepted: z.literal(true).optional(), expectedStatus: z.enum(['pending', 'approved']), }).strict();
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await authenticateTaskSessionGui(req);
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    const parsed = decision.safeParse(req.body);
    if (!parsed.success) throw new TaskSessionError('Explicit GUI confirmation required');
    const identifier = z.uuid().safeParse(req.query.id);
    if (!identifier.success) throw new TaskSessionError('Invalid task ID');
    const taskId = identifier.data;
    if (parsed.data.action === 'completed') {
      return res.status(200).json(await finishTaskSession(taskId, false, 'gui:user', parsed.data.expectedStatus));
    }
    const record = parsed.data.fullAccessWarningAccepted
      ? await taskSessions.decide(taskId, parsed.data.action, parsed.data.expectedStatus, true)
      : await taskSessions.decide(taskId, parsed.data.action, parsed.data.expectedStatus);
    if (parsed.data.action === 'revoked') await releaseTaskSession(taskId);
    return res.status(200).json(record);
  } catch (error) {
    return res.status(error instanceof TaskSessionError ? error.status : 503)
      .json({ error: error instanceof TaskSessionError ? error.message : 'Task session storage unavailable' });
  }
}
