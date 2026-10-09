import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquare, Play, RefreshCw, SendHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Spinner from '@/components/ui/spinner';
import TimelineView from '@/components/features/timeline/timeline-view';
import type { ITimelineEntry } from '@/types/timeline';

interface IRemoteCodexSnapshot {
  running: boolean;
  sessionId: string | null;
  cwd: string | null;
  entries: ITimelineEntry[];
}

interface IRemoteCodexPanelProps {
  workspaceId: string;
  sessionName: string;
  sendStdin: (data: string) => void;
  terminalConnected: boolean;
  mobile?: boolean;
}

const POLL_MS = 3500;

export default function RemoteCodexPanel({
  workspaceId,
  sessionName,
  sendStdin,
  terminalConnected,
  mobile = false,
}: IRemoteCodexPanelProps) {
  const [snapshot, setSnapshot] = useState<IRemoteCodexSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [refreshSerial, setRefreshSerial] = useState(0);
  const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(() => setRefreshSerial((value) => value + 1), []);

  useEffect(() => {
    let disposed = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const aborter = new AbortController();
    setSnapshot(null);
    setLoading(true);
    setError(null);

    const poll = async () => {
      try {
        const query = new URLSearchParams({ workspace: workspaceId, session: sessionName });
        const result = await fetch(`/api/remote-codex/state?${query.toString()}`, {
          cache: 'no-store',
          signal: aborter.signal,
        });
        const data = await result.json() as IRemoteCodexSnapshot & { error?: string };
        if (!result.ok) throw new Error(data.error || 'Remote Codex is unavailable');
        if (disposed) return;
        setSnapshot(data);
        setError(null);
      } catch (reason) {
        if (disposed || aborter.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : 'Cannot reach remote Codex');
      } finally {
        if (!disposed) {
          setLoading(false);
          timeout = setTimeout(poll, POLL_MS);
        }
      }
    };
    void poll();
    return () => {
      disposed = true;
      aborter.abort();
      if (timeout) clearTimeout(timeout);
    };
  }, [workspaceId, sessionName, refreshSerial]);

  useEffect(() => () => {
    if (sendTimer.current) clearTimeout(sendTimer.current);
  }, []);

  const startCodex = useCallback(() => {
    if (!terminalConnected) return;
    sendStdin('codex\r');
    setLoading(true);
    // Session metadata is written asynchronously by the CLI.
    setTimeout(reload, 1300);
  }, [terminalConnected, reload, sendStdin]);

  const send = useCallback(() => {
    const text = draft;
    if (!text.trim() || !terminalConnected || !snapshot?.running) return;
    if (text.includes('\n')) sendStdin(`\x1b[200~${text}\x1b[201~`);
    else sendStdin(text);
    if (sendTimer.current) clearTimeout(sendTimer.current);
    // Codex TUI needs the Enter key after paste/text processing.
    sendTimer.current = setTimeout(() => sendStdin('\r'), 250);
    setDraft('');
  }, [draft, terminalConnected, snapshot?.running, sendStdin]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <MessageSquare className="h-3.5 w-3.5" />
        <span className="font-medium">Codex Chat</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {snapshot?.cwd ?? 'Remote Host'}
        </span>
        <span className="text-muted-foreground">{snapshot?.running ? 'Running' : 'Idle'}</span>
        <Button variant="ghost" size="xs" aria-label="チャットを更新" onClick={reload}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {loading && !snapshot ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" /> リモートCodexを確認しています…
        </div>
      ) : error && !snapshot ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-sm text-muted-foreground">
          <p>GMKtecなどの接続先でCodexの状態を取得できませんでした。</p>
          <p className="text-xs">{error}</p>
          <Button variant="outline" size="sm" onClick={reload}>再試行</Button>
        </div>
      ) : snapshot?.entries.length ? (
        <div className="min-h-0 flex-1">
          <TimelineView
            entries={snapshot.entries}
            tasks={[]}
            sessionId={snapshot.sessionId}
            cliState={snapshot.running ? 'idle' : 'inactive'}
            wsStatus={error ? 'reconnecting' : 'connected'}
            isLoading={false}
            error={null}
            onRetry={reload}
            onLoadMore={async () => {}}
            hasMore={false}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-5 text-center text-sm text-muted-foreground">
          <MessageSquare className="h-7 w-7 opacity-50" />
          <span>{snapshot?.running ? 'Codexの会話ログが作成されるのを待っています。' : 'このタブではCodexが起動していません。'}</span>
          {!snapshot?.running && (
            <Button size="sm" className="gap-2" onClick={startCodex} disabled={!terminalConnected}>
              <Play className="h-3.5 w-3.5" /> Codexを起動
            </Button>
          )}
        </div>
      )}

      <div className="shrink-0 border-t border-border p-2">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                send();
              }
            }}
            rows={mobile ? 2 : 1}
            placeholder={snapshot?.running ? 'Codexへメッセージを送信' : 'Codexの起動後に入力できます'}
            disabled={!snapshot?.running || !terminalConnected}
            className="min-h-9 max-h-28 flex-1 resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-ring disabled:opacity-50"
          />
          <Button
            size="sm"
            className="h-9 gap-1"
            onClick={send}
            disabled={!snapshot?.running || !terminalConnected || !draft.trim()}
          >
            <SendHorizontal className="h-3.5 w-3.5" />
            {!mobile && '送信'}
          </Button>
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">
          {mobile ? 'Chat / Terminal は上部メニューから切替' : 'Terminalへの切替はタブの Chat / Terminal から'}
          {' · '}実行とファイル操作はSSH先で行われます
        </p>
      </div>
    </div>
  );
}
