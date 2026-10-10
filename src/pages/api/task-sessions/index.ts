import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateTaskSessionGui } from '@/lib/task-session-gui-auth';
import { TaskSessionError, taskSessions } from '@/lib/task-session-store';
import { z } from 'zod';

export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const csrfToken = await authenticateTaskSessionGui(req);
    if (req.method === 'GET') {
      if (req.query.id !== undefined) return res.status(200).json(await taskSessions.detail(req.query.id));
      if (req.query.audit === '1') return res.status(200).json({ audit: await taskSessions.audit() });
      const offset = z.string().regex(/^\d{1,4}$/).optional().safeParse(req.query.offset);
      if (!offset.success) throw new TaskSessionError('Invalid list offset');
      return res.status(200).json({ records: await taskSessions.list(Number(offset.data ?? 0)), csrfToken, executionLinked: false });
    }
    if (req.method === 'POST') return res.status(201).json(await taskSessions.propose(req.body, 'gui'));
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return res.status(error instanceof TaskSessionError ? error.status : 503)
      .json({ error: error instanceof TaskSessionError ? error.message : 'Task session storage unavailable' });
  }
}
