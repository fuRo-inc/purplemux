import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveCodexAppTab } from '@/lib/codex-app-tab';
import { getCodexGuiRuntime } from '@/lib/codex-app-gui';

export const config = { api: { responseLimit: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { workspace, tab } = await resolveCodexAppTab(req.query.workspaceId, req.query.tabId);
    const runtime = await getCodexGuiRuntime(workspace, tab);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    let closed = false;
    const unsubscribe = runtime.subscribe((snapshot) => {
      if (!closed && !res.writableEnded) {
        res.write('data: ' + JSON.stringify(snapshot) + '\n\n');
      }
    });
    const heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(': heartbeat\n\n');
    }, 20000);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    res.on('close', cleanup);
    req.on('aborted', cleanup);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Could not connect to Codex' });
  }
}
