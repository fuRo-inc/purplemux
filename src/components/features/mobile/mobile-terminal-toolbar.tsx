import { useState } from 'react';
import { Copy, ClipboardPaste, Keyboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CTRL_TOGGLE, SHIFT_TOGGLE, TERMINAL_KEYS, toCtrlChar, type IKeyDef } from '@/lib/terminal-keys';

interface IMobileTerminalToolbarProps {
  sendStdin: (data: string) => void;
  terminalConnected: boolean;
  onCopy: () => void;
  onFocusTerminal: () => void;
}

export default function MobileTerminalToolbar({ sendStdin, terminalConnected, onCopy, onFocusTerminal }: IMobileTerminalToolbarProps) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [ctrlActive, setCtrlActive] = useState(false);
  const [shiftActive, setShiftActive] = useState(false);

  const handleKey = (key: IKeyDef) => {
    if (key.value === CTRL_TOGGLE) { setCtrlActive((value) => !value); return; }
    if (key.value === SHIFT_TOGGLE) { setShiftActive((value) => !value); return; }
    let data = key.value;
    if (ctrlActive && data.length === 1) data = toCtrlChar(data) ?? data;
    else if (shiftActive && data.length === 1) data = data.toUpperCase();
    sendStdin(data);
    setCtrlActive(false);
    setShiftActive(false);
    onFocusTerminal();
  };

  const submitPaste = () => {
    if (!terminalConnected || !pasteText) return;
    sendStdin(pasteText.replace(/\r?\n/g, '\r'));
    setPasteText('');
    setPasteOpen(false);
    onFocusTerminal();
  };

  return (
    <div className="shrink-0 border-t border-border bg-background">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Button size="sm" variant="outline" onClick={onFocusTerminal} className="gap-1">
          <Keyboard size={14} /> 入力
        </Button>
        <Button size="sm" variant="outline" onClick={onCopy} className="gap-1">
          <Copy size={14} /> コピー
        </Button>
        <Button size="sm" variant="outline" disabled={!terminalConnected} onClick={() => setPasteOpen((value) => !value)} className="gap-1">
          <ClipboardPaste size={14} /> 貼り付け
        </Button>
      </div>
      {pasteOpen && (
        <div className="flex items-end gap-2 px-3 pb-2">
          <textarea
            aria-label="貼り付けるテキスト"
            className="min-h-16 flex-1 resize-y rounded-md border bg-background p-2 text-sm"
            placeholder="長押しでペースト"
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
          />
          <Button size="sm" disabled={!terminalConnected || !pasteText} onClick={submitPaste}>送信</Button>
        </div>
      )}
      <div className="flex items-center gap-1 overflow-x-auto px-3 pb-2" style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
        {TERMINAL_KEYS.map((key) => (
          <button
            key={key.label}
            className="shrink-0 rounded-md border border-border bg-muted/50 px-2.5 py-1 text-xs font-medium text-muted-foreground active:bg-muted"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => handleKey(key)}
          >
            {key.label}
          </button>
        ))}
      </div>
    </div>
  );
}
