import { useMemo, useRef, useState } from "react";
import type { LogComponent, LogEntry, LogLevel } from "../../types/log.ts";
import { useWebSocket } from "./useWebSocket.ts";

export interface SystemLogFilter {
  level?: LogLevel;
  component?: LogComponent;
  search?: string;
}

export interface UseSystemLogsState {
  entries: LogEntry[];
  clear: () => void;
}

const RING_SIZE = 2000;

export function useSystemLogs(filter: SystemLogFilter = {}): UseSystemLogsState {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const entriesRef = useRef<LogEntry[]>([]);

  useWebSocket("system", (msg) => {
    const entry = msg.data as LogEntry | undefined;
    if (!entry) return;
    const next = [...entriesRef.current, entry].slice(-RING_SIZE);
    entriesRef.current = next;
    setEntries(next);
  });

  const clear = useMemo(() => () => {
    entriesRef.current = [];
    setEntries([]);
  }, []);

  const filtered = useMemo(() => applyFilter(entries, filter), [entries, filter.component, filter.level, filter.search]);

  return { entries: filtered, clear };
}

function applyFilter(entries: LogEntry[], filter: SystemLogFilter): LogEntry[] {
  const search = filter.search?.trim().toLowerCase() ?? "";
  return entries.filter((entry) => {
    if (filter.level && entry.level !== filter.level) return false;
    if (filter.component && entry.component !== filter.component) return false;
    if (!search) return true;
    return [entry.msg ?? "", entry.event, entry.component, JSON.stringify(entry.data ?? {})].join(" ").toLowerCase().includes(search);
  });
}
