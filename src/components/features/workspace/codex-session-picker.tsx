import { useCallback, useEffect, useRef, useState } from 'react';
import { Clock3, Folder, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import type { CodexGuiSessionPage, CodexGuiSessionSummary } from '@/lib/codex-app-gui';

interface ICodexSessionPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  tabId: string;
  currentThreadId: string | null;
  busy: boolean;
  onResume: (session: CodexGuiSessionSummary) => Promise<void>;
}

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '日時不明';
  return new Date(seconds * 1000).toLocaleString('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

const normalizePath = (cwd: string) => cwd.replace(/\/+$/, '') || '/';

export default function CodexSessionPicker({
  open, onOpenChange, workspaceId, tabId, currentThreadId, busy, onResume,
}: ICodexSessionPickerProps) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [scope, setScope] = useState<'host' | 'workspace'>('host');
  const [sessions, setSessions] = useState<CodexGuiSessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [workspaceCwd, setWorkspaceCwd] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [confirmSession, setConfirmSession] = useState<CodexGuiSessionSummary | null>(null);
  const generationRef = useRef(0);
  const [refreshId, setRefreshId] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 240);
    return () => clearTimeout(timer);
  }, [search]);

  const loadPage = useCallback(async (cursor: string | null, reset: boolean) => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError('');
    if (reset) {
      setSessions([]);
      setNextCursor(null);
      setConfirmSession(null);
    }
    try {
      const params = new URLSearchParams({ workspaceId, tabId, scope });
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (cursor) params.set('cursor', cursor);
      const response = await fetch('/api/codex-app/sessions?' + params.toString(), { cache: 'no-store' });
      const page = await response.json() as CodexGuiSessionPage & { error?: string };
      if (!response.ok) throw new Error(page.error || 'セッションの取得に失敗しました');
      if (generation !== generationRef.current) return;
      setWorkspaceCwd(page.workspaceCwd);
      setSessions((previous) => {
        const seen = new Set<string>();
        return (reset ? page.sessions : [...previous, ...page.sessions]).filter((session) => {
          if (seen.has(session.id)) return false;
          seen.add(session.id);
          return true;
        });
      });
      setNextCursor(page.nextCursor);
    } catch (reason) {
      if (generation !== generationRef.current) return;
      setError(reason instanceof Error ? reason.message : '通信エラー');
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [workspaceId, tabId, scope, debouncedSearch]);

  useEffect(() => {
    if (!open) {
      generationRef.current++;
      return;
    }
    void loadPage(null, true);
    return () => { generationRef.current++; };
  }, [open, loadPage, refreshId]);

  const selectSession = async (session: CodexGuiSessionSummary) => {
    if (busy || selectingId || loading) return;
    if (session.id === currentThreadId) { onOpenChange(false); return; }
    const differentCwd = workspaceCwd && session.cwd &&
      normalizePath(session.cwd) !== normalizePath(workspaceCwd);
    if (differentCwd && confirmSession?.id !== session.id) {
      setConfirmSession(session);
      return;
    }
    setConfirmSession(null);
    setSelectingId(session.id);
    setError('');
    try {
      await onResume(session);
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '会話を再開できませんでした');
    } finally {
      setSelectingId(null);
    }
  };

  const visible = sessions.filter((session) => {
    // Older Codex app-server versions may ignore searchTerm. Keep the
    // client-side filter as a compatibility fallback on each page.
    if (!debouncedSearch) return true;
    const text = [session.preview, session.cwd, session.id, session.model || ''].join(' ').toLocaleLowerCase();
    return text.includes(debouncedSearch.toLocaleLowerCase());
  });

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!selectingId) onOpenChange(value); }}>
      <DialogContent className="flex max-h-[min(82dvh,760px)] w-[calc(100vw-1.5rem)] max-w-2xl flex-col gap-3 overflow-hidden p-4 sm:p-5">
        <DialogHeader>
          <DialogTitle>以前のCodexセッション</DialogTitle>
          <DialogDescription>
            現在のHostに保存された会話を検索し、選択したChatタブで続きを実行できます。
          </DialogDescription>
        </DialogHeader>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="過去のCodex会話を検索"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="会話のタイトル・作業フォルダ・セッションIDで検索"
              className="pl-9"
            />
          </div>
          <Button size="sm" variant="outline" disabled={loading} onClick={() => setRefreshId((v) => v + 1)}
            aria-label="会話履歴を更新" title="会話履歴を更新">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs">
          <label htmlFor="codex-session-scope" className="shrink-0 text-muted-foreground">検索対象</label>
          <select
            id="codex-session-scope"
            value={scope}
            onChange={(event) => setScope(event.target.value as 'host' | 'workspace')}
            className="h-8 max-w-full rounded-md border bg-background px-2 text-xs"
          >
            <option value="host">このHostのすべての会話</option>
            <option value="workspace">この作業ディレクトリのみ</option>
          </select>
          <span className="ml-auto shrink-0 text-muted-foreground">{visible.length} 件表示</span>
        </div>

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto rounded-md border p-1" style={{ overscrollBehavior: 'contain' }}>
          {visible.map((session) => (
            <button
              key={session.id}
              type="button"
              disabled={!!selectingId || busy}
              onClick={() => void selectSession(session)}
              className="flex w-full flex-col gap-1.5 rounded-md px-3 py-3 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
            >
              <span className="flex w-full items-start justify-between gap-2">
                <span className="min-w-0 flex-1 break-words text-sm font-medium">
                  {session.preview.trim() || 'タイトルのない会話'}
                </span>
                {session.id === currentThreadId && (
                  <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-[10px]">現在の会話</span>
                )}
                {selectingId === session.id && <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" />}
              </span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" />{formatTime(session.updatedAt || session.createdAt)}</span>
                <span>{session.model || 'Codex'}</span>
                <span>{session.source}</span>
              </span>
              {session.cwd && (
                <span className="inline-flex max-w-full items-start gap-1 break-all font-mono text-[10px] text-muted-foreground">
                  <Folder className="mt-0.5 h-3 w-3 shrink-0" />{session.cwd}
                </span>
              )}
            </button>
          ))}
          {loading && sessions.length === 0 && (
            <p className="flex items-center justify-center gap-2 px-3 py-9 text-sm text-muted-foreground">
              <LoaderCircle className="h-4 w-4 animate-spin" /> 履歴を取得中…
            </p>
          )}
          {!loading && visible.length === 0 && (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              一致する会話がありません。必要に応じて「さらに読み込む」または検索対象を変更してください。
            </p>
          )}
          {nextCursor && (
            <div className="py-2 text-center">
              <Button size="sm" variant="outline" disabled={loading} onClick={() => void loadPage(nextCursor, false)}>
                {loading ? '取得中…' : 'さらに読み込む'}
              </Button>
            </div>
          )}
        </div>

        {confirmSession && (
          <div className="shrink-0 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
            <p className="font-medium">異なる作業ディレクトリの会話です</p>
            <p className="break-all text-muted-foreground">再開先：{confirmSession.cwd}</p>
            <p className="text-muted-foreground">続けると、この会話の元の作業ディレクトリでCodexが動作します。既存の会話履歴は削除されません。</p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" disabled={!!selectingId} onClick={() => setConfirmSession(null)}>キャンセル</Button>
              <Button size="sm" disabled={!!selectingId || busy} onClick={() => void selectSession(confirmSession)}>
                {selectingId ? '復元中…' : 'この場所で会話を再開'}
              </Button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="shrink-0 text-xs text-destructive">{error}</p>}
        {busy && <p className="shrink-0 text-xs text-muted-foreground">Codexの処理中はセッションを切り替えられません。</p>}
      </DialogContent>
    </Dialog>
  );
}
