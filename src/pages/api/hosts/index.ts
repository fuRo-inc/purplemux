import type { NextApiRequest, NextApiResponse } from 'next';
import { createRemoteHost, listRemoteHosts } from '@/lib/remote-host-store';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === 'GET') {
    return res.status(200).json({ hosts: await listRemoteHosts() });
  }

  if (req.method === 'POST') {
    try {
      const host = await createRemoteHost(req.body ?? {});
      return res.status(201).json(host);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid host' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
