import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleStop, FileDiff, LoaderCircle, MessageSquare, Plus, SendHorizontal, Terminal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import AssistantMessageItem from '@/components/features/timeline/assistant-message-item';
import UserMessageItem from '@/components/features/timeline/user-message-item';
import type { CodexGuiState, CodexGuiItem } from '@/lib/codex-app-gui';

interface ICodexAppChatPanelProps {
  workspaceId: string;
  tabId: string;
  mobile?: boolean;
}

const DEFAULT_STATE: CodexGuiState = {
  ready: false, running: false, busy: false, threadId: null, turnId: null,
  model: null, effort: null, models: [], items: [], approvals: [], error: null,
};

export default function CodexAppChatPanel({ workspaceId, tabId, mobile = false }: ICodexAppChatPanelProps) {
  const [state, setState] = useState<CodexGuiState>(DEFAULT_STATE);
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedEffort, setSelectedEffort] = useState('');
  const [actionError, setActionError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const hadModelRef = useRef(false);

  useEffect(() => {
    setState(DEFAULT_STATE);
    setConnected(false);
    hadModelRef.current = false;
    const query = new URLSearchParams({ workspaceId, tabId });
    const events = new EventSource('/api/codex-app/events?' + query.toString());
    events.onmessage = (event: MessageEvent<string>) => {
      try {
        const received = JSON.parse(event.data) as CodexGuiState;
        setState(received);
        setConnected(true);
        setActionError('');
      } catch {
        setActionError('Codexの通知を処理できませんでした');
      }
    };
    events.onerror = () => {
      setConnected(false);
      setActionError('Codex App Serverに接続できません。ホストのCodex認証とPurplemuxの起動ログを確認してください。');
    };
    return () => events.close();
  }, [workspaceId, tabId]);

  useEffect(() => {
    if (state.models.length === 0 || hadModelRef.current) return;
    const fallback = state.models.find((m) => m.isDefault) || state.models[0];
    setSelectedModel(state.model || fallback.model);
    setSelectedEffort(state.effort || fallback.defaultReasoningEffort);
    hadModelRef.current = true;
  }, [state.models, state.model, state.effort]);

  const model = useMemo(() => state.models.find((m) => m.model === selectedModel), [state.models, selectedModel]);
  const effortOptions = model?.supportedReasoningEfforts ?? [];
  const isNearBottomRef = useRef(true);
  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    isNearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 150;
  }, []);

  useEffect(() => {
    if (isNearBottomRef.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [state.items, state.busy, state.approvals]);

  const request = useCallback(async (
    action: 'send' | 'new-thread' | 'interrupt' | 'settings' | 'approve',
    options: Record<string, unknown> = {},
  ) => {
    setActionError('');
    const result = await fetch('/api/codex-app/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, tabId, action, ...options }),
    });
    const body = await result.json() as CodexGuiState & { error?: string };
    if (!result.ok) throw new Error(body.error || 'Codex操作に失敗しました');
    setState(body);
    return body;
  }, [workspaceId, tabId]);

  const changeModel = (next: string) => {
    const model = state.models.find((m) => m.model === next);
    if (!model) return;
    setSelectedModel(next);
    setSelectedEffort(model.defaultReasoningEffort);
    void request('settings', { model: next, effort: model.defaultReasoningEffort })
      .catch((error: Error) => setActionError(error.message));
  };
  const changeEffort = (next: string) => {
    setSelectedEffort(next);
    void request('settings', { effort: next })
      .catch((error: Error) => setActionError(error.message));
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || submitting || state.busy || !connected || !state.ready) return;
    setSubmitting(true);
    setDraft('');
    isNearBottomRef.current = true;
    try {
      await request('send', {
        text,
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(selectedEffort ? { effort: selectedEffort } : {}),
      });
    } catch (error) {
      setDraft((current) => text + (current ? '\n' + current : ''));
      setActionError(error instanceof Error ? error.message : '送信に失敗しました');
    } finally {
      setSubmitting(false);
    }
  };

  const run = async (action: 'interrupt' | 'new-thread') => {
    try {
      await request(action);
      if (action === 'new-thread') {
        setDraft('');
        isNearBottomRef.current = true;
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '操作に失敗しました');
    }
  };

  const respondApproval = async (requestId: string | number, decision: 'accept' | 'decline') => {
    try {
      await request('approve', { requestId, decision });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '承認への応答に失敗しました');
    }
  };

  const renderItem = (item: CodexGuiItem) => {
    if (item.type === 'user') {
      return <UserMessageItem entry={{ id: item.id, type: 'user-message', timestamp: 0, text: item.text }} />;
    }
    if (item.type === 'assistant') {
      return <div className="space-y-1">
        <AssistantMessageItem entry={{ id: item.id, type: 'assistant-message', timestamp: 0, markdown: item.text }} />
        {item.status === 'streaming' && <LoaderCircle className="h-3 w-3 animate-spin text-muted-foreground" />}
      </div>;
    }
    if (item.type === 'command') {
      return <details className="rounded-lg border bg-muted/40 px-3 py-2 text-xs">
        <summary className="flex cursor-pointer items-center gap-2">
          <Terminal className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono">{item.title || 'Command'}</span>
          <span className="text-muted-foreground">{item.status}</span>
        </summary>
        {item.text && <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono">{item.text}</pre>}
      </details>;
    }
    if (item.type === 'file-change') {
      return <div className="flex items-center gap-2 rounded-lg border p-3 text-xs">
        <FileDiff className="h-4 w-4" /> {item.title || 'ファイル変更'} — {item.status || '処理中'}
      </div>;
    }
    return <div className="whitespace-pre-wrap rounded-lg border p-3 text-xs text-muted-foreground">{item.text}</div>;
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <MessageSquare className="h-4 w-4" />
        <span className="text-xs font-semibold">Codex Chat</span>
        <span className="mr-auto flex items-center gap-1 text-[11px] text-muted-foreground">
          {state.busy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : connected ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
          {state.busy ? '実行中' : connected ? '接続済み' : '接続待機中'}
        </span>
        <Button size="xs" variant="outline" disabled={!connected || state.busy} onClick={() => void run('new-thread')}>
          <Plus className="h-3 w-3" /> {!mobile && '新しい会話'}
        </Button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-xs sm:flex-none">
          <span className="shrink-0 text-muted-foreground">モデル</span>
          <select
            aria-label="Codexモデル"
            className="h-8 min-w-0 max-w-56 flex-1 rounded-md border bg-background px-2 text-xs"
            value={selectedModel}
            onChange={(event) => changeModel(event.target.value)}
            disabled={!connected || state.models.length === 0 || state.busy}
          >
            {state.models.length === 0 && <option value="">取得中…</option>}
            {state.models.map((option) => (
              <option key={option.id || option.model} value={option.model}>{option.displayName}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Thinking</span>
          <select
            aria-label="推論強度"
            className="h-8 max-w-32 rounded-md border bg-background px-2 text-xs"
            value={selectedEffort}
            onChange={(event) => changeEffort(event.target.value)}
            disabled={!connected || effortOptions.length === 0 || state.busy}
          >
            {effortOptions.length === 0 && <option value="">Default</option>}
            {effortOptions.map((option) => (
              <option key={option.reasoningEffort} value={option.reasoningEffort}>{option.reasoningEffort}</option>
            ))}
          </select>
        </label>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-5" style={{ overscrollBehavior: 'contain' }}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          {state.items.length === 0 && (
            <div className="space-y-2 py-12 text-center">
              <MessageSquare className="mx-auto h-7 w-7 text-muted-foreground/70" />
              <p className="text-sm font-medium">Codexへ指示を入力してください</p>
              <p className="text-xs text-muted-foreground">実行は選択したWorkspaceのホストで行われます。Terminalを開く必要はありません。</p>
            </div>
          )}
          {state.items.map((item) => <div key={item.id}>{renderItem(item)}</div>)}
          {state.busy && <p className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="h-3.5 w-3.5 animate-spin" /> 作業状況を受信しています…</p>}
          {state.approvals.map((approval) => (
            <div key={String(approval.requestId)} className="space-y-3 rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 text-sm">
              <div className="font-semibold">Codexが操作の承認を要求しています</div>
              <p className="text-xs text-muted-foreground">{approval.reason}</p>
              <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-xs">{approval.command}</pre>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => void respondApproval(approval.requestId, 'decline')}>拒否</Button>
                <Button size="sm" onClick={() => void respondApproval(approval.requestId, 'accept')}>今回だけ許可</Button>
              </div>
            </div>
          ))}
          {(actionError || state.error) && (
            <div role="alert" className="rounded-md border border-destructive/30 px-3 py-2 text-xs text-destructive">{actionError || state.error}</div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="shrink-0 border-t bg-background p-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            aria-label="Codexへ指示"
            className="max-h-36 min-h-12 flex-1 resize-y rounded-lg border bg-background px-3 py-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder={connected ? 'Codexへ指示を入力…（Shift+Enterで改行）' : 'Codex App Serverへ接続しています…'}
            value={draft}
            rows={mobile ? 2 : 1}
            disabled={!connected || !state.ready}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {state.busy ? (
            <Button size="sm" className="h-11" variant="outline" onClick={() => void run('interrupt')} title="処理を停止">
              <CircleStop className="h-4 w-4" />
            </Button>
          ) : (
            <Button size="sm" className="h-11" disabled={!draft.trim() || !state.ready || submitting} onClick={() => void send()} title="送信">
              {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
