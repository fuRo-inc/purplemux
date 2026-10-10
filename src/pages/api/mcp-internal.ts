import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'node:crypto';
import { dispatchTaskSessionMcp } from '@/lib/mcp-task-sessions';
import { TaskSessionError } from '@/lib/task-session-store';
import { listBridgeCodexTabs, getBridgeCodexStatus } from '@/lib/mcp-bridge-data';
import {
  submitCodexTask, getCodexTask, listCodexTasks, interruptCodexTask, respondCodexApproval,
} from '@/lib/mcp-codex-tasks';

/**
 * Not a browser API. The standalone Next runtime owns the UI's Codex sessions.
 * The Purplemux parent process reaches this route only over loopback using a
 * random per-startup bearer secret. The public 8022 production proxy denies
 * this route completely; Next proxy and the route itself enforce the secret.
 */
export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: '128kb' } };

const validToken = (received: unknown, expected: string | undefined): boolean => {
  if (!expected || typeof received !== 'string' || received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
};
const loopback = (ip: string | undefined): boolean =>
  ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!loopback(req.socket.remoteAddress) ||
      !validToken(req.headers['x-pmux-mcp-internal'], process.env.__PMUX_MCP_INTERNAL_TOKEN) ||
      process.env.PURPLEMUX_MCP_ENABLED !== '1') {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  const { operation, args } = req.body ?? {};
  if (typeof operation !== 'string' || operation.length > 80 ||
      args === null || typeof args !== 'object' || Array.isArray(args)) {
    return res.status(400).json({ ok: false, error: 'Invalid MCP runtime request' });
  }
  const options = args as Record<string, unknown>;
  try {
    let data: unknown;
    switch (operation) {
      case 'propose_task_session':
      case 'get_task_session':
      case 'list_task_sessions':
        try { data = await dispatchTaskSessionMcp(operation, options); }
        catch (error) {
          return res.status(error instanceof TaskSessionError ? error.status : 503)
            .json({ ok: false, error: error instanceof TaskSessionError ? error.message : 'Task session storage unavailable' });
        }
        break;
      case 'list_codex_tabs':
        data = await listBridgeCodexTabs(options.workspaceId);
        break;
      case 'get_codex_status':
        data = await getBridgeCodexStatus(
          options.workspaceId, options.tabId, options.includeRecentItems ?? false);
        break;
      case 'start_codex_task':
        data = await submitCodexTask(options);
        break;
      case 'get_codex_task':
        data = await getCodexTask(options);
        break;
      case 'list_codex_tasks':
        data = await listCodexTasks(options);
        break;
      case 'interrupt_codex_task':
        data = await interruptCodexTask(options);
        break;
      case 'respond_codex_approval':
        data = await respondCodexApproval(options);
        break;
      default:
        return res.status(400).json({ ok: false, error: 'Unsupported MCP runtime operation' });
    }
    return res.status(200).json({ ok: true, data });
  } catch (error) {
    // Errors are deliberately bounded, with no raw exception stack or secrets.
    const message = error instanceof Error ? error.message : 'Codex MCP request failed';
    return res.status(400).json({ ok: false, error: message.slice(0, 350) });
  }
}
