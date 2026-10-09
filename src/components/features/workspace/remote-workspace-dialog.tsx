import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import useWorkspaceStore from '@/hooks/use-workspace-store';
import type { IRemoteHost } from '@/types/remote-host';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (workspaceId: string) => void;
}

export default function RemoteWorkspaceDialog({ open, onOpenChange, onCreated }: Props) {
  const [hosts, setHosts] = useState<IRemoteHost[]>([]);
  const [hostId, setHostId] = useState('');
  const [directory, setDirectory] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch('/api/hosts')
      .then((r) => { if (!r.ok) throw new Error('Host list unavailable'); return r.json(); })
      .then((data: { hosts: IRemoteHost[] }) => {
        if (cancelled) return;
        setHosts(data.hosts);
        setHostId((prev) => data.hosts.some((h) => h.id === prev) ? prev : (data.hosts[0]?.id ?? ''));
      })
      .catch(() => toast.error('Remote hosts could not be loaded'));
    return () => { cancelled = true; };
  }, [open]);

  const create = async () => {
    if (!hostId || !directory.trim().startsWith('/') || busy) return;
    setBusy(true);
    try {
      const response = await fetch('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostId, remoteDirectory: directory.trim(), name: name.trim() || undefined }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Failed to create workspace');
      await useWorkspaceStore.getState().fetchWorkspaces();
      onOpenChange(false);
      onCreated(result.id);
      setDirectory('');
      setName('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create workspace');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle>New Remote Workspace</DialogTitle>
        <label className="space-y-1 text-sm">
          <span>Host</span>
          <select className="h-9 w-full rounded-md border bg-background px-2" value={hostId} onChange={(e) => setHostId(e.target.value)}>
            {hosts.map((host) => <option key={host.id} value={host.id}>{host.name} ({host.address})</option>)}
          </select>
        </label>
        {hosts.length === 0 && <p className="text-sm text-muted-foreground">Register a host under Settings → Tailscale → Remote Hosts first.</p>}
        <label className="space-y-1 text-sm">
          <span>Remote directory (absolute path)</span>
          <Input placeholder="/home/user/project" value={directory} onChange={(e) => setDirectory(e.target.value)} />
        </label>
        <label className="space-y-1 text-sm">
          <span>Workspace name (optional)</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => void create()} disabled={busy || !hostId || !directory.trim().startsWith('/')}>Create</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
