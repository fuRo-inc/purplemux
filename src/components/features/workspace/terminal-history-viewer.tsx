import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Copy, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { copyToClipboard } from '@/lib/clipboard';

interface ITerminalHistoryViewerProps {
  content: string | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onReload: () => void;
}

/**
 * Browses tmux-owned scrollback shared by desktop and mobile terminals.
 * Normal DOM text allows long-range selection on desktop and touch browsers.
 */
export default function TerminalHistoryViewer({
  content,
  loading,
  error,
  onClose,
  onReload,
}: ITerminalHistoryViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selectedText, setSelectedText] = useState('');

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && content !== null) {
      // Opening from the live terminal should initially show the newest lines.
      requestAnimationFrame(() => {
        if (scrollRef.current === scroller) {
          scroller.scrollTop = scroller.scrollHeight;
          scroller.focus({ preventScroll: true });
        }
      });
    }
  }, [content]);

  useEffect(() => {
    const updateSelection = () => {
      const selection = window.getSelection();
      const scroller = scrollRef.current;
      if (selection && scroller &&
          selection.anchorNode && selection.focusNode &&
          scroller.contains(selection.anchorNode) &&
          scroller.contains(selection.focusNode)) {
        setSelectedText(selection.toString());
      } else {
        setSelectedText('');
      }
    };
    document.addEventListener('selectionchange', updateSelection);
    return () => document.removeEventListener('selectionchange', updateSelection);
  }, []);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onEscape, true);
    return () => document.removeEventListener('keydown', onEscape, true);
  }, [onClose]);

  const copySelection = useCallback(async () => {
    if (!selectedText) return;
    if (await copyToClipboard(selectedText)) toast.success('選択範囲をコピーしました');
    else toast.error('コピーできませんでした。OSの選択メニューをお試しください。');
  }, [selectedText]);

  return (
    <div className="absolute inset-0 z-40 flex min-h-0 flex-col bg-[#1e2029] text-white">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/15 px-2 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">ターミナル履歴</span>
        <Button size="sm" variant="outline" onClick={onReload} disabled={loading} aria-label="履歴を更新" className="h-8 border-white/25 text-white">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="outline" onClick={() => void copySelection()} disabled={!selectedText} className="h-8 gap-1 border-white/25 text-white">
          <Copy className="h-3.5 w-3.5" /> コピー
        </Button>
        <Button size="sm" onClick={onClose} className="h-8 gap-1">
          <ArrowDownToLine className="h-3.5 w-3.5" /> ライブへ
        </Button>
      </div>
      {loading && <p className="px-3 py-3 text-sm text-white/75">tmuxの履歴を取得しています…</p>}
      {error && (
        <div className="space-y-2 px-3 py-3 text-sm">
          <p>履歴の取得に失敗しました: {error}</p>
          <Button size="sm" variant="outline" onClick={onReload}>再試行</Button>
        </div>
      )}
      {content !== null && !loading && (
        <div
          ref={scrollRef}
          tabIndex={0}
          aria-label="ターミナル履歴（テキストをドラッグしてコピー）"
          data-mobile-terminal-scroll
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 py-1"
          style={{ WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y', userSelect: 'text', WebkitUserSelect: 'text' }}
        >
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.45] select-text" style={{ userSelect: 'text', WebkitUserSelect: 'text' }}>
            {content || '（保存された履歴がありません）'}
          </pre>
        </div>
      )}
      <div className="shrink-0 border-t border-white/10 px-3 py-1 text-[11px] text-white/60">
        ホイール／スワイプで移動し、ドラッグ／長押しで選択できます。
      </div>
    </div>
  );
}
