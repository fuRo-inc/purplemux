import { useState } from 'react';
import { Terminal, History } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Spinner from '@/components/ui/spinner';
import ClaudeCodeIcon from '@/components/icons/claude-code-icon';
import OpenAIIcon from '@/components/icons/openai-icon';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { TPanelType } from '@/types/terminal';

interface IMobileNewTabDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateTab: (panelType?: TPanelType, options?: { command?: string; resumeSessionId?: string }) => Promise<void>;
}

const MobileNewTabDialog = ({ open, onOpenChange, onCreateTab }: IMobileNewTabDialogProps) => {
  const tt = useTranslations('terminal');
  const tm = useTranslations('mobile');
  const [creatingKey, setCreatingKey] = useState<string | null>(null);

  const MENU_ITEMS = [
    { key: 'claude', type: 'claude-code' as const, icon: <ClaudeCodeIcon className="h-5 w-5" />, label: tt('claudeNewConversation'), startCommand: 'claude-new' as const },
    { key: 'codex', type: 'codex-chat' as const, icon: <OpenAIIcon className="h-5 w-5" />, label: tt('codexNewConversation') },
    { key: 'agent-sessions', type: 'agent-sessions' as const, icon: <History className="h-5 w-5 text-muted-foreground" />, label: tt('sessionList') },
    { key: 'terminal', type: 'terminal' as const, icon: <Terminal className="h-5 w-5 text-muted-foreground" />, label: 'Terminal' },
  ] as const;

  const handleOpenList = async (item: (typeof MENU_ITEMS)[number]) => {
    setCreatingKey(item.key);
    await onCreateTab(item.type);
    setCreatingKey(null);
    onOpenChange(false);
  };

  const handleStartNew = async (item: Extract<(typeof MENU_ITEMS)[number], { startCommand: 'claude-new' | 'codex-new' }>) => {
    const key = `${item.key}-new`;
    setCreatingKey(key);
    await onCreateTab(item.type, { command: item.startCommand });
    setCreatingKey(null);
    onOpenChange(false);
  };

  const handleSelect = async (item: (typeof MENU_ITEMS)[number]) => {
    if ('startCommand' in item) {
      await handleStartNew(item);
      return;
    }
    await handleOpenList(item);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-xs gap-2 rounded-xl p-4">
        <DialogHeader>
          <DialogTitle className="text-sm font-medium">{tm('newTab')}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {MENU_ITEMS.map((item) => (
            <div
              key={item.key}
              className="relative aspect-square rounded-lg border border-border bg-background text-foreground transition-colors"
            >
              <button
                className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-lg transition-colors active:bg-accent disabled:pointer-events-none disabled:opacity-50"
                disabled={creatingKey !== null}
                onClick={() => handleSelect(item)}
              >
                <span className="flex h-5 w-5 items-center justify-center">
                  {creatingKey === `${item.key}-new` ? <Spinner className="h-4 w-4" /> : item.icon}
                </span>
                <span className="line-clamp-2 max-w-full px-1 text-center text-xs leading-tight">
                  {item.label}
                </span>
              </button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default MobileNewTabDialog;
