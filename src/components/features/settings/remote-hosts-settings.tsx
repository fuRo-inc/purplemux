import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Pencil, Plus, Server, Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { IRemoteHost, IRemoteHostInput } from '@/types/remote-host';
import useWorkspaceStore from '@/hooks/use-workspace-store';

const EMPTY_FORM: IRemoteHostInput = {
  name: '',
  address: '',
  username: '',
  port: 22,
  description: '',
};

const RemoteHostsSettings = () => {
  const [hosts, setHosts] = useState<IRemoteHost[]>([]);
  const [form, setForm] = useState<IRemoteHostInput>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [remoteDirectories, setRemoteDirectories] = useState<Record<string, string>>({});
  const [creatingWorkspaceId, setCreatingWorkspaceId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testState, setTestState] = useState<Record<string, { ok: boolean; text: string }>>({});

  const loadHosts = useCallback(async () => {
    try {
      const res = await fetch('/api/hosts');
      if (!res.ok) throw new Error();
      const data = await res.json() as { hosts: IRemoteHost[] };
      setHosts(data.hosts);
    } catch {
      toast.error('Failed to load remote hosts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHosts();
  }, [loadHosts]);

  const resetForm = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const startEdit = (host: IRemoteHost) => {
    setEditingId(host.id);
    setForm({
      name: host.name,
      address: host.address,
      username: host.username,
      port: host.port,
      description: host.description ?? '',
    });
  };

  const saveHost = async () => {
    if (!form.name.trim() || !form.address.trim() || !form.username.trim()) {
      toast.error('Name, address and SSH user are required');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(editingId ? `/api/hosts/${editingId}` : '/api/hosts', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save host');
      toast.success(editingId ? 'Remote host updated' : 'Remote host added');
      resetForm();
      await loadHosts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save host');
    } finally {
      setSaving(false);
    }
  };

  const deleteHost = async (host: IRemoteHost) => {
    if (!window.confirm(`Delete remote host "${host.name}"?`)) return;
    try {
      const res = await fetch(`/api/hosts/${host.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error();
      setHosts((current) => current.filter((item) => item.id !== host.id));
      if (editingId === host.id) resetForm();
      setTestState((current) => {
        const next = { ...current };
        delete next[host.id];
        return next;
      });
    } catch {
      toast.error('Failed to delete remote host');
    }
  };

  const createHostWorkspace = async (host: IRemoteHost) => {
    const remoteDirectory = (remoteDirectories[host.id] ?? '').trim();
    if (!remoteDirectory.startsWith('/')) {
      toast.error('Enter an absolute remote directory path');
      return;
    }
    setCreatingWorkspaceId(host.id);
    try {
      const res = await fetch('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: host.name, hostId: host.id, remoteDirectory }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Workspace creation failed');
      await useWorkspaceStore.getState().fetchWorkspaces();
      useWorkspaceStore.getState().switchWorkspace(data.id);
      toast.success('Remote workspace created. Close Settings to use Terminal.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Workspace creation failed');
    } finally {
      setCreatingWorkspaceId(null);
    }
  };

  const testHost = async (host: IRemoteHost) => {
    setTestingId(host.id);
    setTestState((current) => ({ ...current, [host.id]: { ok: false, text: 'Testing...' } }));
    try {
      const res = await fetch(`/api/hosts/${host.id}?action=test`, { method: 'POST' });
      const data = await res.json() as { ok: boolean; latencyMs: number; hostname?: string; error?: string };
      if (!res.ok || !data.ok) {
        setTestState((current) => ({
          ...current,
          [host.id]: { ok: false, text: data.error || 'SSH connection failed' },
        }));
        return;
      }
      setTestState((current) => ({
        ...current,
        [host.id]: { ok: true, text: `${data.hostname ?? host.address} · ${data.latencyMs} ms` },
      }));
    } catch {
      setTestState((current) => ({
        ...current,
        [host.id]: { ok: false, text: 'SSH connection failed' },
      }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="mt-8 space-y-5 border-t pt-6">
      <div>
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm font-medium">Remote Hosts</p>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Register development machines reachable from the Purplemux server over Tailscale/SSH.
          SSH keys are used from the machine running Purplemux.
        </p>
      </div>

      <div className="grid gap-2 rounded-lg border p-3 md:grid-cols-2">
        <Input
          placeholder="Name (e.g. sruppTo)"
          value={form.name}
          onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))}
        />
        <Input
          placeholder="Tailscale IP / hostname"
          value={form.address}
          onChange={(e) => setForm((current) => ({ ...current, address: e.target.value }))}
        />
        <Input
          placeholder="SSH user"
          value={form.username}
          onChange={(e) => setForm((current) => ({ ...current, username: e.target.value }))}
        />
        <Input
          type="number"
          min={1}
          max={65535}
          placeholder="SSH port"
          value={form.port ?? 22}
          onChange={(e) => setForm((current) => ({ ...current, port: Number(e.target.value) }))}
        />
        <Input
          className="md:col-span-2"
          placeholder="Description (optional)"
          value={form.description ?? ''}
          onChange={(e) => setForm((current) => ({ ...current, description: e.target.value }))}
        />
        <div className="flex justify-end gap-2 md:col-span-2">
          {editingId && (
            <Button variant="outline" size="sm" onClick={resetForm} disabled={saving}>
              Cancel
            </Button>
          )}
          <Button size="sm" onClick={saveHost} disabled={saving}>
            {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-1.5 h-3.5 w-3.5" />}
            {editingId ? 'Update host' : 'Add host'}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading hosts...
          </div>
        )}
        {!loading && hosts.length === 0 && (
          <p className="text-sm text-muted-foreground">No remote hosts registered.</p>
        )}
        {hosts.map((host) => {
          const status = testState[host.id];
          return (
            <div key={host.id} className="flex flex-col gap-3 rounded-lg border px-3 py-2.5 md:flex-row md:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{host.name}</span>
                  <code className="text-xs text-muted-foreground">
                    {host.username}@{host.address}:{host.port}
                  </code>
                </div>
                {host.description && (
                  <p className="mt-1 truncate text-xs text-muted-foreground">{host.description}</p>
                )}
                {status && (
                  <div className={`mt-1 flex items-center gap-1.5 text-xs ${status.ok ? 'text-ui-green' : 'text-ui-red'}`}>
                    {status.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                    <span className="break-all">{status.text}</span>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 flex-col gap-1.5">
                <div className="flex gap-1.5">
                <Button variant="outline" size="sm" onClick={() => void testHost(host)} disabled={testingId === host.id}>
                  {testingId === host.id && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  Test SSH
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => startEdit(host)} aria-label="Edit host">
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-ui-red hover:text-ui-red"
                  onClick={() => void deleteHost(host)}
                  aria-label="Delete host"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
                </div>
                <Input
                  className="h-8 min-w-48 text-xs"
                  placeholder="/home/user/project"
                  value={remoteDirectories[host.id] ?? ''}
                  onChange={(e) => setRemoteDirectories((previous) => ({ ...previous, [host.id]: e.target.value }))}
                />
                <Button variant="outline" size="sm" onClick={() => void createHostWorkspace(host)} disabled={creatingWorkspaceId === host.id}>
                  {creatingWorkspaceId === host.id ? 'Creating...' : 'Create remote workspace'}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default RemoteHostsSettings;
