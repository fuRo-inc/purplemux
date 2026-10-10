import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateTaskSessionGui } from '@/lib/task-session-gui-auth';
import { TaskSessionError, taskSessions } from '@/lib/task-session-store';
import { z } from 'zod';

export const config = { api: { bodyParser: { sizeLimit: '1kb' } } };
const decision = z.object({ action: z.enum(['approved', 'rejected', 'revoked']), confirm: z.literal(true),
  expectedStatus: z.enum(['pending', 'approved']), }).strict();
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
    return res.status(200).json(await taskSessions.decide(req.query.id, parsed.data.action, parsed.data.expectedStatus));
  } catch (error) {
    return res.status(error instanceof TaskSessionError ? error.status : 503)
      .json({ error: error instanceof TaskSessionError ? error.message : 'Task session storage unavailable' });
  }
}
