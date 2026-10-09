import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { ITerminalThemeColors } from "@/lib/terminal-themes";
import { createMultilineUrlLinkProvider } from "@/lib/multiline-url-link-provider";
import { copyToClipboard } from "@/lib/clipboard";
import { DEFAULT_LINE_HEIGHT } from "@/lib/terminal-line-height";
import isElectron from "@/hooks/use-is-electron";

interface IUseTerminalOptions {
  theme?: ITerminalThemeColors;
  fontSize?: number;
  lineHeight?: number;
  onInput?: (data: string) => void;
  onHistoryRequested?: () => void;
  onResize?: (cols: number, rows: number) => void;
  onTitleChange?: (title: string) => void;
  customKeyEventHandler?: (event: KeyboardEvent) => boolean;
}

const COPY_TOAST_ID = 'terminal-copy';

const DEFAULT_FONT_SIZE = 12;

// Bound browser-side terminal output during commands such as cat on large logs.
// xterm.write() is asynchronous and has its own buffer, so feed one chunk only
// after its callback to avoid unbounded buffering on both sides.
const MAX_PENDING_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_CHUNK_BYTES = 64 * 1024;
const OUTPUT_TRUNCATED_NOTICE = '\r\n\x1b[33m[Purplemux] Excess terminal output skipped to keep the page responsive. Use less/tail for large logs.\x1b[0m\r\n';

const ALLOWED_LINK_PROTOCOLS = ['http:', 'https:'];

const openExternalUrl = (uri: string) => {
  try {
    const { protocol } = new URL(uri);
    if (!ALLOWED_LINK_PROTOCOLS.includes(protocol)) return;
  } catch {
    return;
  }
  if (isElectron) {
    (window as unknown as Record<string, { openExternal: (url: string) => void }>).electronAPI.openExternal(uri);
  } else {
    window.open(uri, '_blank');
  }
};

const FONT_FAMILY =
  "'MesloLGLDZ', 'Apple SD Gothic Neo', 'Pretendard', 'Menlo', 'Monaco', 'Courier New', monospace";

let fontLoadPromise: Promise<void> | null = null;
const loadFonts = () => {
  fontLoadPromise ??= (async () => {
    const fontsToLoad = [
      new FontFace('MesloLGLDZ', "url('/fonts/MesloLGLDZNerdFont-Regular.woff2')", {
        weight: '400',
        style: 'normal',
      }),
      new FontFace('MesloLGLDZ', "url('/fonts/MesloLGLDZNerdFont-Bold.woff2')", {
        weight: '700',
        style: 'normal',
      }),
    ];
    await Promise.all(
      fontsToLoad.map(async (font) => {
        await font.load();
        document.fonts.add(font);
      }),
    );
  })();
  return fontLoadPromise;
};

const useTerminal = ({ theme, fontSize = DEFAULT_FONT_SIZE, lineHeight = DEFAULT_LINE_HEIGHT, onInput, onResize, onTitleChange, customKeyEventHandler, onHistoryRequested }: IUseTerminalOptions = {}) => {
  const [containerNode, setContainerNode] = useState<HTMLDivElement | null>(null);
  const terminalRef = useCallback((node: HTMLDivElement | null) => {
    setContainerNode(node);
  }, []);
  const terminalInstance = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const writeQueueRef = useRef<Uint8Array[]>([]);
  const pendingBytesRef = useRef(0);
  const isWritingRef = useRef(false);
  const writeGenerationRef = useRef(0);
  const [isReady, setIsReady] = useState(false);
  const t = useTranslations('terminal');

  const callbacksRef = useRef({ theme, fontSize, lineHeight, onInput, onResize, onTitleChange, customKeyEventHandler, onHistoryRequested, t });

  useEffect(() => {
    callbacksRef.current = { theme, fontSize, lineHeight, onInput, onResize, onTitleChange, customKeyEventHandler, onHistoryRequested, t };
  }, [theme, fontSize, lineHeight, onInput, onResize, onTitleChange, customKeyEventHandler, onHistoryRequested, t]);

  const drainWriteQueue = useCallback(() => {
    if (isWritingRef.current) return;
    const terminal = terminalInstance.current;
    if (!terminal) return;
    isWritingRef.current = true;
    const generation = writeGenerationRef.current;

    const step = () => {
      if (writeGenerationRef.current !== generation || terminalInstance.current !== terminal) {
        isWritingRef.current = false;
        return;
      }
      const chunk = writeQueueRef.current.shift();
      if (!chunk) {
        isWritingRef.current = false;
        return;
      }
      pendingBytesRef.current -= chunk.byteLength;
      // The callback fires after the chunk has been processed by xterm.
      terminal.write(chunk, () => {
        if (writeGenerationRef.current !== generation) return;
        // Yield to input, layout and paint even under sustained stdout.
        setTimeout(step, 0);
      });
    };
    step();
  }, []);

  const write = useCallback((data: Uint8Array) => {
    const terminal = terminalInstance.current;
    if (!terminal || data.byteLength === 0) return;
    // Keep the latest output, discarding an old backlog rather than freezing
    // the browser. Fragmented ANSI sequences may be split at this boundary,
    // so reset parser state when truncating.
    if (pendingBytesRef.current + data.byteLength > MAX_PENDING_OUTPUT_BYTES) {
      writeGenerationRef.current++;
      writeQueueRef.current = [];
      pendingBytesRef.current = 0;
      isWritingRef.current = false;
      terminal.reset();
      const notice = new TextEncoder().encode(OUTPUT_TRUNCATED_NOTICE);
      writeQueueRef.current.push(notice);
      pendingBytesRef.current += notice.byteLength;
    }
    for (let offset = 0; offset < data.byteLength; offset += MAX_WRITE_CHUNK_BYTES) {
      const chunk = data.subarray(offset, Math.min(offset + MAX_WRITE_CHUNK_BYTES, data.byteLength));
      writeQueueRef.current.push(chunk);
      pendingBytesRef.current += chunk.byteLength;
    }
    // Also handle a single exceptionally large websocket frame.
    while (pendingBytesRef.current > MAX_PENDING_OUTPUT_BYTES && writeQueueRef.current.length > 1) {
      const dropped = writeQueueRef.current.splice(1, 1)[0];
      pendingBytesRef.current -= dropped.byteLength;
    }
    drainWriteQueue();
  }, [drainWriteQueue]);

  const clear = useCallback(() => {
    terminalInstance.current?.clear();
  }, []);

  const getBufferText = useCallback((): string => {
    const term = terminalInstance.current;
    if (!term) return '';
    const buf = term.buffer.active;
    const start = Math.max(0, buf.length - term.rows);
    const lines: string[] = [];
    for (let y = start; y < buf.length; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n');
  }, []);

  const copyTerminalText = useCallback(async (): Promise<boolean> => {
    const terminal = terminalInstance.current;
    if (!terminal) return false;
    const text = terminal.hasSelection() ? terminal.getSelection() : getBufferText();
    return copyToClipboard(text);
  }, [getBufferText]);

  const fit = useCallback((): { cols: number; rows: number } => {
    const fitAddon = fitAddonRef.current;
    const terminal = terminalInstance.current;
    if (!fitAddon || !terminal) return { cols: 80, rows: 24 };

    fitAddon.fit();
    return { cols: terminal.cols, rows: terminal.rows };
  }, []);

  const reset = useCallback(() => {
    writeGenerationRef.current++;
    writeQueueRef.current = [];
    pendingBytesRef.current = 0;
    isWritingRef.current = false;
    terminalInstance.current?.reset();
  }, []);

  const focus = useCallback(() => {
    terminalInstance.current?.focus();
  }, []);

  useEffect(() => {
    if (!containerNode) return;

    let disposed = false;
    let resizeRaf = 0;
    let reFitTimer = 0;
    let resizeObserver: ResizeObserver | null = null;
    let cleanupTouch: (() => void) | null = null;
    let cleanupKeyboardViewport: (() => void) | null = null;
    let cleanupContextMenu: (() => void) | null = null;
    let cleanupDesktopHistoryWheel: (() => void) | null = null;

    loadFonts().then(() => {
      if (disposed) return;

      const terminal = new Terminal({
        fontFamily: FONT_FAMILY,
        fontWeight: "400",
        fontWeightBold: "700",
        fontSize: callbacksRef.current.fontSize,
        lineHeight: callbacksRef.current.lineHeight,
        letterSpacing: 0,
        scrollback: 5000,
        cursorBlink: false,
        cursorStyle: "bar",
        allowTransparency: false,
        allowProposedApi: true,
        macOptionIsMeta: true,
        theme: callbacksRef.current.theme,
        linkHandler: {
          activate: (_event, text) => openExternalUrl(text),
          allowNonHttpProtocols: false,
        },
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.registerLinkProvider(createMultilineUrlLinkProvider(terminal, openExternalUrl));
      terminal.loadAddon(new WebLinksAddon((_event, uri) => openExternalUrl(uri)));

      const unicode11Addon = new Unicode11Addon();
      terminal.loadAddon(unicode11Addon);
      terminal.unicode.activeVersion = "11";

      const clipboardProvider: IClipboardProvider = {
        // OSC 52 read는 터미널 앱이 브라우저 클립보드를 훔쳐볼 수 있어 거부한다
        readText: () => '',
        // Ignore OSC 52 clipboard writes from tmux or remote apps.
        // Only explicit Ctrl+C / Cmd+C should copy selected terminal text.
        writeText: async () => {},
      };
      terminal.loadAddon(new ClipboardAddon(undefined, clipboardProvider));

      terminal.open(containerNode);
      // xterm only knows the screen that tmux has rendered. When the user
      // wheels upward past its own top, request tmux-owned scrollback.
      // The regular wheel handler is untouched until the boundary is reached.
      let upwardWheelAtTop = 0;
      let lastWheelTime = 0;
      let lastHistoryOpenAt = 0;
      const onHistoryWheel = (event: WheelEvent) => {
        if (!callbacksRef.current.onHistoryRequested || event.ctrlKey || event.metaKey ||
            event.deltaY >= 0 || terminal.buffer.active.viewportY > 0) {
          upwardWheelAtTop = 0;
          return;
        }
        if (event.timeStamp - lastWheelTime > 650) upwardWheelAtTop = 0;
        lastWheelTime = event.timeStamp;
        const deltaPixels = Math.abs(event.deltaY) * (event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? 150 : 1);
        upwardWheelAtTop += deltaPixels;
        if (upwardWheelAtTop < 45 || event.timeStamp - lastHistoryOpenAt < 1000) return;
        upwardWheelAtTop = 0;
        lastHistoryOpenAt = event.timeStamp;
        event.preventDefault();
        callbacksRef.current.onHistoryRequested();
      };
      containerNode.addEventListener('wheel', onHistoryWheel, { capture: true, passive: false });
      cleanupDesktopHistoryWheel = () => {
        containerNode.removeEventListener('wheel', onHistoryWheel, true);
      };


      // Custom menu: xterm selection is not a DOM selection, so Chrome's
      // native Copy item is disabled. Handle copy from xterm explicitly.
      let menu: HTMLDivElement | null = null;
      let pastePrompt: HTMLTextAreaElement | null = null;
      const closeMenu = () => { menu?.remove(); menu = null; };
      const closePastePrompt = () => { pastePrompt?.remove(); pastePrompt = null; };
      const menuButton = (label: string, shortcut: string, handler: () => void, disabled = false) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.disabled = disabled;
        button.style.cssText = 'display:flex;width:100%;justify-content:space-between;gap:30px;align-items:center;padding:9px 14px;border:0;background:transparent;color:inherit;text-align:left;font:13px sans-serif;cursor:pointer;';
        if (disabled) button.style.opacity = '.45';
        button.onmouseenter = () => { if (!disabled) button.style.background = '#3b3b3b'; };
        button.onmouseleave = () => { button.style.background = 'transparent'; };
        const text = document.createElement('span');
        text.textContent = label;
        const hint = document.createElement('span');
        hint.textContent = shortcut;
        hint.style.cssText = 'color:#aaa;font-size:12px;';
        button.append(text, hint);
        button.onclick = (event) => { event.stopPropagation(); closeMenu(); handler(); };
        return button;
      };
      const showPastePrompt = () => {
        closePastePrompt();
        const textarea = document.createElement('textarea');
        pastePrompt = textarea;
        textarea.placeholder = 'Ctrl+V で貼り付け（Esc で閉じる）';
        textarea.setAttribute('aria-label', 'Paste into terminal');
        textarea.style.cssText = 'position:fixed;z-index:2147483647;top:40%;left:35%;width:30%;min-width:260px;min-height:80px;padding:12px;background:#202024;color:white;border:1px solid #777;border-radius:6px;font:14px sans-serif;';
        textarea.addEventListener('paste', (event) => {
          const value = event.clipboardData?.getData('text/plain');
          if (value) {
            event.preventDefault();
            callbacksRef.current.onInput?.(value.replace(/\r?\n/g, '\r'));
            closePastePrompt();
            terminal.focus();
          }
        });
        textarea.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') { event.preventDefault(); closePastePrompt(); terminal.focus(); }
        });
        document.body.appendChild(textarea);
        textarea.focus();
      };
      const pasteClipboard = async () => {
        try {
          if (!navigator.clipboard?.readText) { showPastePrompt(); return; }
          const text = await navigator.clipboard.readText();
          if (text) callbacksRef.current.onInput?.(text.replace(/\r?\n/g, '\r'));
          terminal.focus();
        } catch {
          showPastePrompt();
        }
      };
      const showMenu = (event: MouseEvent) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeMenu();
        const div = document.createElement('div');
        menu = div;
        div.setAttribute('role', 'menu');
        div.style.cssText = 'position:fixed;z-index:2147483647;min-width:250px;padding:5px 0;border:1px solid #494949;border-radius:9px;background:#252525;color:#f5f5f5;box-shadow:0 12px 30px #0008;';
        const selection = terminal.getSelection();
        div.append(
          menuButton('コピー', 'Ctrl+Shift+C', () => { void copyToClipboard(selection); terminal.focus(); }, !selection),
          menuButton('割り込み (SIGINT)', 'Ctrl+C', () => { callbacksRef.current.onInput?.('\x03'); terminal.focus(); }),
          menuButton('貼り付け', 'Ctrl+V', () => { void pasteClipboard(); }),
          menuButton('すべて選択', 'Ctrl+A', () => { terminal.selectAll(); terminal.focus(); }),
          ...(callbacksRef.current.onHistoryRequested ? [menuButton('履歴を表示', '', () => callbacksRef.current.onHistoryRequested?.())] : []),
        );
        document.body.appendChild(div);
        const rect = div.getBoundingClientRect();
        div.style.left = Math.max(0, Math.min(event.clientX, window.innerWidth - rect.width - 4)) + 'px';
        div.style.top = Math.max(0, Math.min(event.clientY, window.innerHeight - rect.height - 4)) + 'px';
      };
      const stopRightMouse = (event: MouseEvent) => {
        if (event.button === 2) event.stopImmediatePropagation();
      };
      const onDocumentPointerDown = (event: PointerEvent) => {
        if (menu && !menu.contains(event.target as Node)) closeMenu();
      };
      const onDocumentKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') closeMenu();
      };
      containerNode.addEventListener('mousedown', stopRightMouse, true);
      containerNode.addEventListener('mouseup', stopRightMouse, true);
      containerNode.addEventListener('contextmenu', showMenu, true);
      document.addEventListener('pointerdown', onDocumentPointerDown, true);
      document.addEventListener('keydown', onDocumentKeyDown, true);
      cleanupContextMenu = () => {
        closeMenu();
        closePastePrompt();
        containerNode.removeEventListener('mousedown', stopRightMouse, true);
        containerNode.removeEventListener('mouseup', stopRightMouse, true);
        containerNode.removeEventListener('contextmenu', showMenu, true);
        document.removeEventListener('pointerdown', onDocumentPointerDown, true);
        document.removeEventListener('keydown', onDocumentKeyDown, true);
      };

      terminalInstance.current = terminal;
      fitAddonRef.current = fitAddon;

      terminal.onData((data) => {
        if (/^\x1b\[[\?>]?[\d;]*[cnR]$/.test(data)) return;
        callbacksRef.current.onInput?.(data);
      });

      terminal.onTitleChange((title) => {
        callbacksRef.current.onTitleChange?.(title);
      });

      terminal.attachCustomKeyEventHandler((event) => {
        // IME 조합 단계의 keydown(keyCode 229)은 가로채지 않는다. 같은 키가 조합용으로 한 번,
        // 실제 키로 한 번 들어오므로 실제 키만 처리해 중복 전송(단어 2칸 이동 등)을 막는다.
        if (event.isComposing || event.keyCode === 229) return true;
        // Terminal convention: Ctrl+C always interrupts the foreground
        // process (including through SSH/tmux). Ctrl+Shift+C copies an xterm
        // selection; Cmd+C remains copy on macOS. The right-click copy action
        // continues to work on Windows and mobile.
        const key = event.key.toLowerCase();
        if (event.type === 'keydown' && event.ctrlKey && !event.altKey && !event.metaKey && key === 'c') {
          event.preventDefault();
          if (event.shiftKey) {
            if (terminal.hasSelection()) void copyToClipboard(terminal.getSelection());
          } else {
            callbacksRef.current.onInput?.('\x03');
          }
          return false;
        }
        if (event.type === 'keydown' && event.metaKey && !event.ctrlKey && key === 'c') {
          event.preventDefault();
          if (terminal.hasSelection()) void copyToClipboard(terminal.getSelection());
          return false;
        }
        // Ctrl+V / Cmd+V use native browser paste into xterm's hidden textarea.
        // Keeping the paste event native avoids asynchronous clipboard permission prompts.
        if (event.type === 'keydown' && ((event.ctrlKey && !event.shiftKey && key === 'v') ||
          (event.ctrlKey && event.shiftKey && key === 'v') || (event.metaKey && key === 'v'))) {
          return true;
        }
        // macOptionIsMeta가 이중 ESC를 보내는 키만 직접 매핑
        if (event.altKey && event.type === 'keydown') {
          const seq: Record<string, string> = {
            ArrowLeft: '\x1bb',
            ArrowRight: '\x1bf',
            Backspace: '\x1b\x7f',
          };
          if (seq[event.code]) {
            // preventDefault로 hidden textarea의 네이티브 단어 단위 커서 이동을 막는다.
            // 막지 않으면 IME 조합 중 캐럿이 textarea 앞으로 이동해 xterm CompositionHelper의
            // "조합은 항상 끝에서 일어난다" 가정이 깨지고 이전 입력이 반복 전송된다.
            event.preventDefault();
            callbacksRef.current.onInput?.(seq[event.code]);
            return false;
          }
        }
        return callbacksRef.current.customKeyEventHandler?.(event) ?? true;
      });

      const doFit = () => {
        fitAddon.fit();
        callbacksRef.current.onResize?.(terminal.cols, terminal.rows);
      };

      doFit();
      setIsReady(true);

      // 비동기 레이아웃 안정화 대기 (HMR, 패널 초기화 등)
      reFitTimer = window.setTimeout(() => {
        if (disposed) return;
        doFit();
      }, 500);

      resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
          if (disposed) return;
          doFit();
        });
      });

      resizeObserver.observe(containerNode);
      // Mobile virtual keyboards may shrink visualViewport without resizing
      // the layout viewport. Keep the focused terminal and cursor visible.
      if ('ontouchstart' in window && navigator.maxTouchPoints > 0 && window.visualViewport) {
        const viewport = window.visualViewport;
        const onViewportChange = () => {
          if (disposed) return;
          const keyboardHeight = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
          const active = document.activeElement;
          if (keyboardHeight < 100 || !active || !containerNode.contains(active)) return;
          const rect = containerNode.getBoundingClientRect();
          const visibleBottom = viewport.offsetTop + viewport.height;
          if (rect.bottom > visibleBottom - 8) {
            const scroller = containerNode.closest('[data-mobile-terminal-scroll]') as HTMLElement | null;
            if (scroller) scroller.scrollTop += rect.bottom - visibleBottom + 8;
          }
          // Refresh xterm's viewport after visual keyboard animation.
          requestAnimationFrame(() => { if (!disposed) doFit(); });
          terminal.scrollToBottom();
        };
        viewport.addEventListener('resize', onViewportChange);
        viewport.addEventListener('scroll', onViewportChange);
        cleanupKeyboardViewport = () => {
          viewport.removeEventListener('resize', onViewportChange);
          viewport.removeEventListener('scroll', onViewportChange);
        };
      }


      // On touch screens: tap to focus the real xterm input; scroll with one
      // finger; long-press then drag to select terminal cells directly.
      const isTouchDevice = 'ontouchstart' in window && navigator.maxTouchPoints > 0;
      const screenEl = containerNode.querySelector('.xterm-screen');
      if (isTouchDevice && screenEl) {
        let lastY = 0;
        let accumulatedScrollLines = 0;
        let touchStartX = 0;
        let touchStartY = 0;
        let selectTimer: ReturnType<typeof setTimeout> | null = null;
        let selecting = false;
        let moved = false;
        let startCell: { col: number; row: number } | null = null;
        let selectionRaf = 0;
        let selectionPointerY = 0;
        let historyRequestedForGesture = false;
        const requestStoredHistory = () => {
          if (!historyRequestedForGesture && callbacksRef.current.onHistoryRequested) {
            historyRequestedForGesture = true;
            moved = true; // do not refocus the software keyboard on touchend
            callbacksRef.current.onHistoryRequested();
          }
        };
        const clearTimer = () => { if (selectTimer) clearTimeout(selectTimer); selectTimer = null; };
        const toCell = (touch: Touch) => {
          const rect = screenEl.getBoundingClientRect();
          const col = Math.max(0, Math.min(terminal.cols - 1,
            Math.floor((touch.clientX - rect.left) / (rect.width / terminal.cols))));
          const row = Math.max(0, Math.min(terminal.rows - 1,
            Math.floor((touch.clientY - rect.top) / (rect.height / terminal.rows))));
          return { col, row: row + terminal.buffer.active.viewportY };
        };
        const updateSelection = (touch: Touch) => {
          if (!startCell) return;
          const end = toCell(touch);
          const a = startCell.row * terminal.cols + startCell.col;
          const b = end.row * terminal.cols + end.col;
          const first = Math.min(a, b);
          const length = Math.max(1, Math.abs(b - a) + 1);
          terminal.select(first % terminal.cols, Math.floor(first / terminal.cols), length);
        };
        const autoScrollSelection = () => {
          if (!selecting || !startCell) { selectionRaf = 0; return; }
          const rect = screenEl.getBoundingClientRect();
          const edge = Math.min(45, rect.height * 0.15);
          let lines = 0;
          if (selectionPointerY < rect.top + edge) lines = -Math.max(1, Math.ceil((rect.top + edge - selectionPointerY) / 14));
          else if (selectionPointerY > rect.bottom - edge) lines = Math.max(1, Math.ceil((selectionPointerY - (rect.bottom - edge)) / 14));
          if (lines) {
            terminal.scrollLines(lines);
            if (lines < 0 && terminal.buffer.active.viewportY === 0) {
              selecting = false;
              requestStoredHistory();
              selectionRaf = 0;
              return;
            }
            const row = Math.max(0, Math.min(terminal.rows - 1,
              Math.floor((selectionPointerY - rect.top) / (rect.height / terminal.rows))));
            const fakeEnd = { col: lastSelectionCol, row: row + terminal.buffer.active.viewportY };
            const a = startCell.row * terminal.cols + startCell.col;
            const b = fakeEnd.row * terminal.cols + fakeEnd.col;
            const first = Math.min(a, b);
            terminal.select(first % terminal.cols, Math.floor(first / terminal.cols), Math.max(1, Math.abs(b - a) + 1));
          }
          selectionRaf = window.setTimeout(autoScrollSelection, 55);
        };
        let lastSelectionCol = 0;
        const onTouchStart = (event: TouchEvent) => {
          if (event.touches.length !== 1) { clearTimer(); return; }
          const touch = event.touches[0];
          lastY = touch.clientY;
          accumulatedScrollLines = 0;
          historyRequestedForGesture = false;
          selectionPointerY = touch.clientY;
          lastSelectionCol = toCell(touch).col;
          touchStartX = touch.clientX;
          touchStartY = touch.clientY;
          moved = false;
          selecting = false;
          clearTimer();
          selectTimer = setTimeout(() => {
            selecting = true;
            startCell = toCell(touch);
            updateSelection(touch);
            selectionRaf = window.setTimeout(autoScrollSelection, 55);
          }, 450);
        };
        const onTouchMove = (event: TouchEvent) => {
          if (event.touches.length !== 1) { clearTimer(); return; }
          const touch = event.touches[0];
          if (selecting) {
            event.preventDefault();
            selectionPointerY = touch.clientY;
            lastSelectionCol = toCell(touch).col;
            updateSelection(touch);
            return;
          }
          if (Math.hypot(touch.clientX - touchStartX, touch.clientY - touchStartY) > 9) {
            moved = true;
            clearTimer();
          }
          const deltaY = lastY - touch.clientY;
          lastY = touch.clientY;
          if (Math.abs(deltaY) < 3) return;
          event.preventDefault();
          // Synthetic WheelEvents are not trusted and may be ignored by
          // xterm/browser handlers. Move xterm's viewport directly.
          const lineHeightPx = Math.max(1, screenEl.getBoundingClientRect().height / terminal.rows);
          const fractionalLines = deltaY / lineHeightPx;
          accumulatedScrollLines += fractionalLines;
          const wholeLines = Math.trunc(accumulatedScrollLines);
          if (wholeLines !== 0) {
            terminal.scrollLines(wholeLines);
            accumulatedScrollLines -= wholeLines;
            // A nested tmux owns earlier output. When the xterm scrollback
            // boundary is reached, open the tmux-backed history instead.
            if (wholeLines < 0 && terminal.buffer.active.viewportY === 0) {
              requestStoredHistory();
            }
          }
        };
        const onTouchEnd = (event: TouchEvent) => {
          clearTimer();
          clearTimeout(selectionRaf);
          if (selecting) {
            event.preventDefault();
            selecting = false;
          } else if (!moved) {
            terminal.focus();
          }
        };
        const onTouchCancel = () => { clearTimer(); clearTimeout(selectionRaf); selecting = false; };
        containerNode.addEventListener('touchstart', onTouchStart, { passive: true });
        containerNode.addEventListener('touchmove', onTouchMove, { passive: false });
        containerNode.addEventListener('touchend', onTouchEnd, { passive: false });
        containerNode.addEventListener('touchcancel', onTouchCancel);
        cleanupTouch = () => {
          clearTimer();
          cancelAnimationFrame(selectionRaf);
          containerNode.removeEventListener('touchstart', onTouchStart);
          containerNode.removeEventListener('touchmove', onTouchMove);
          containerNode.removeEventListener('touchend', onTouchEnd);
          containerNode.removeEventListener('touchcancel', onTouchCancel);
        };
      }
    });

    return () => {
      disposed = true;
      setIsReady(false);
      cancelAnimationFrame(resizeRaf);
      clearTimeout(reFitTimer);
      resizeObserver?.disconnect();
      cleanupTouch?.();
      cleanupKeyboardViewport?.();
      cleanupContextMenu?.();
      cleanupDesktopHistoryWheel?.();
      writeGenerationRef.current++;
      writeQueueRef.current = [];
      pendingBytesRef.current = 0;
      isWritingRef.current = false;
      terminalInstance.current?.dispose();
      terminalInstance.current = null;
      fitAddonRef.current = null;
    };
  }, [containerNode]);

  useEffect(() => {
    if (terminalInstance.current && theme) {
      terminalInstance.current.options.theme = theme;
    }
  }, [theme]);

  useEffect(() => {
    const terminal = terminalInstance.current;
    if (!terminal || !fontSize || !lineHeight) return;
    terminal.options.fontSize = fontSize;
    terminal.options.lineHeight = lineHeight;
    fitAddonRef.current?.fit();
    callbacksRef.current.onResize?.(terminal.cols, terminal.rows);
  }, [fontSize, lineHeight]);

  return { terminalRef, write, clear, reset, fit, focus, isReady, getBufferText, copyTerminalText };
};

export default useTerminal;
