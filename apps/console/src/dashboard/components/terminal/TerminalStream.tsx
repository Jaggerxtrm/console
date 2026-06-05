import { useEffect, useMemo, useRef } from "react";
import type { MutableRefObject, ReactNode } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "xterm";
import "xterm/css/xterm.css";

const TERMINAL_FONT_FAMILY = '"JetBrainsMono Nerd Font Mono", "Hack Nerd Font Mono", "SFMono Nerd Font", "JetBrains Mono", "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace';

export type TerminalStreamChunk = string | Uint8Array;

export type TerminalStreamSize = {
  cols: number;
  rows: number;
};

export type TerminalStreamProps = {
  output?: readonly TerminalStreamChunk[];
  readonly?: boolean;
  status?: ReactNode;
  className?: string;
  onInput?: (data: string) => void;
  onResize?: (size: TerminalStreamSize) => void;
  onAttach?: () => void;
  onDetach?: () => void;
};

export function TerminalStream({
  output = [],
  readonly = false,
  status,
  className,
  onInput,
  onResize,
  onAttach,
  onDetach,
}: TerminalStreamProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const writtenOutputRef = useRef<readonly TerminalStreamChunk[]>([]);
  const readonlyRef = useRef(readonly);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const onAttachRef = useRef(onAttach);
  const onDetachRef = useRef(onDetach);

  useEffect(() => {
    readonlyRef.current = readonly;
    onInputRef.current = onInput;
    onResizeRef.current = onResize;
    onAttachRef.current = onAttach;
    onDetachRef.current = onDetach;
  }, [onAttach, onDetach, onInput, onResize, readonly]);

  const rootClassName = useMemo(() => {
    return className ? `terminal-stream ${className}` : "terminal-stream";
  }, [className]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "block",
      disableStdin: readonly,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 13,
      fontWeight: "400",
      fontWeightBold: "700",
      letterSpacing: 0,
      lineHeight: 1.15,
      scrollback: 5000,
      theme: {
        background: "var(--terminal-bg)",
        foreground: "var(--terminal-fg)",
        cursor: "var(--terminal-cursor)",
        selectionBackground: "var(--terminal-selection)",
        black: "#050608",
        brightBlack: "#5c6570",
        red: "#e57373",
        brightRed: "#ff8a80",
        green: "#86efac",
        brightGreen: "#bbf7d0",
        yellow: "#e8a534",
        brightYellow: "#facc15",
        blue: "#7dd3fc",
        brightBlue: "#bae6fd",
        magenta: "#c084fc",
        brightMagenta: "#ddd6fe",
        cyan: "#2dd4bf",
        brightCyan: "#99f6e4",
        white: "#d7dde5",
        brightWhite: "#f8fafc",
      },
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon as unknown as Parameters<Terminal["loadAddon"]>[0]);
    terminal.open(host);
    safeFocus(terminal);
    scheduleFit(host, terminal, fitAddon, onResizeRef);
    void document.fonts?.ready.then(() => scheduleFit(host, terminal, fitAddon, onResizeRef));

    terminal.onData((data) => {
      if (!readonlyRef.current) onInputRef.current?.(data);
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    onAttachRef.current?.();

    const resizeObserver = new ResizeObserver(() => {
      scheduleFit(host, terminal, fitAddon, onResizeRef);
    });
    resizeObserver.observe(host);

    return () => {
      resizeObserver.disconnect();
      onDetachRef.current?.();
      fitAddon.dispose();
      terminal.dispose();
      fitAddonRef.current = null;
      terminalRef.current = null;
      writtenOutputRef.current = [];
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const previous = writtenOutputRef.current;
    const canAppend = output.length >= previous.length && previous.every((chunk, index) => chunksEqual(chunk, output[index]));
    if (!canAppend) resetTerminal(terminal);

    const chunks = canAppend ? output.slice(previous.length) : output;
    for (const chunk of chunks) {
      terminal.write(chunk instanceof Uint8Array ? chunk : chunk);
    }
    writtenOutputRef.current = output.slice();
  }, [output]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;

    if (terminal.options) terminal.options.disableStdin = readonly;
    scheduleFit(hostRef.current, terminal, fitAddon, onResizeRef);
  }, [className, readonly, status]);

  return (
    <section className={rootClassName} aria-label="terminal stream">
      {status ? <div className="terminal-stream-status">{status}</div> : null}
      <div className="terminal-stream-surface" ref={hostRef} onMouseDown={() => safeFocus(terminalRef.current)} />
    </section>
  );
}

function safeFocus(terminal: Terminal | null): void {
  try {
    terminal?.focus?.();
  } catch {
    // xterm can briefly lack a renderer while React/Vite remounts; focus is best-effort.
  }
}

function resetTerminal(terminal: Terminal): void {
  const maybeReset = terminal as Terminal & { reset?: () => void; clear?: () => void };
  if (typeof maybeReset.reset === "function") {
    maybeReset.reset();
    return;
  }
  if (typeof maybeReset.clear === "function") maybeReset.clear();
}

function chunksEqual(left: TerminalStreamChunk, right: TerminalStreamChunk | undefined): boolean {
  if (right === undefined) return false;
  if (typeof left === "string" || typeof right === "string") return left === right;
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function scheduleFit(
  host: HTMLDivElement | null,
  terminal: Terminal,
  fitAddon: FitAddon,
  onResizeRef: MutableRefObject<((size: TerminalStreamSize) => void) | undefined>,
): void {
  if (!host || host.clientWidth === 0 || host.clientHeight === 0) return;

  requestAnimationFrame(() => {
    if (!host.isConnected || host.clientWidth === 0 || host.clientHeight === 0) return;
    try {
      fitAddon.fit();
      terminal.refresh?.(0, terminal.rows - 1);
      onResizeRef.current?.({ cols: terminal.cols, rows: terminal.rows });
    } catch {
      // Ignore transient xterm renderer races during drawer open/close and HMR remounts.
    }
  });
}
