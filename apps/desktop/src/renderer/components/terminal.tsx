import type { ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import type { PtyExit } from '../../shared/api';
import type { LiveTerminal } from './live-terminals';

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

// The view of a live terminal (see `live-terminals.ts`), filling its parent. The
// terminal's element is moved into the container and out again, so unmounting the
// view leaves the shell running. The keyboard goes to the terminal whenever
// `focused` becomes true.
export function Terminal({ live, focused }: { live: LiveTerminal; focused: boolean }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const { term, fit } = live;
    const element = container.current!;
    if (term.element) element.appendChild(term.element);
    else term.open(element);
    // A terminal in a hidden area has no size to fit to.
    const fitToArea = () => {
      if (element.clientWidth > 0 && element.clientHeight > 0) fit.fit();
    };
    fitToArea();
    const observer = new ResizeObserver(fitToArea);
    observer.observe(element);
    return () => {
      observer.disconnect();
      term.element?.remove();
    };
  }, [live]);

  useEffect(() => {
    if (focused) live.term.focus();
  }, [live, focused]);

  return <div ref={container} className="size-full overflow-hidden bg-background px-2 py-1" />;
}
