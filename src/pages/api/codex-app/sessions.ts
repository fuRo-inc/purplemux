import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveCodexAppTab } from '@/lib/codex-app-tab';
import { getCodexGuiRuntime } from '@/lib/codex-app-gui';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { workspaceId, tabId, cursor, search, scope } = req.query;
  if ((cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 3000)) ||
      (search !== undefined && (typeof search !== 'string' || search.length > 160)) ||
      (scope !== undefined && scope !== 'host' && scope !== 'workspace')) {
    return res.status(400).json({ error: 'Invalid session search parameters' });
  }
  try {
    const { workspace, tab } = await resolveCodexAppTab(workspaceId, tabId);
    const runtime = await getCodexGuiRuntime(workspace, tab);
    const page = await runtime.listThreads({
      cursor: typeof cursor === 'string' ? cursor : undefined,
      search: typeof search === 'string' ? search : undefined,
      scope: scope === 'workspace' ? 'workspace' : 'host',
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(page);
  } catch (error) {
    return res.status(502).json({
      error: error instanceof Error ? error.message.slice(0, 250) : 'Could not list Codex sessions',
    });
  }
}
