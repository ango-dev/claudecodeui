import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import { ClipboardAddon, type IClipboardProvider } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import type { ITerminalOptions } from '@xterm/xterm';

import { useTheme } from '@/shared/context/ThemeContext';
import type { MobileTerminalSelectionManager, Project } from '@/shared/types';
import { copyTextToClipboard } from '@/shared/utils';
import { TERMINAL_INIT_DELAY_MS } from '@/shared/constants';
import { installMobileTerminalSelection } from '@/modules/shell/utils/mobileTerminalSelection';
import { sendSocketMessage } from '@/modules/shell/utils/socket';
import { ensureXtermFocusStyles } from '@/modules/shell/utils/terminalStyles';

const TERMINAL_RESIZE_DELAY_MS = 50;

const TERMINAL_OPTIONS: ITerminalOptions = {
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  allowProposedApi: true,
  allowTransparency: false,
  convertEol: true,
  scrollback: 10000,
  tabStopWidth: 4,
  windowsMode: false,
  macOptionIsMeta: true,
  macOptionClickForcesSelection: true,
};

// The options that follow the app's light/dark theme. They are applied when the
// terminal is created and re-applied to the open terminal on every toggle, so the
// pty behind it keeps running. xterm answers OSC 10/11 colour queries from
// `theme`, which is what TUIs that probe the terminal at startup (Codex, Claude
// Code's "auto" theme) read to choose a light or dark look.
type TerminalColorOptions = Pick<ITerminalOptions, 'theme' | 'minimumContrastRatio'>;

const DARK_TERMINAL_COLORS: TerminalColorOptions = {
  // xterm's default: leave the colours programs ask for untouched.
  minimumContrastRatio: 1,
  // Near-black to match the app's dark surfaces; ANSI hues are softened warm
  // variants of the classic set.
  theme: {
    background: '#151515',
    foreground: '#f0efec',
    cursor: '#de8364',
    cursorAccent: '#151515',
    selectionBackground: '#45423d',
    selectionForeground: '#f0efec',
    black: '#111111',
    red: '#e5806d',
    green: '#a7b86f',
    yellow: '#e3b660',
    blue: '#86abcc',
    magenta: '#cc92b5',
    cyan: '#86bcb1',
    white: '#cfcecb',
    brightBlack: '#93918b',
    brightRed: '#f09a87',
    brightGreen: '#bfcd8a',
    brightYellow: '#efca80',
    brightBlue: '#a3c0db',
    brightMagenta: '#dcaccb',
    brightCyan: '#a2cec5',
    brightWhite: '#f0efec',
    extendedAnsi: [
      '#000000',
      '#800000',
      '#008000',
      '#808000',
      '#000080',
      '#800080',
      '#008080',
      '#c0c0c0',
      '#808080',
      '#ff0000',
      '#00ff00',
      '#ffff00',
      '#0000ff',
      '#ff00ff',
      '#00ffff',
      '#ffffff',
    ],
  },
};

const LIGHT_TERMINAL_COLORS: TerminalColorOptions = {
  // Many CLIs hard-code truecolor accents picked for a dark background (bright
  // yellow, white, cyan). WCAG AA contrast (VS Code's terminal default) makes
  // xterm darken just those cells on white instead of leaving them unreadable.
  minimumContrastRatio: 4.5,
  // Off-white to match the app's light surfaces. The bright variants are
  // darker than the normal ones, because xterm draws bold text in them: every
  // colour except the two whites keeps at least 4.5:1 against the background.
  theme: {
    background: '#fcfcfb',
    foreground: '#141413',
    cursor: '#ae4f2e',
    cursorAccent: '#fcfcfb',
    selectionBackground: '#edcab9',
    selectionForeground: '#141413',
    black: '#141413',
    red: '#b3372e',
    green: '#4a6a1e',
    yellow: '#875800',
    blue: '#2f5f8a',
    magenta: '#8e3f6e',
    cyan: '#1d6b66',
    white: '#6b6a65',
    brightBlack: '#55534e',
    brightRed: '#952a22',
    brightGreen: '#3d5817',
    brightYellow: '#714a00',
    brightBlue: '#244d73',
    brightMagenta: '#76325b',
    brightCyan: '#175955',
    brightWhite: '#8a857b',
  },
};

// CLIs running inside the pty (e.g. `claude auth login`'s "press c to copy"
// device-flow prompt) write to the clipboard via an OSC 52 escape sequence,
// not a browser event — xterm.js ignores OSC 52 unless a clipboard addon is
// loaded. Routes writes through the same fallback-aware helper the terminal's
// own selection-copy shortcut uses, since `navigator.clipboard` is often
// unavailable on self-hosted, non-HTTPS deployments.
// `ClipboardSelectionType.SYSTEM` is `'c'` (vs. `'p'` for the X11 primary
// selection) — compared as a literal since the addon ships it as a const
// enum, which isolatedModules builds (esbuild/Vite) can't import as a value.
const oscClipboardProvider: IClipboardProvider = {
  readText: async (selection) => {
    if (selection !== 'c') {
      return '';
    }
    try {
      return (await navigator.clipboard?.readText?.()) || '';
    } catch {
      return '';
    }
  },
  writeText: async (selection, text) => {
    if (selection !== 'c') {
      return;
    }
    await copyTextToClipboard(text);
  },
};

// The addon's published typings declare a single `(provider?)` constructor
// param, but the shipped runtime actually takes `(base64?, provider?)` — see
// node_modules/@xterm/addon-clipboard/lib/addon-clipboard.js. Cast to call it
// the way it's really implemented.
const ClipboardAddonCtor = ClipboardAddon as unknown as new (
  base64?: unknown,
  provider?: IClipboardProvider,
) => ClipboardAddon;

type UseShellTerminalOptions = {
  terminalContainerRef: RefObject<HTMLDivElement>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  wsRef: MutableRefObject<WebSocket | null>;
  selectedProject: Project | null | undefined;
  minimal: boolean;
  isRestarting: boolean;
  closeSocket: () => void;
};

type UseShellTerminalResult = {
  isInitialized: boolean;
  clearTerminalScreen: () => void;
  disposeTerminal: () => void;
};

export function useShellTerminal({
  terminalContainerRef,
  terminalRef,
  fitAddonRef,
  wsRef,
  selectedProject,
  minimal,
  isRestarting,
  closeSocket,
}: UseShellTerminalOptions): UseShellTerminalResult {
  const { isDarkMode } = useTheme();
  const [isInitialized, setIsInitialized] = useState(false);
  // Read through a ref when the terminal is created: with the theme in that
  // effect's dependencies, a toggle would dispose the terminal and close the
  // socket instead of repainting the session that is running.
  const isDarkModeRef = useRef(isDarkMode);
  const resizeTimeoutRef = useRef<number | null>(null);
  const mobileSelectionRef = useRef<MobileTerminalSelectionManager | null>(null);
  const selectedProjectKey = selectedProject?.fullPath || selectedProject?.path || '';
  const hasSelectedProject = Boolean(selectedProject);

  useEffect(() => {
    ensureXtermFocusStyles();
  }, []);

  const clearTerminalScreen = useCallback(() => {
    if (!terminalRef.current) {
      return;
    }

    terminalRef.current.clear();
    terminalRef.current.write('\x1b[2J\x1b[H');
  }, [terminalRef]);

  const disposeTerminal = useCallback(() => {
    if (mobileSelectionRef.current) {
      mobileSelectionRef.current.dispose();
      mobileSelectionRef.current = null;
    }

    if (terminalRef.current) {
      terminalRef.current.dispose();
      terminalRef.current = null;
    }

    fitAddonRef.current = null;
    setIsInitialized(false);
  }, [fitAddonRef, terminalRef]);

  useEffect(() => {
    const terminalContainer = terminalContainerRef.current;
    if (!terminalContainer || !hasSelectedProject || isRestarting || terminalRef.current) {
      return;
    }

    const nextTerminal = new Terminal({
      ...TERMINAL_OPTIONS,
      ...(isDarkModeRef.current ? DARK_TERMINAL_COLORS : LIGHT_TERMINAL_COLORS),
    });
    terminalRef.current = nextTerminal;

    const nextFitAddon = new FitAddon();
    fitAddonRef.current = nextFitAddon;
    nextTerminal.loadAddon(nextFitAddon);

    nextTerminal.loadAddon(new ClipboardAddonCtor(undefined, oscClipboardProvider));

    // Avoid wrapped partial links in compact login flows.
    if (!minimal) {
      nextTerminal.loadAddon(new WebLinksAddon());
    }

    try {
      nextTerminal.loadAddon(new WebglAddon());
    } catch {
      console.warn('[Shell] WebGL renderer unavailable, using Canvas fallback');
    }

    nextTerminal.open(terminalContainer);
    mobileSelectionRef.current = installMobileTerminalSelection(
      nextTerminal,
      terminalContainer,
      {
        onFontSizeChange: (fontSize) => {
          nextTerminal.options.fontSize = fontSize;

          const currentFitAddon = fitAddonRef.current;
          if (currentFitAddon) {
            currentFitAddon.fit();
            sendSocketMessage(wsRef.current, {
              type: 'resize',
              cols: nextTerminal.cols,
              rows: nextTerminal.rows,
            });
          } else {
            nextTerminal.refresh(0, nextTerminal.rows - 1);
          }
        },
      },
    );

    const copyTerminalSelection = async () => {
      const selection = nextTerminal.getSelection();
      if (!selection) {
        return false;
      }

      return copyTextToClipboard(selection);
    };

    const handleTerminalCopy = (event: ClipboardEvent) => {
      if (!nextTerminal.hasSelection()) {
        return;
      }

      const selection = nextTerminal.getSelection();
      if (!selection) {
        return;
      }

      event.preventDefault();

      if (event.clipboardData) {
        event.clipboardData.setData('text/plain', selection);
        return;
      }

      void copyTextToClipboard(selection);
    };

    terminalContainer.addEventListener('copy', handleTerminalCopy);

    nextTerminal.attachCustomKeyEventHandler((event) => {
      if (
        event.type === 'keydown' &&
        (event.ctrlKey || event.metaKey) &&
        event.key?.toLowerCase() === 'c' &&
        nextTerminal.hasSelection()
      ) {
        event.preventDefault();
        event.stopPropagation();
        void copyTerminalSelection();
        return false;
      }

      if (
        event.type === 'keydown' &&
        (event.ctrlKey || event.metaKey) &&
        event.key?.toLowerCase() === 'v'
      ) {
        // Block native paste so data is only injected after clipboard-read resolves.
        event.preventDefault();
        event.stopPropagation();

        if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
          navigator.clipboard
            .readText()
            .then((text) => {
              sendSocketMessage(wsRef.current, {
                type: 'input',
                data: text,
              });
            })
            .catch(() => {});
        }

        return false;
      }

      return true;
    });

    window.setTimeout(() => {
      const currentFitAddon = fitAddonRef.current;
      const currentTerminal = terminalRef.current;
      if (!currentFitAddon || !currentTerminal) {
        return;
      }

      currentFitAddon.fit();
      sendSocketMessage(wsRef.current, {
        type: 'resize',
        cols: currentTerminal.cols,
        rows: currentTerminal.rows,
      });
    }, TERMINAL_INIT_DELAY_MS);

    setIsInitialized(true);

    const dataSubscription = nextTerminal.onData((data) => {
      sendSocketMessage(wsRef.current, {
        type: 'input',
        data,
      });
    });

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
      }

      resizeTimeoutRef.current = window.setTimeout(() => {
        const currentFitAddon = fitAddonRef.current;
        const currentTerminal = terminalRef.current;
        if (!currentFitAddon || !currentTerminal) {
          return;
        }

        currentFitAddon.fit();
        sendSocketMessage(wsRef.current, {
          type: 'resize',
          cols: currentTerminal.cols,
          rows: currentTerminal.rows,
        });
      }, TERMINAL_RESIZE_DELAY_MS);
    });

    resizeObserver.observe(terminalContainer);

    return () => {
      terminalContainer.removeEventListener('copy', handleTerminalCopy);
      resizeObserver.disconnect();
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = null;
      }
      dataSubscription.dispose();
      closeSocket();
      disposeTerminal();
    };
  }, [
    closeSocket,
    disposeTerminal,
    fitAddonRef,
    isRestarting,
    hasSelectedProject,
    minimal,
    selectedProjectKey,
    terminalContainerRef,
    terminalRef,
    wsRef,
  ]);

  useEffect(() => {
    isDarkModeRef.current = isDarkMode;

    const currentTerminal = terminalRef.current;
    if (!currentTerminal) {
      return;
    }

    const colors = isDarkMode ? DARK_TERMINAL_COLORS : LIGHT_TERMINAL_COLORS;
    currentTerminal.options.theme = colors.theme;
    currentTerminal.options.minimumContrastRatio = colors.minimumContrastRatio;
  }, [isDarkMode, terminalRef]);

  return {
    isInitialized,
    clearTerminalScreen,
    disposeTerminal,
  };
}
