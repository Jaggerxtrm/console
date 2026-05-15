import { useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { LinkExternalIcon, TagIcon, ChevronDownIcon } from "@primer/octicons-react";
import type { GithubRelease } from "../../../types/github.ts";
import {
  buildDateGroupedItems,
  formatRelativeTime,
  truncateBody,
  type DateGroupItem,
} from "../../lib/timeline-utils.ts";
import { renderPrBodyText } from "./PrTimeline.tsx";

type ReleaseItem = DateGroupItem<GithubRelease>;

function DayHeader({ label }: { label: string }) {
  return (
    <div className="release-day-header">
      {label}
    </div>
  );
}

function ReleaseExpandedBody({ release }: { release: GithubRelease }) {
  const [showMore, setShowMore] = useState(false);
  const body = release.body?.trim();

  if (!body) {
    return (
      <div className="release-expanded-body">
        {release.html_url && (
          <a href={release.html_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="release-link">
            <LinkExternalIcon size={12} />
            Open on GitHub
          </a>
        )}
      </div>
    );
  }

  const { visible, hasMore } = truncateBody(body);
  const rendered = renderPrBodyText(showMore ? body : visible);

  return (
    <div className="release-expanded-body">
      <div className="release-body-text">{rendered}</div>
      {hasMore && !showMore && (
        <button className="release-show-more" onClick={(e) => { e.stopPropagation(); setShowMore(true); }}>
          show more
        </button>
      )}
      {release.html_url && (
        <a href={release.html_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="release-link">
          <LinkExternalIcon size={12} />
          Open on GitHub
        </a>
      )}
    </div>
  );
}

function ReleaseRow({ release, expanded, onToggle }: { release: GithubRelease; expanded: boolean; onToggle: () => void; }) {
  const repoShort = release.repo_full_name.split("/")[1] ?? release.repo_full_name;
  const time = formatRelativeTime(release.published_at);

  return (
    <div className={`release-row ${expanded ? "is-expanded" : ""}`} onClick={onToggle}>
      <div className="release-row-main">
        <span className="release-row-icon">
          <TagIcon size={16} />
        </span>
        <span className="release-tag">{release.tag_name}</span>
        <span className="release-title">{release.name || release.tag_name}</span>
        <span className="release-repo">{repoShort}</span>
        <span className="release-actor">{release.author_login}</span>
        <span className="release-time">{time}</span>
        <span className="release-chevron" aria-hidden="true"><ChevronDownIcon size={14} /></span>
      </div>
      {expanded && <ReleaseExpandedBody release={release} />}
    </div>
  );
}

function VirtualizedReleaseTimeline({ releases }: { releases: GithubRelease[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const items: ReleaseItem[] = buildDateGroupedItems(releases, (release) => release.published_at);

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => items[i].kind === "header" ? 24 : 66,
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
    <div ref={parentRef} className="release-timeline" style={{ height: "100%", overflowY: "auto" }}>
      <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
        {rowVirtualizer.getVirtualItems().map((vRow) => {
          const item = items[vRow.index];
          return (
            <div key={vRow.key} data-index={vRow.index} ref={rowVirtualizer.measureElement} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vRow.start}px)` }}>
              {item.kind === "header" ? (
                <DayHeader label={item.label} />
              ) : (
                <ReleaseRow release={item.item} expanded={expandedKeys.has(item.item.id)} onToggle={() => toggle(item.item.id)} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ReleaseTimeline({ releases }: { releases: GithubRelease[] }) {
  if (releases.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)", fontSize: "var(--text-base)" }}>
        No releases.
      </div>
    );
  }

  if (typeof window === "undefined") {
    const items: ReleaseItem[] = buildDateGroupedItems(releases, (release) => release.published_at);
    return (
      <div>
        {items.map((item, i) => item.kind === "header" ? <DayHeader key={item.key} label={item.label} /> : <ReleaseRow key={i} release={item.item} expanded={false} onToggle={() => {}} />)}
      </div>
    );
  }

  return <VirtualizedReleaseTimeline releases={releases} />;
}
