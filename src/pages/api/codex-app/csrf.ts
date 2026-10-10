import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateTaskSessionGui } from '@/lib/task-session-gui-auth';
import { TaskSessionError } from '@/lib/task-session-store';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    return res.status(200).json({ csrfToken: await authenticateTaskSessionGui(req) });
  } catch (error) {
    return res.status(error instanceof TaskSessionError ? error.status : 503).json({ error: 'GUI authentication required' });
  }
}
