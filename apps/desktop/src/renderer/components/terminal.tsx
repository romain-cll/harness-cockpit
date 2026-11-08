import type { ITheme, Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import type { PtyExit } from '../../shared/api';
import { fitLiveTerminal, type LiveTerminal } from './live-terminals';

const ANSI_COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

// The terminal colors are the page's tokens, read when the scheme changes: the
// computed value of a custom property is the one of the current scheme.
export function readTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(`--${name}`).trim();
  const [black, red, green, yellow, blue, magenta, cyan, white] = ANSI_COLORS.map((name) => token(`terminal-${name}`));
  const [brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] =
    ANSI_COLORS.map((name) => token(`terminal-bright-${name}`));
  return {
    background: token('background'),
    foreground: token('foreground'),
    cursor: token('foreground'),
    cursorAccent: token('background'),
    selectionBackground: token('ring'),
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  };
}

export function exitMessage({ exitCode, signal }: PtyExit): string {
  if (exitCode !== null) return `[Process exited with code ${exitCode}]`;
  if (signal !== null) return `[Process exited with signal ${signal}]`;
  return '[Process ended]';
}

// Where each terminal's view was when it left the page.
const scrolls = new WeakMap<XTerm, { line: number; bottom: boolean }>();

// The view of a live terminal (see `live-terminals.ts`), filling its parent. The
// terminal's element is moved into the container and out again, so unmounting the
// view leaves the shell running. The keyboard goes to the terminal whenever
// `focused` becomes true, and again when `request` changes while it is.
export function Terminal({ live, focused, request }: { live: LiveTerminal; focused: boolean; request?: number }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const { term } = live;
    const element = container.current!;
    // A terminal in a hidden area has no size to fit to.
    const fitToArea = () => {
      if (element.clientWidth > 0 && element.clientHeight > 0) fitLiveTerminal(live);
    };
    let observer: ResizeObserver | undefined;
    let cleanup: (() => void) | undefined;
    const start = () => {
      fitToArea();
      observer = new ResizeObserver(fitToArea);
      observer.observe(element);
    };

    const reattached = term.element !== undefined;
    if (!term.element) {
      term.open(element);
      start();
    } else {
      element.appendChild(term.element);
      // xterm.js pauses its renderer while its element is out of the page, and a resize or a scroll
      // handled meanwhile uses the old size: the view would stay clamped to it. So the terminal
      // draws first, then fits to its area and goes back to where the user left the view (the
      // bottom if the user was there).
      const left = scrolls.get(term);
      const drawn = term.onRender(() => {
        drawn.dispose();
        start();
        if (!left || left.bottom) term.scrollToBottom();
        else term.scrollToLine(left.line);
      });
      cleanup = () => drawn.dispose();
      term.refresh(0, term.rows - 1);
    }
    return () => {
      cleanup?.();
      observer?.disconnect();
      const { viewportY, baseY } = term.buffer.active;
      if (observer || !reattached) scrolls.set(term, { line: viewportY, bottom: viewportY >= baseY });
      term.element?.remove();
    };
  }, [live]);

  useEffect(() => {
    if (focused) live.term.focus();
  }, [live, focused, request]);

  return <div ref={container} className="size-full overflow-hidden bg-background px-2 py-1" />;
}
