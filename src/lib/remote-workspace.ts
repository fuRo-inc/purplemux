import type { IWorkspace } from '@/types/terminal';
import { getRemoteHost } from '@/lib/remote-host-store';

const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

export const buildRemoteShellCommand = async (
  workspace: IWorkspace,
  initialCommand?: 'codex',
  sessionName?: string,
): Promise<string> => {
  if (!workspace.hostId || !workspace.remoteDirectory) throw new Error('Remote workspace is missing host or directory');
  const host = await getRemoteHost(workspace.hostId);
  if (!host) throw new Error('Remote host no longer exists');
  // Prevent interpreting stored host fields as SSH CLI options or shell code.
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(host.username) ||
      !/^[a-zA-Z0-9.:-]+$/.test(host.address)) {
    throw new Error('Invalid SSH user or host address');
  }
  if (!workspace.remoteDirectory.startsWith('/') || workspace.remoteDirectory.includes('\\n')) {
    throw new Error('Remote directory must be an absolute path');
  }
  if (!sessionName || !/^pt-[a-zA-Z0-9-]+$/.test(sessionName)) throw new Error('Invalid remote tmux session name');
  const launch = initialCommand ? `bash -lic ${quote('codex; exec bash -l')}` : undefined;
  const remote = `tmux -L purplemux_remote new-session -A -s ${quote(sessionName)} -c ${quote(workspace.remoteDirectory)}${launch ? ` ${quote(launch)}` : ''}`;
  return `exec ssh -tt -o BatchMode=yes -o ConnectTimeout=5 -p ${host.port} ${quote(host.username + '@' + host.address)} ${quote(remote)}`;
};
