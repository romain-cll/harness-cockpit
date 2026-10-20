import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import type { PtyExit } from '../../shared/api';

const ANSI_COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

// The terminal colors are the page's tokens, read when the scheme changes: the
// computed value of a custom property is the one of the current scheme.
function readTheme(): ITheme {
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

function exitMessage({ exitCode, signal }: PtyExit): string {
  if (exitCode !== null) return `[Process exited with code ${exitCode}]`;
  if (signal !== null) return `[Process exited with signal ${signal}]`;
  return '[Process ended]';
}

// An xterm.js terminal running a shell through `window.api.pty`. The shell lives
// as long as the component: unmounting kills it.
export function Terminal() {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const { pty } = window.api;
    const term = new XTerm({ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, theme: readTheme() });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current!);
    fit.fit();
    term.focus();

    let sessionId: number | undefined;
    let exited = false;
    let disposed = false;

    // Output and exit can arrive before `spawn` resolves with the session id:
    // they are held until then, and those of other sessions are dropped.
    const early: Array<{ id: number; apply: () => void }> = [];
    const onSession = (id: number, apply: () => void) => {
      if (sessionId === undefined) early.push({ id, apply });
      else if (id === sessionId) apply();
    };
    const offData = pty.onData((id, data) => onSession(id, () => term.write(data)));
    const offExit = pty.onExit((id, exit) =>
      onSession(id, () => {
        exited = true;
        term.write(`\r\n${exitMessage(exit)}`);
      }),
    );

    pty
      .spawn({ cols: term.cols, rows: term.rows })
      .then((id) => {
        if (disposed) {
          pty.kill(id);
          return;
        }
        sessionId = id;
        for (const event of early) if (event.id === id) event.apply();
        early.length = 0;
      })
      .catch((error: unknown) => {
        if (!disposed) term.write(`\r\n[Could not start the shell: ${error instanceof Error ? error.message : error}]`);
      });

    const input = term.onData((data) => {
      if (sessionId !== undefined && !exited) pty.write(sessionId, data);
    });
    const resize = term.onResize(({ cols, rows }) => {
      if (sessionId !== undefined && !exited) pty.resize(sessionId, cols, rows);
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(container.current!);

    const scheme = matchMedia('(prefers-color-scheme: dark)');
    const onSchemeChange = () => {
      term.options.theme = readTheme();
    };
    scheme.addEventListener('change', onSchemeChange);

    return () => {
      disposed = true;
      scheme.removeEventListener('change', onSchemeChange);
      observer.disconnect();
      resize.dispose();
      input.dispose();
      offExit();
      offData();
      if (sessionId !== undefined && !exited) pty.kill(sessionId);
      term.dispose();
    };
  }, []);

  return <div ref={container} className="min-h-0 flex-1 overflow-hidden bg-background px-2 py-1" />;
}
