import type { NextApiRequest, NextApiResponse } from 'next';
import {
  deleteRemoteHost,
  getRemoteHost,
  testRemoteHost,
  updateRemoteHost,
} from '@/lib/remote-host-store';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  const hostId = req.query.hostId as string;
  const host = await getRemoteHost(hostId);

  if (req.method === 'GET') {
    if (!host) return res.status(404).json({ error: 'Host not found' });
    return res.status(200).json(host);
  }

  if (req.method === 'PATCH') {
    try {
      const updated = await updateRemoteHost(hostId, req.body ?? {});
      if (!updated) return res.status(404).json({ error: 'Host not found' });
      return res.status(200).json(updated);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid host' });
    }
  }

  if (req.method === 'DELETE') {
    const deleted = await deleteRemoteHost(hostId);
    if (!deleted) return res.status(404).json({ error: 'Host not found' });
    return res.status(204).end();
  }

  if (req.method === 'POST' && req.query.action === 'test') {
    if (!host) return res.status(404).json({ error: 'Host not found' });
    const result = await testRemoteHost(host);
    return res.status(result.ok ? 200 : 502).json(result);
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
