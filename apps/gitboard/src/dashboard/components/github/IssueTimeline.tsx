import { useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  IssueOpenedIcon,
  IssueClosedIcon,
  ChevronDownIcon,
  CommentIcon,
  LinkExternalIcon,
} from "@primer/octicons-react";
import type { GithubIssue } from "../../../types/github.ts";
import {
  buildDateGroupedItems,
  formatRelativeTime,
  parseLabels,
  truncateBody,
  type DateGroupItem,
} from "../../lib/timeline-utils.ts";
import { renderPrBodyText } from "./PrTimeline.tsx";

type IssueItem = DateGroupItem<GithubIssue>;

function issueStateStyle(state: string): { Icon: React.ElementType; color: string } {
  if (state === "closed") return { Icon: IssueClosedIcon, color: "var(--text-muted)" };
  return { Icon: IssueOpenedIcon, color: "var(--accent-green)" };
}

function DayHeader({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: "4px 12px 3px",
        fontSize: "var(--text-xs)",
        color: "var(--text-muted)",
        fontWeight: 600,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        borderBottom: "1px solid var(--border-subtle)",
        background: "var(--surface-primary)",
      }}
    >
      {label}
    </div>
  );
}

function LabelChip({ name }: { name: string }) {
  return (
    <span className="issue-label-chip">
      {name}
    </span>
  );
}

function IssueExpandedBody({ issue }: { issue: GithubIssue }) {
  const [showMore, setShowMore] = useState(false);
  const labels = parseLabels(issue.label_names);

  return (
    <div className="issue-expanded-body">
      <div className="gb-detail-stack">
        {issue.body && (() => {
          const { visible, hasMore } = truncateBody(issue.body);
          const rendered = renderPrBodyText(showMore ? issue.body : visible);
          return (
            <div>
              <div className="pr-body-text">
                <div className="pr-rich-text">{rendered}</div>
              </div>
              {hasMore && !showMore && (
                <button
                  className="pr-show-more"
                  onClick={(e) => { e.stopPropagation(); setShowMore(true); }}
                >
                  show full text
                </button>
              )}
            </div>
          );
        })()}
        {issue.comment_count > 0 && (
          <div style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>
            {issue.comment_count} {issue.comment_count === 1 ? "comment" : "comments"}
          </div>
        )}
        {labels.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {labels.map((name) => <LabelChip key={name} name={name} />)}
          </div>
        )}
        {issue.url && (
          <a
            href={issue.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--accent-blue)", fontSize: "var(--text-xs)", textDecoration: "none" }}
          >
            <LinkExternalIcon size={12} />
            Open on GitHub
          </a>
        )}
      </div>
    </div>
  );
}

function IssueRow({
  issue,
  expanded,
  onToggle,
}: {
  issue: GithubIssue;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { Icon, color } = issueStateStyle(issue.state);
  const repoShort = issue.repo.split("/")[1] ?? issue.repo;
  const time = formatRelativeTime(issue.updated_at ?? issue.created_at);

  return (
    <div
      className={`issue-row ${expanded ? "is-expanded" : ""} ${issue.state === "closed" ? "closed" : "open"}`}
      onClick={onToggle}
    >
      <div className="issue-row-main">
        <span className="issue-row-icon" style={{ color }}>
          <Icon size={16} />
        </span>
        <span className="issue-number">
          #{issue.number}
        </span>
        <span className="issue-title">
          {issue.title}
        </span>
        <span className="issue-repo">
          {repoShort}
        </span>
        {issue.comment_count > 0 && (
          <span className="issue-comments">
            <CommentIcon size={12} />
            {issue.comment_count}
          </span>
        )}
        <span className="issue-time">
          {time}
        </span>
        <span className="issue-chevron">
          <ChevronDownIcon size={14} />
        </span>
      </div>
      {expanded && <IssueExpandedBody issue={issue} />}
    </div>
  );
}

function VirtualizedIssueTimeline({ issues }: { issues: GithubIssue[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const items: IssueItem[] = buildDateGroupedItems(
    issues,
    (issue) => issue.updated_at ?? issue.created_at,
  );

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => items[i].kind === "header" ? 28 : 64,
    overscan: 5,
    measureElement: (el) => el?.getBoundingClientRect().height ?? 0,
  });

  const toggle = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  return (
    <div ref={parentRef} style={{ height: "100%", overflowY: "auto" }}>
      <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
        {rowVirtualizer.getVirtualItems().map((vRow) => {
          const item = items[vRow.index];
          return (
            <div
              key={vRow.key}
              data-index={vRow.index}
              ref={rowVirtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vRow.start}px)`,
              }}
            >
              {item.kind === "header" ? (
                <DayHeader label={item.label} />
              ) : (
                <IssueRow
                  issue={item.item}
                  expanded={expandedKeys.has(`${item.item.repo}#${item.item.number}`)}
                  onToggle={() => toggle(`${item.item.repo}#${item.item.number}`)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function IssueTimeline({ issues }: { issues: GithubIssue[] }) {
  if (issues.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "var(--text-muted)",
          fontSize: "var(--text-base)",
        }}
      >
        No issues.
      </div>
    );
  }

  if (typeof window === "undefined") {
    const items: IssueItem[] = buildDateGroupedItems(
      issues,
      (issue) => issue.updated_at ?? issue.created_at,
    );
    return (
      <div>
        {items.map((item, i) =>
          item.kind === "header" ? (
            <div key={item.key}>{item.label}</div>
          ) : (
            <IssueRow key={i} issue={item.item} expanded={false} onToggle={() => {}} />
          ),
        )}
      </div>
    );
  }

  return <VirtualizedIssueTimeline issues={issues} />;
}
