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

const useTerminal = ({ theme, fontSize = DEFAULT_FONT_SIZE, lineHeight = DEFAULT_LINE_HEIGHT, onInput, onResize, onTitleChange, customKeyEventHandler }: IUseTerminalOptions = {}) => {
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

  const callbacksRef = useRef({ theme, fontSize, lineHeight, onInput, onResize, onTitleChange, customKeyEventHandler, t });

  useEffect(() => {
    callbacksRef.current = { theme, fontSize, lineHeight, onInput, onResize, onTitleChange, customKeyEventHandler, t };
  }, [theme, fontSize, lineHeight, onInput, onResize, onTitleChange, customKeyEventHandler, t]);

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
    let cleanupContextMenu: (() => void) | null = null;

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

      // Keep the browser's native context menu, but do not forward right-click
      // mouse events to xterm/tmux (which would open tmux's own menu).
      const stopRightMouseForTerminal = (event: MouseEvent) => {
        if (event.button === 2) event.stopImmediatePropagation();
      };
      containerNode.addEventListener('mousedown', stopRightMouseForTerminal, true);
      containerNode.addEventListener('mouseup', stopRightMouseForTerminal, true);
      cleanupContextMenu = () => {
        containerNode.removeEventListener('mousedown', stopRightMouseForTerminal, true);
        containerNode.removeEventListener('mouseup', stopRightMouseForTerminal, true);
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
        // Windows-style shortcuts: Ctrl+C copies instead of sending SIGINT.
        // Ctrl+Shift+C explicitly sends SIGINT to the foreground remote process.
        const key = event.key.toLowerCase();
        if (event.type === 'keydown' && event.ctrlKey && !event.altKey && !event.metaKey && key === 'c') {
          event.preventDefault();
          if (event.shiftKey) {
            callbacksRef.current.onInput?.('\x03');
          } else if (terminal.hasSelection()) {
            void copyToClipboard(terminal.getSelection());
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

      // 모바일 터치 → 합성 WheelEvent 변환 (tmux 스크롤 지원)
      // tmux mouse mode 시 xterm.js가 .xterm-screen에 wheel 리스너를 붙이므로 해당 요소에 dispatch
      const isTouchDevice = 'ontouchstart' in window && navigator.maxTouchPoints > 0;
      const screenEl = containerNode.querySelector('.xterm-screen');

      if (isTouchDevice && screenEl) {
        let lastY = 0;

        const onTouchStart = (e: TouchEvent) => {
          lastY = e.touches[0].clientY;
        };

        const onTouchMove = (e: TouchEvent) => {
          const currentY = e.touches[0].clientY;
          const deltaY = lastY - currentY;
          lastY = currentY;

          if (Math.abs(deltaY) < 3) return;

          e.preventDefault();
          screenEl.dispatchEvent(
            new WheelEvent('wheel', {
              deltaY,
              clientX: e.touches[0].clientX,
              clientY: e.touches[0].clientY,
              bubbles: true,
            })
          );
        };

        containerNode.addEventListener('touchstart', onTouchStart, { passive: true });
        containerNode.addEventListener('touchmove', onTouchMove, { passive: false });
        cleanupTouch = () => {
          containerNode.removeEventListener('touchstart', onTouchStart);
          containerNode.removeEventListener('touchmove', onTouchMove);
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
      cleanupContextMenu?.();
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

  return { terminalRef, write, clear, reset, fit, focus, isReady, getBufferText };
};

export default useTerminal;
