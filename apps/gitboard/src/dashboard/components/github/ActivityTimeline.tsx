import { useRef, useState, useEffect, useCallback } from "react";
import * as Accordion from "@radix-ui/react-accordion";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronDownIcon } from "@primer/octicons-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { EventIcon, eventColor } from "./EventIcon.tsx";
import { apiClient } from "../../lib/client.ts";
import type { GithubEvent, GithubCommit } from "../../../types/github.ts";

export const COMMIT_BODY_SOFT_CAP = 20;

export function commitBodyLines(messageFull: string | null | undefined): string[] {
  if (!messageFull) return [];
  const lines = messageFull.split("\n");
  // Skip first line (subject) and blank separator
  const body = lines.slice(1).filter((_, i, arr) => !(i === 0 && arr[0].trim() === ""));
  // Drop leading blank lines
  let start = 0;
  while (start < body.length && body[start].trim() === "") start++;
  return body.slice(start, start + COMMIT_BODY_SOFT_CAP);
}

interface Props {
  events: GithubEvent[];
  selectedId: string | null;
  onSelect: (event: GithubEvent) => void;
}

type Item =
  | { kind: "header"; label: string; key: string }
  | { kind: "event"; event: GithubEvent };

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function buildItems(events: GithubEvent[]): Item[] {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  const items: Item[] = [];
  let lastDate = "";
  for (const evt of events) {
    const evtDate = new Date(evt.created_at).toDateString();
    if (evtDate !== lastDate) {
      lastDate = evtDate;
      let label: string;
      if (evtDate === today) label = "Today";
      else if (evtDate === yesterday) label = "Yesterday";
      else {
        const d = new Date(evt.created_at);
        label = d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
      }
      items.push({ kind: "header", label, key: `header-${evtDate}` });
    }
    items.push({ kind: "event", event: evt });
  }
  return items;
}

function CommitRow({ commit }: { commit: GithubCommit }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const subject = commit.message.split("\n")[0];
  const bodyLines = commitBodyLines(commit.message_full);
  const hasBody = bodyLines.length > 0;
  const totalBodyLines = commit.message_full
    ? commit.message_full.split("\n").slice(1).filter((_, i, a) => !(i === 0 && a[0].trim() === "")).filter((l, i, a) => {
        let s = 0; while (s < a.length && a[s].trim() === "") s++; return i >= s;
      }).length
    : 0;
  const hiddenCount = totalBodyLines - COMMIT_BODY_SOFT_CAP;

  return (
    <div className="activity-commit-row" style={{ padding: "3px 0", fontSize: "var(--text-xs)" }}>
      <div
        className="activity-commit-toggle"
        onClick={hasBody ? () => setOpen(o => !o) : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: hasBody ? "pointer" : "default",
          borderRadius: "var(--radius-xs)",
          padding: "1px 2px",
        }}
      >
        <a
          href={commit.url ?? `https://github.com/${commit.repo}/commit/${commit.sha}`}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{ fontFamily: "var(--font-mono)", color: "var(--accent-blue)", flexShrink: 0 }}
        >
          {commit.sha.slice(0, 7)}
        </a>
        <span style={{ color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          {subject}
        </span>
        {hasBody && (
          <span style={{ display: "inline-flex", color: "var(--text-muted)", flexShrink: 0, transform: open ? "rotate(180deg)" : undefined, transition: "transform 0.15s" }}>
            <ChevronDownIcon size={11} />
          </span>
        )}
      </div>
      {hasBody && open && (
        <div className="activity-commit-body" style={{
          marginTop: 4,
          marginLeft: 44,
          padding: "6px 8px",
          background: "var(--surface-tertiary)",
          borderRadius: "var(--radius-sm)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--text-secondary)",
          whiteSpace: "pre-wrap",
          lineHeight: 1.5,
        }}>
          {(showAll ? commit.message_full!.split("\n").slice(1) : bodyLines).join("\n")}
          {!showAll && hiddenCount > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowAll(true); }}
              style={{ display: "block", marginTop: 4, background: "transparent", border: "none", color: "var(--accent-blue)", cursor: "pointer", fontSize: 10, padding: 0 }}
            >
              Show {hiddenCount} more line{hiddenCount !== 1 ? "s" : ""}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface EventRowProps {
  evt: GithubEvent;
  selected: boolean;
  hovered: boolean;
  expanded?: boolean;
  onSelect: (e: GithubEvent) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function EventRow({ evt, selected, hovered, expanded = false, onSelect, onMouseEnter, onMouseLeave }: EventRowProps) {
  const color = eventColor(evt.type, evt.action);
  const hasDiff = evt.additions != null || evt.deletions != null;

  return (
    <div
      role="row"
      className={selected ? "timeline-row is-selected" : hovered ? "timeline-row is-hovered" : "timeline-row"}
      aria-selected={selected}
      onClick={() => onSelect(evt)}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        gap: 0,
        minHeight: "var(--row-height)",
        padding: "0 16px 0 18px",
        borderRadius: 0,
        borderBottom: "1px solid var(--border-subtle)",
        borderLeft: selected ? `2px solid ${color}` : "2px solid transparent",
        background: selected ? "var(--surface-secondary)" : hovered ? "var(--surface-hover)" : "var(--surface-primary)",
        cursor: "pointer",
        transition: "var(--transition-fast)",
        minWidth: 0,
      }}
    >
      {/* Indicator dot */}
      <div style={{ width: 6, height: 6, borderRadius: "var(--radius-pill)", background: color, flexShrink: 0, marginRight: 8 }} />

      {/* Time */}
      <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", width: 44, flexShrink: 0 }}>
        {formatTime(evt.created_at)}
      </span>

      {/* Icon */}
      <span style={{ color, flexShrink: 0, marginRight: 8, width: 16 }}>
        <EventIcon type={evt.type} action={evt.action} />
      </span>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
        {/* Line 1: repo · title */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 4, overflow: "hidden" }}>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "40%" }}>
            {evt.repo}
          </span>
          <span style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)", flexShrink: 0 }}>·</span>
          <span style={{ fontSize: "12px", fontWeight: 540, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {evt.title ?? evt.type}
          </span>
        </div>

        {/* Line 2: branch + commit count + chevron */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 0 }}>
          {evt.branch && (
            <span style={{
              fontSize: "var(--text-xs)",
              color: "var(--text-secondary)",
              background: "var(--surface-tertiary)",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius-xs)",
              padding: "0 5px",
            }}>
              {evt.branch}
            </span>
          )}
          {evt.commit_count != null && evt.commit_count > 0 && (
            <span style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>
              {evt.commit_count} commit{evt.commit_count !== 1 ? "s" : ""}
            </span>
          )}
          {evt.type === "PushEvent" && (
            <span style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)", display: "inline-flex", transform: expanded ? "rotate(180deg)" : undefined, transition: "transform 0.15s" }}>
              <ChevronDownIcon size={12} />
            </span>
          )}
        </div>
      </div>

      {/* Diffstats */}
      {hasDiff && (
        <div style={{ display: "flex", gap: 4, fontSize: "var(--text-xs)", fontWeight: 500, flexShrink: 0, marginLeft: 6 }}>
          {evt.additions != null && <span style={{ color: "var(--diff-add)" }}>+{evt.additions}</span>}
          {evt.deletions != null && <span style={{ color: "var(--diff-del)" }}>−{evt.deletions}</span>}
        </div>
      )}
    </div>
  );
}

function DayHeader({ label }: { label: string }) {
  return (
    <div className="timeline-day-header" style={{
      boxSizing: "border-box",
      height: 24,
      padding: "4px 18px 0",
      fontSize: "var(--header-font-size)",
      fontWeight: 600,
      color: "var(--text-muted)",
      textTransform: "none",
      letterSpacing: "0.05em",
      background: "var(--surface-primary)",
      borderBottom: "1px solid var(--border-subtle)",
    }}>
      {label}
    </div>
  );
}

function VirtualizedTimeline({ events, selectedId, onSelect }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [commitCache, setCommitCache] = useState<Map<string, GithubCommit[]>>(new Map());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [newCount, setNewCount] = useState(0);
  const prevLengthRef = useRef(events.length);
  const prevFirstIdRef = useRef<string | null>(events[0]?.id ?? null);

  // Detect new events prepended
  useEffect(() => {
    if (events.length > 0) {
      const firstId = events[0].id;
      if (prevFirstIdRef.current !== null && firstId !== prevFirstIdRef.current) {
        const prevIdx = events.findIndex(e => e.id === prevFirstIdRef.current);
        if (prevIdx > 0) setNewCount(c => c + prevIdx);
      }
      prevFirstIdRef.current = firstId;
    }
    prevLengthRef.current = events.length;
  }, [events]);

  const items = buildItems(events);

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => items[i].kind === "header" ? 24 : 40,
    overscan: 5,
    measureElement: (el) => el?.getBoundingClientRect().height ?? 0,
  });

  // Toggle commit accordion and fetch if needed
  const handleAccordionChange = useCallback((evtId: string) => {
    setExpandedIds(prev => {
      if (prev.includes(evtId)) return prev.filter(id => id !== evtId);
      return [...prev, evtId];
    });
    if (commitCache.has(evtId) || loadingIds.has(evtId)) return;
    setLoadingIds(prev => new Set([...prev, evtId]));
    apiClient.getCommits(undefined, undefined, evtId)
      .then(res => setCommitCache(prev => new Map([...prev, [evtId, res.data]])))
      .catch(() => setCommitCache(prev => new Map([...prev, [evtId, []]])))
      .finally(() => setLoadingIds(prev => { const n = new Set(prev); n.delete(evtId); return n; }));
  }, [commitCache, loadingIds]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const evtItems = items.filter(i => i.kind === "event") as Extract<Item, { kind: "event" }>[];
      if (e.key === "j" || e.key === "k") {
        const idx = evtItems.findIndex(i => i.event.id === selectedId);
        const nextIdx = e.key === "j"
          ? Math.min(evtItems.length - 1, idx + 1)
          : Math.max(0, idx - 1);
        if (evtItems[nextIdx]) onSelect(evtItems[nextIdx].event);
      }
      if (e.key === "Escape") onSelect(null as unknown as GithubEvent);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [items, selectedId, onSelect]);

  const scrollToTop = () => {
    parentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    setNewCount(0);
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", position: "relative" }}>
      {/* New events banner */}
      {newCount > 0 && (
        <button
          onClick={scrollToTop}
          style={{
            position: "sticky",
            top: 0,
            zIndex: 10,
            width: "100%",
            padding: "6px 16px",
            background: "var(--accent-blue)",
            border: "none",
            color: "#fff",
            fontSize: "var(--text-xs)",
            fontWeight: 600,
            cursor: "pointer",
            textAlign: "center",
          }}
        >
          {newCount} new event{newCount !== 1 ? "s" : ""} — click to scroll to top
        </button>
      )}

      <div ref={parentRef} style={{ overflow: "auto", flex: 1 }} role="table">
          <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const item = items[virtualRow.index];
              return (
                <div
                  key={item.kind === "header" ? item.key : item.event.id}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {item.kind === "header" ? (
                    <DayHeader label={item.label} />
                  ) : (
                    <div>
                      <EventRow
                        evt={item.event}
                        selected={item.event.id === selectedId}
                        hovered={hoveredId === item.event.id}
                        expanded={expandedIds.includes(item.event.id)}
                        onSelect={(evt) => {
                          onSelect(evt);
                          if (evt.type === "PushEvent") handleAccordionChange(item.event.id);
                        }}
                        onMouseEnter={() => setHoveredId(item.event.id)}
                        onMouseLeave={() => setHoveredId(null)}
                      />
                      {item.event.type === "PushEvent" && expandedIds.includes(item.event.id) && (
                        <div style={{ borderTop: "1px solid var(--border-subtle)" }}>
                          {loadingIds.has(item.event.id) ? (
                            <div style={{ padding: "6px 12px", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>Loading commits…</div>
                          ) : (
                            <div style={{ padding: "2px 12px 6px" }}>
                              {(commitCache.get(item.event.id) ?? []).map(commit => (
                                <CommitRow key={commit.sha} commit={commit} />
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
      </div>
    </div>
  );
}

export function ActivityTimeline({ events, selectedId, onSelect }: Props) {
  if (events.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)", fontSize: "var(--text-base)" }} role="table">
        No events to display.
      </div>
    );
  }

  // SSR fallback — no virtualizer, no Radix hooks
  if (typeof window === "undefined") {
    const [hoveredId] = useState<string | null>(null);
    const items = buildItems(events);

    return (
      <div style={{ overflow: "auto", height: "100%" }} role="table">
        {items.map((item) =>
          item.kind === "header" ? (
            <DayHeader key={item.key} label={item.label} />
          ) : (
            <EventRow
              key={item.event.id}
              evt={item.event}
              selected={item.event.id === selectedId}
              hovered={hoveredId === item.event.id}
              onSelect={onSelect}
              onMouseEnter={() => {}}
              onMouseLeave={() => {}}
            />
          )
        )}
      </div>
    );
  }

  return <VirtualizedTimeline events={events} selectedId={selectedId} onSelect={onSelect} />;
}
