import { useEffect, useMemo, useRef, useState } from "react";
import type { LogComponent, LogEntry, LogLevel } from "../../types/log.ts";
import { useWebSocket } from "./useWebSocket.ts";

export interface SystemLogFilter {
  level?: LogLevel;
  component?: LogComponent;
  search?: string;
}

export interface UseSystemLogsState {
  entries: LogEntry[];
  loading: boolean;
  error: string | null;
  clear: () => void;
  reload: () => Promise<void>;
}

const RING_SIZE = 2000;
const INITIAL_LIMIT = 1000;

export function useSystemLogs(filter: SystemLogFilter = {}): UseSystemLogsState {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const entriesRef = useRef<LogEntry[]>([]);

  const mergeEntries = useMemo(() => (nextEntries: LogEntry[]) => {
    const byKey = new Map<string, LogEntry>();
    for (const entry of [...entriesRef.current, ...nextEntries]) {
      byKey.set(logKey(entry), entry);
    }
    const next = [...byKey.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(-RING_SIZE);
    entriesRef.current = next;
    setEntries(next);
  }, []);

  const appendEntry = useMemo(() => (entry: LogEntry) => {
    const next = [...entriesRef.current, entry].slice(-RING_SIZE);
    entriesRef.current = next;
    setEntries(next);
  }, []);

  const reload = useMemo(() => async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/internal/logs?limit=${INITIAL_LIMIT}`);
      if (!res.ok) throw new Error(`logs fetch failed: ${res.status}`);
      mergeEntries(await res.json() as LogEntry[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [mergeEntries]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useWebSocket("system", (msg) => {
    if (msg.event !== "system:log") return;
    const entry = msg.data as LogEntry | undefined;
    if (!entry) return;
    appendEntry(entry);
  });

  const clear = useMemo(() => () => {
    entriesRef.current = [];
    setEntries([]);
  }, []);

  const filtered = useMemo(() => applyFilter(entries, filter), [entries, filter.component, filter.level, filter.search]);

  return { entries: filtered, loading, error, clear, reload };
}

function logKey(entry: LogEntry): string {
  return [entry.ts, entry.level, entry.component, entry.event, entry.msg ?? "", JSON.stringify(entry.data ?? {})].join("\u001f");
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
