import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { LogEntry, LogLevel } from "../../../types/log.ts";
import { useSystemLogs, type SystemLogFilter } from "../../hooks/useSystemLogs.ts";

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

export function LogsTabPanel({ onClear }: { onClear: () => void }) {
  const [filter, setFilter] = useState<SystemLogFilter>({});
  const [autoscroll, setAutoscroll] = useState(true);
  const { entries, loading, error, clear, reload } = useSystemLogs(filter);
  const parentRef = useRef<HTMLDivElement>(null);
  const shouldVirtualize = entries.length >= 500;

  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 22,
    overscan: 12,
    measureElement: (el) => el?.getBoundingClientRect().height ?? 22,
  });

  useEffect(() => {
    if (!autoscroll) return;
    const el = parentRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [autoscroll, entries.length]);

  const counts = useMemo(() => ({
    warn: entries.filter((entry) => entry.level === "warn").length,
    error: entries.filter((entry) => entry.level === "error").length,
  }), [entries]);

  return (
    <div className="drawer-logs" ref={parentRef} onScroll={() => {
      const el = parentRef.current;
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      setAutoscroll(nearBottom);
    }}>
      <div className="drawer-logs-toolbar">
        <div className="drawer-logs-levels">
          {LEVELS.map((level) => (
            <button key={level} type="button" className={filter.level === level ? "drawer-log-chip is-active" : "drawer-log-chip"} onClick={() => setFilter((state) => ({ ...state, level: state.level === level ? undefined : level }))}>
              {level}
            </button>
          ))}
        </div>
        <input className="drawer-logs-search" value={filter.search ?? ""} onChange={(e) => setFilter((state) => ({ ...state, search: e.target.value }))} placeholder="search msg / event / component" />
        <label className="drawer-logs-toggle"><input type="checkbox" checked={autoscroll} onChange={(e) => setAutoscroll(e.target.checked)} /> autoscroll</label>
        <button type="button" className="drawer-log-clear" onClick={() => void reload()}>reload</button>
        <button type="button" className="drawer-log-clear" onClick={() => { clear(); onClear(); }}>clear</button>
      </div>
      <div className="drawer-logs-status">logs: {entries.length} ({counts.warn} W, {counts.error} E){loading ? " · loading" : ""}{error ? ` · ${error}` : ""}</div>
      <div className={shouldVirtualize ? "drawer-logs-body is-virtual" : "drawer-logs-body"} style={shouldVirtualize ? { height: rowVirtualizer.getTotalSize(), position: "relative" } : undefined}>
        {entries.length === 0 ? <div className="drawer-logs-empty">no system logs yet — events stream as server emits them</div> : shouldVirtualize ? rowVirtualizer.getVirtualItems().map((row) => <LogRow key={entries[row.index].ts + row.index} entry={entries[row.index]} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start}px)` }} />) : entries.map((entry) => <LogRow key={entry.ts + entry.event} entry={entry} />)}
      </div>
    </div>
  );
}

function LogRow({ entry, style }: { entry: LogEntry; style?: CSSProperties }) {
  const data = formatData(entry.data);
  return (
    <div className="drawer-log-row" style={style} title={data}>
      <span>{formatTime(entry.ts)}</span>
      <span className={`drawer-log-level ${levelClass(entry.level)}`}>[{entry.level}]</span>
      <span>{entry.component}</span>
      <span>{entry.event}</span>
      <span>{entry.msg ?? ""}</span>
      {data && <code>{data}</code>}
    </div>
  );
}

function formatData(data: LogEntry["data"]): string {
  if (!data || Object.keys(data).length === 0) return "";
  try {
    return JSON.stringify(data);
  } catch {
    return "[unserializable data]";
  }
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function levelClass(level: LogLevel): string { return `is-${level}`; }
