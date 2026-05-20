import { useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "xterm";

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
  const seenOutputRef = useRef(0);

  const rootClassName = useMemo(() => {
    return className ? `terminal-stream ${className}` : "terminal-stream";
  }, [className]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      theme: {
        background: "var(--terminal-bg)",
        foreground: "var(--terminal-fg)",
        cursor: "var(--terminal-cursor)",
        selectionBackground: "var(--terminal-selection)",
      },
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon as unknown as Parameters<Terminal["loadAddon"]>[0]);
    terminal.open(host);
    fitAddon.fit();

    terminal.onData((data) => {
      if (!readonly) onInput?.(data);
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    onAttach?.();

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      onResize?.({ cols: terminal.cols, rows: terminal.rows });
    });
    resizeObserver.observe(host);

    return () => {
      resizeObserver.disconnect();
      onDetach?.();
      fitAddon.dispose();
      terminal.dispose();
      fitAddonRef.current = null;
      terminalRef.current = null;
    };
  }, [onAttach, onDetach, onInput, onResize, readonly]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    for (const chunk of output.slice(seenOutputRef.current)) {
      terminal.write(chunk instanceof Uint8Array ? chunk : chunk);
    }
    seenOutputRef.current = output.length;
  }, [output]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;

    fitAddon.fit();
    onResize?.({ cols: terminal.cols, rows: terminal.rows });
  }, [onResize, className, readonly, status]);

  return (
    <section className={rootClassName} aria-label="terminal stream">
      {status ? <div className="terminal-stream-status">{status}</div> : null}
      <div className="terminal-stream-surface" ref={hostRef} />
    </section>
  );
}
