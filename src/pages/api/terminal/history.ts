import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getWorkspaceById } from '@/lib/workspace-store';
import { getRemoteHost } from '@/lib/remote-host-store';
import { collectAllTabs, readLayoutFile, resolveLayoutFile } from '@/lib/layout-store';

const execFile = promisify(execFileCb);
const MAX_LINES = 5000;
const MAX_BUFFER = 8 * 1024 * 1024;

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

  try {
    // Never execute a client-supplied tmux target unless it belongs to the
    // requested workspace's persisted layout.
    const workspace = await getWorkspaceById(workspaceId);
    const layout = workspace ? await readLayoutFile(resolveLayoutFile(workspaceId)) : null;
    if (!workspace || !layout || !collectAllTabs(layout.root).some((tab) => tab.sessionName === sessionName)) {
      return res.status(404).json({ error: 'Workspace terminal not found' });
    }

    const tmuxArgs = ['-L', 'purple', 'capture-pane', '-p', '-J', '-S', `-${MAX_LINES}`, '-t', sessionName];
    let stdout: string;

    if (workspace.hostId) {
      const host = await getRemoteHost(workspace.hostId);
      if (!host) return res.status(404).json({ error: 'Remote host not found' });
      if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(host.username) ||
          !/^[a-zA-Z0-9.:-]+$/.test(host.address) ||
          !Number.isInteger(host.port) || host.port < 1 || host.port > 65535) {
        return res.status(400).json({ error: 'Invalid remote host connection details' });
      }
      const remote = `tmux -L purplemux_remote capture-pane -p -J -S -${MAX_LINES} -t '${sessionName}'`;
      const result = await execFile('ssh', [
        '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
        '-p', String(host.port), `${host.username}@${host.address}`, remote,
      ], { timeout: 12000, maxBuffer: MAX_BUFFER });
      stdout = result.stdout;
    } else {
      const result = await execFile('tmux', tmuxArgs, { timeout: 5000, maxBuffer: MAX_BUFFER });
      stdout = result.stdout;
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ content: stdout, source: workspace.hostId ? 'remote-tmux' : 'local-tmux' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return res.status(502).json({ error: 'Could not capture tmux history', detail: message.slice(0, 300) });
  }
}
