import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveCodexAppTab } from '@/lib/codex-app-tab';
import { authenticateTaskSessionGui } from '@/lib/task-session-gui-auth';
import { taskSessions, TaskSessionError } from '@/lib/task-session-store';
import { getCodexGuiRuntime } from '@/lib/codex-app-gui';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { workspaceId, tabId, action, text, model, effort, requestId, decision, threadId, sandboxMode, approvalPolicy, fastMode } = req.body ?? {};
  if (!['send', 'interrupt', 'approve', 'new-thread', 'settings', 'resume-thread'].includes(action)) {
    return res.status(400).json({ error: 'Invalid Codex action' });
  }
  if (text !== undefined && (typeof text !== 'string' || text.length > 100000)) {
    return res.status(400).json({ error: 'Message too long' });
  }
  if ((model !== undefined && (typeof model !== 'string' || model.length > 100)) ||
      (effort !== undefined && (typeof effort !== 'string' || effort.length > 32))) {
    return res.status(400).json({ error: 'Invalid model configuration' });
  }
  if (action === 'resume-thread' &&
      (typeof threadId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(threadId))) {
    return res.status(400).json({ error: 'Invalid Codex session ID' });
  }
  if ((sandboxMode !== undefined && !['read-only', 'workspace-write', 'danger-full-access'].includes(sandboxMode)) ||
      (approvalPolicy !== undefined && !['on-request', 'never'].includes(approvalPolicy)) ||
      (fastMode !== undefined && typeof fastMode !== 'boolean')) {
    return res.status(400).json({ error: 'Invalid Codex permission or speed settings' });
  }
  try {
    const explicitElevation = sandboxMode === 'danger-full-access' || approvalPolicy === 'never';
    if (explicitElevation) await authenticateTaskSessionGui(req);
    const { workspace, tab } = await resolveCodexAppTab(workspaceId, tabId);
    const runtime = await getCodexGuiRuntime(workspace, tab);
    const snapshot = await taskSessions.withTabAccess(workspace.id, tab.id, ['approve', 'interrupt'].includes(action), async () => {
      const current = runtime.snapshot();
      // A CLI caller must also be unable to reuse deliberately elevated GUI settings.
      if (!explicitElevation && (current.taskPermissionsActive ||
          (['send', 'new-thread', 'resume-thread', 'settings'].includes(action) &&
            (current.sandboxMode === 'danger-full-access' || current.approvalPolicy === 'never')))) await authenticateTaskSessionGui(req);
      return runtime.action(action, { text, model, effort, requestId, decision, threadId, sandboxMode, approvalPolicy, fastMode });
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(snapshot);
  } catch (error) {
    return res.status(error instanceof TaskSessionError ? error.status : 400).json({ error: error instanceof Error ? error.message : 'Codex request failed' });
  }
}
