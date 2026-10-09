import { useState, useCallback, useRef, useEffect, type ChangeEvent } from 'react';
import { SendHorizontal, Copy, ClipboardPaste } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { CTRL_TOGGLE, SHIFT_TOGGLE, TERMINAL_KEYS, toCtrlChar, type IKeyDef } from '@/lib/terminal-keys';

interface IMobileTerminalToolbarProps {
  sendStdin: (data: string) => void;
  terminalConnected: boolean;
  onCopy: () => void;
  getTerminalText: () => string;
}

const LINE_HEIGHT = 20;
const PADDING_Y = 16;
const MAX_ROWS = 3;
const NERD_FONT_STYLE = { fontFamily: 'MesloLGLDZ, monospace' } as const;

const KEYS = TERMINAL_KEYS;

const MobileTerminalToolbar = ({ sendStdin, terminalConnected, onCopy, getTerminalText }: IMobileTerminalToolbarProps) => {
  const t = useTranslations('mobile');
  const [value, setValue] = useState('');
  const [ctrlActive, setCtrlActive] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyText, setCopyText] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [shiftActive, setShiftActive] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const maxHeight = LINE_HEIGHT * MAX_ROWS + PADDING_Y;
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  const handleSend = useCallback(() => {
    if (!terminalConnected) return;
    if (value) sendStdin(value);
    sendStdin('\r');
    setValue('');
  }, [value, sendStdin, terminalConnected]);

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      if (ctrlActive && newValue.length === value.length + 1) {
        const ctrl = toCtrlChar(newValue[newValue.length - 1]);
        if (ctrl) {
          sendStdin(ctrl);
          setCtrlActive(false);
          return;
        }
      }
      if (shiftActive && newValue.length === value.length + 1) {
        const typed = newValue[newValue.length - 1];
        const upper = typed.toUpperCase();
        if (upper !== typed) {
          setValue(value + upper);
          setShiftActive(false);
          return;
        }
      }
      setValue(newValue);
    },
    [ctrlActive, shiftActive, value, sendStdin],
  );

  const handleKeyButton = useCallback(
    (key: IKeyDef) => {
      if (key.value === CTRL_TOGGLE) {
        setCtrlActive((prev) => !prev);
        return;
      }
      if (key.value === SHIFT_TOGGLE) {
        setShiftActive((prev) => !prev);
        return;
      }
      sendStdin(key.value);
      if (ctrlActive) setCtrlActive(false);
      if (shiftActive) setShiftActive(false);
    },
    [ctrlActive, shiftActive, sendStdin],
  );

  const submitPaste = () => {
    if (!terminalConnected || !pasteText) return;
    sendStdin(pasteText.replace(/\r?\n/g, '\r'));
    setPasteText('');
    setPasteOpen(false);
  };

  return (
    <div className="shrink-0 border-t border-border bg-background">
      <div className="flex items-center gap-2 px-3 pt-2">
        <Button variant="outline" size="sm" onClick={onCopy} className="gap-1">
          <Copy size={14} /> 表示をコピー
        </Button>
        <Button variant="outline" size="sm" onClick={() => { setCopyText(getTerminalText()); setCopyOpen((prev) => !prev); }} className="gap-1">
          範囲コピー
        </Button>
        <Button variant="outline" size="sm" onClick={() => setPasteOpen((prev) => !prev)} className="gap-1" disabled={!terminalConnected}>
          <ClipboardPaste size={14} /> 貼り付け
        </Button>
      </div>
      {copyOpen && (
        <div className="px-3 pt-2">
          <p className="mb-1 text-xs text-muted-foreground">テキストを長押しし、必要な範囲を選択してOS標準の「コピー」を使用してください。</p>
          <textarea readOnly aria-label="ターミナル出力のコピー用テキスト" className="h-32 w-full resize-y rounded-md border bg-background p-2 font-mono text-xs" value={copyText} />
        </div>
      )}
      {pasteOpen && (
        <div className="flex items-end gap-2 px-3 pt-2">
          <textarea
            aria-label="貼り付けるテキスト"
            className="min-h-16 flex-1 resize-y rounded-md border bg-background p-2 text-sm"
            placeholder="ここを長押しして「ペースト」を選択"
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
          />
          <Button size="sm" disabled={!terminalConnected || !pasteText} onClick={submitPaste}>送信</Button>
        </div>
      )}
      <div className="flex items-end gap-2 px-3 py-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          placeholder={ctrlActive ? 'Ctrl + ...' : shiftActive ? 'Shift + ...' : t('commandPlaceholder')}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          rows={1}
          className={cn(
            'flex-1 resize-none rounded-md border px-3 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground',
            ctrlActive || shiftActive
              ? 'border-claude-active bg-claude-active/10'
              : 'border-border bg-black/5 focus:border-ring dark:bg-white/5',
          )}
          style={{
            lineHeight: `${LINE_HEIGHT}px`,
            maxHeight: `${LINE_HEIGHT * MAX_ROWS + PADDING_Y}px`,
            overflowY: 'auto',
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-foreground',
            value.trim() && 'text-claude-active',
          )}
          onClick={handleSend}
          aria-label={t('send')}
        >
          <SendHorizontal size={16} />
        </Button>
      </div>

      <div
        className="flex items-center gap-1 overflow-x-auto px-3 pb-2"
        style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}
      >
        {KEYS.map((key) => (
          <button
            key={key.label}
            className={cn(
              'shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
              (key.value === CTRL_TOGGLE && ctrlActive) || (key.value === SHIFT_TOGGLE && shiftActive)
                ? 'border-claude-active bg-claude-active/20 text-claude-active'
                : 'border-border bg-muted/50 text-muted-foreground active:bg-muted',
            )}
            onClick={() => handleKeyButton(key)}
          >
            <span
              className={cn('inline-block', key.rotate && 'rotate-90')}
              style={key.nerd ? NERD_FONT_STYLE : undefined}
            >
              {key.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default MobileTerminalToolbar;
