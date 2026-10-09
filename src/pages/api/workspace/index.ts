import os from 'os';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getWorkspaces, createWorkspace } from '@/lib/workspace-store';
import { readLayoutFile, resolveLayoutFile, collectAllTabs, updateTabAgentSessionId } from '@/lib/layout-store';
import { getProviderByPanelType } from '@/lib/providers';
import { checkAgentAvailabilityForPanelType, toAgentAvailabilityError } from '@/lib/agent-availability';
import { sendKeys } from '@/lib/tmux';
import { getStatusManager } from '@/lib/status-manager';
import { createLogger } from '@/lib/logger';

const log = createLogger('workspace-api');

const SHELL_READY_DELAY_MS = 500;

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === 'GET') {
    const data = await getWorkspaces();
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const { directory, name, resumeSessionId, panelType, hostId, remoteDirectory } = req.body ?? {};
    const provider = resumeSessionId ? getProviderByPanelType(panelType ?? 'claude-code') : null;
    if (resumeSessionId) {
      if (!provider) {
        return res.status(400).json({ error: 'Unknown panel type for resume' });
      }
      if (!provider.isValidSessionId(resumeSessionId)) {
        return res.status(400).json({ error: 'Invalid session ID format' });
      }
      const availability = await checkAgentAvailabilityForPanelType(provider.panelType);
      if (!availability.ok) {
        return res.status(availability.status).json(toAgentAvailabilityError(availability));
      }
    }
    const resolvedDirectory =
      directory && typeof directory === 'string' ? directory : os.homedir();

    try {
      const layoutOptions = provider ? { panelType: provider.panelType } : undefined;
      if (hostId && (typeof hostId !== 'string' || typeof remoteDirectory !== 'string')) {
        return res.status(400).json({ error: 'hostId and remoteDirectory required' });
      }
      if (hostId && (resumeSessionId || panelType)) {
        return res.status(400).json({ error: 'Remote workspace only supports terminal at creation' });
      }
      const workspace = await createWorkspace(resolvedDirectory, name, layoutOptions, hostId ? { hostId, remoteDirectory } : undefined);

      const layout = await readLayoutFile(resolveLayoutFile(workspace.id));
      const defaultTab = layout ? collectAllTabs(layout.root)[0] : null;

      if (resumeSessionId && provider && defaultTab) {
        provider.writeSessionId(defaultTab, resumeSessionId);
        await updateTabAgentSessionId(defaultTab.sessionName, provider, resumeSessionId);
      }

      if (defaultTab && defaultTab.panelType !== 'web-browser') {
        const tabProvider = getProviderByPanelType(defaultTab.panelType);
        getStatusManager().registerTab(defaultTab.id, {
          cliState: 'inactive',
          workspaceId: workspace.id,
          tabName: defaultTab.name,
          tmuxSession: defaultTab.sessionName,
          panelType: defaultTab.panelType,
          agentProviderId: tabProvider?.id,
          agentSessionId: tabProvider?.readSessionId(defaultTab) ?? null,
          lastEvent: null,
          eventSeq: 0,
        });
      }

      if (resumeSessionId && provider && defaultTab) {
        setTimeout(async () => {
          try {
            const resumeCmd = await provider.buildResumeCommand(resumeSessionId, { workspaceId: workspace.id });
            await sendKeys(defaultTab.sessionName, resumeCmd);
            getStatusManager().markAgentLaunch(defaultTab.id);
          } catch (err) {
            log.warn(`resume sendKeys failed: ${err instanceof Error ? err.message : err}`);
          }
        }, SHELL_READY_DELAY_MS);
      }

      return res.status(200).json(workspace);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      const isValidation = ['not exist', 'directory', 'registered'].some((k) => message.includes(k));
      return res.status(isValidation ? 400 : 500).json({ error: message });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
