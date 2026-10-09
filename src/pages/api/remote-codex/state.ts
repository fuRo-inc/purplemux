import type { NextApiRequest, NextApiResponse } from 'next';
import { getWorkspaceById } from '@/lib/workspace-store';
import { collectAllTabs, readLayoutFile, resolveLayoutFile } from '@/lib/layout-store';
import { readRemoteCodexSnapshot } from '@/lib/remote-codex';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const workspaceId = typeof req.query.workspace === 'string' ? req.query.workspace : '';
  const sessionName = typeof req.query.session === 'string' ? req.query.session : '';
  if (!workspaceId || !/^pt-[a-zA-Z0-9-]+$/.test(sessionName)) {
    return res.status(400).json({ error: 'Invalid workspace or session' });
  }
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace?.hostId) return res.status(404).json({ error: 'Remote workspace not found' });
  const layout = await readLayoutFile(resolveLayoutFile(workspaceId));
  const tab = layout ? collectAllTabs(layout.root).find((t) => t.sessionName === sessionName) : null;
  if (!tab || (tab.panelType !== 'codex-cli' && tab.remoteAgent !== 'codex')) {
    return res.status(404).json({ error: 'Remote Codex tab not found' });
  }

  try {
    const snapshot = await readRemoteCodexSnapshot(workspace, tab);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to contact remote host';
    return res.status(502).json({ error: message.slice(0, 220) });
  }
}
