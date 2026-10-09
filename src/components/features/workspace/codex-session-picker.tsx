import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Circle, Folder, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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

const RECENT_PER_GROUP = 6;

const normalizedPath = (cwd: string) => cwd.replace(/\/+$/, '') || '/';
const displayPath = (cwd: string) => cwd.replace(/^\/home\/[^/]+(?=\/|$)/, '~') || '(ディレクトリ不明)';
const timeSince = (seconds: number) => {
  if (!seconds) return '—';
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (diff < 60) return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + 'd ago';
  return new Date(seconds * 1000).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
};

const statusOf = (status: string) => {
  switch (status) {
    case 'idle': return { label: 'Ready', color: 'text-emerald-500' };
    case 'active': return { label: 'Running', color: 'text-sky-400' };
    case 'systemError': return { label: 'Error', color: 'text-red-400' };
    case 'notLoaded': return { label: 'Inactive', color: 'text-muted-foreground' };
    default: return { label: 'Inactive', color: 'text-muted-foreground' };
  }
};

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
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const generationRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
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
      setSelectedId(null);
      setExpandedGroups({});
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

  const groups = useMemo(() => {
    const filtered = sessions.filter((session) =>
      !debouncedSearch ||
      [session.preview, session.cwd, session.id, session.model || ''].join(' ')
        .toLocaleLowerCase().includes(debouncedSearch.toLocaleLowerCase()),
    );
    const byCwd = new Map<string, CodexGuiSessionSummary[]>();
    for (const session of filtered) {
      const cwd = session.cwd || '(unknown)';
      const group = byCwd.get(cwd) ?? [];
      group.push(session);
      byCwd.set(cwd, group);
    }
    return Array.from(byCwd.entries())
      .map(([cwd, rows]) => ({
        cwd,
        rows: rows.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)),
      }))
      .sort((a, b) => (b.rows[0]?.updatedAt || b.rows[0]?.createdAt || 0) -
        (a.rows[0]?.updatedAt || a.rows[0]?.createdAt || 0));
  }, [sessions, debouncedSearch]);

  const visibleGroups = useMemo(() =>
    groups.map(({ cwd, rows }) => ({
      cwd,
      count: rows.length,
      rows: expandedGroups[cwd] || debouncedSearch ? rows : rows.slice(0, RECENT_PER_GROUP),
    })),
  [groups, expandedGroups, debouncedSearch]);

  const visibleRows = useMemo(() => visibleGroups.flatMap((group) => group.rows), [visibleGroups]);
  const activeId = selectedId && visibleRows.some((row) => row.id === selectedId)
    ? selectedId : visibleRows[0]?.id ?? null;

  const selectSession = async (session: CodexGuiSessionSummary) => {
    if (busy || selectingId || loading) return;
    if (session.id === currentThreadId) { onOpenChange(false); return; }
    if (workspaceCwd && session.cwd && normalizedPath(session.cwd) !== normalizedPath(workspaceCwd)
        && confirmSession?.id !== session.id) {
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

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!visibleRows.length) return;
      const index = visibleRows.findIndex((row) => row.id === activeId);
      const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + visibleRows.length) % visibleRows.length;
      const id = visibleRows[next].id;
      setSelectedId(id);
      const element = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-session-id]') ?? [])
        .find((node) => node.dataset.sessionId === id);
      element?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && activeId) {
      event.preventDefault();
      const row = visibleRows.find((session) => session.id === activeId);
      if (row) void selectSession(row);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!selectingId) onOpenChange(value); }}>
      <DialogContent className="flex h-[min(85dvh,790px)] w-[calc(100vw-1.5rem)] max-w-5xl flex-col gap-3 overflow-hidden p-4 sm:p-5">
        <DialogHeader>
          <DialogTitle>Codex セッション</DialogTitle>
          <DialogDescription>
            作業ディレクトリ別の履歴から、以前の会話の続きを開けます。
          </DialogDescription>
        </DialogHeader>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="セッションを検索"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="会話名・作業ディレクトリ・IDを検索"
              className="pl-9"
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && visibleRows.length) {
                  event.preventDefault();
                  listRef.current?.focus();
                }
              }}
            />
          </div>
          <select
            aria-label="履歴の対象範囲"
            value={scope}
            onChange={(event) => setScope(event.target.value as 'host' | 'workspace')}
            className="h-9 max-w-52 rounded-md border bg-background px-2 text-xs"
          >
            <option value="host">このHostのすべて</option>
            <option value="workspace">現在のディレクトリ</option>
          </select>
          <Button size="sm" variant="outline" disabled={loading} onClick={() => setRefreshId((v) => v + 1)}
            aria-label="会話履歴を更新">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_74px] gap-3 border-b px-3 pb-2 text-[11px] font-medium text-muted-foreground sm:grid-cols-[minmax(0,1fr)_108px_84px]">
          <span>Tasks</span>
          <span className="hidden sm:block">Status</span>
          <span className="text-right">Updated</span>
        </div>

        <div
          ref={listRef}
          tabIndex={0}
          role="listbox"
          aria-label="Codexセッション一覧"
          aria-activedescendant={activeId ? 'codex-session-' + activeId : undefined}
          onKeyDown={onListKeyDown}
          className="min-h-0 flex-1 overflow-y-auto rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={{ overscrollBehavior: 'contain' }}
        >
          {visibleGroups.map((group) => (
            <section key={group.cwd} className="pb-3">
              <div className="flex items-center gap-2 px-3 pb-1 pt-3 text-xs text-muted-foreground">
                <Folder className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 truncate font-mono" title={group.cwd}>{displayPath(group.cwd)}</span>
                <span className="shrink-0 tabular-nums">{group.count}</span>
              </div>
              <div className="flex flex-col">
                {group.rows.map((session) => {
                  const isActive = activeId === session.id;
                  const status = statusOf(session.status);
                  const time = session.updatedAt || session.createdAt;
                  return (
                    <button
                      key={session.id}
                      id={'codex-session-' + session.id}
                      data-session-id={session.id}
                      role="option"
                      aria-selected={isActive}
                      type="button"
                      title={session.preview || session.id}
                      disabled={!!selectingId || busy}
                      onMouseEnter={() => setSelectedId(session.id)}
                      onFocus={() => setSelectedId(session.id)}
                      onClick={() => void selectSession(session)}
                      className={`grid w-full grid-cols-[minmax(0,1fr)_74px] items-center gap-3 rounded-sm px-3 py-1.5 text-left text-xs transition-colors sm:grid-cols-[minmax(0,1fr)_108px_84px] ${isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'} disabled:opacity-50`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {selectingId === session.id
                          ? <LoaderCircle className="h-3 w-3 shrink-0 animate-spin" />
                          : <Circle className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />}
                        <span className="min-w-0 truncate">
                          {session.preview.trim() || 'Untitled task'}
                        </span>
                        {session.id === currentThreadId &&
                          <span className="shrink-0 text-[10px] text-muted-foreground">(current)</span>}
                      </span>
                      <span className={`hidden text-[11px] sm:block ${status.color}`}>{status.label}</span>
                      <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground" title={time ? new Date(time * 1000).toLocaleString('ja-JP') : undefined}>
                        {timeSince(time)}
                      </span>
                    </button>
                  );
                })}
              </div>
              {!expandedGroups[group.cwd] && !debouncedSearch && group.count > RECENT_PER_GROUP && (
                <button
                  type="button"
                  className="flex items-center gap-1 px-6 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setExpandedGroups((prev) => ({ ...prev, [group.cwd]: true }))}
                >
                  <ChevronDown className="h-3 w-3" /> Show more ({group.count - RECENT_PER_GROUP})
                </button>
              )}
            </section>
          ))}

          {loading && sessions.length === 0 && (
            <p className="flex items-center justify-center gap-2 px-3 py-10 text-sm text-muted-foreground">
              <LoaderCircle className="h-4 w-4 animate-spin" /> 履歴を取得中…
            </p>
          )}
          {!loading && visibleRows.length === 0 && (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              セッションが見つかりません。検索条件を変えるか、次のページを読み込んでください。
            </p>
          )}
          {nextCursor && (
            <div className="px-3 pb-4 pt-2">
              <Button size="sm" variant="outline" disabled={loading} onClick={() => void loadPage(nextCursor, false)}>
                {loading ? '取得中…' : 'さらに読み込む'}
              </Button>
            </div>
          )}
        </div>

        {confirmSession && (
          <div className="shrink-0 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
            <p className="font-medium">元の作業ディレクトリで再開します</p>
            <p className="break-all text-muted-foreground">{confirmSession.cwd}</p>
            <p className="text-muted-foreground">現在のWorkspaceとは異なるディレクトリです。Codexが変更するファイルの場所に注意してください。</p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setConfirmSession(null)}>キャンセル</Button>
              <Button size="sm" disabled={!!selectingId || busy} onClick={() => void selectSession(confirmSession)}>
                {selectingId ? '復元中…' : 'この会話を再開'}
              </Button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="shrink-0 text-xs text-destructive">{error}</p>}
        <div className="flex shrink-0 items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>{visibleRows.length} sessions · ↑ ↓ 選択 · Enter 再開 · Esc 閉じる</span>
          {busy && <span>実行中はセッションの切り替え不可</span>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
