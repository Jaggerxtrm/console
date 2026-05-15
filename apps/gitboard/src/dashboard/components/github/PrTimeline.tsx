import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  GitPullRequestIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  ChevronDownIcon,
  LinkExternalIcon,
  CommentIcon,
  FileDiffIcon,
  FileIcon,
  TagIcon,
  LinkIcon,
  IssueOpenedIcon,
} from "@primer/octicons-react";
import type { GithubPr, GithubPrDetail } from "../../../types/github.ts";
import { apiClient } from "../../lib/client.ts";
import {
  buildDateGroupedItems,
  formatRelativeTime,
  parseLabels,
  truncateBody,
  type DateGroupItem,
} from "../../lib/timeline-utils.ts";

type PrItem = DateGroupItem<GithubPr>;

type PrStateTone = "open" | "merged" | "closed";

function prStateStyle(state: string): { Icon: React.ElementType; color: string; tone: PrStateTone; label: string } {
  if (state === "merged") {
    return { Icon: GitMergeIcon, color: "var(--accent-purple)", tone: "merged", label: "MERGED" };
  }
  if (state === "closed") {
    return { Icon: GitPullRequestClosedIcon, color: "var(--accent-red)", tone: "closed", label: "CLOSED · NOT MERGED" };
  }
  return { Icon: GitPullRequestIcon, color: "var(--accent-blue)", tone: "open", label: "OPEN" };
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function stateTimestamp(pr: GithubPr): string {
  if (pr.state === "merged") return `Merged ${formatRelativeTime(pr.merged_at ?? pr.updated_at ?? pr.created_at)}`;
  if (pr.state === "closed") return `Closed unmerged ${formatRelativeTime(pr.closed_at ?? pr.updated_at ?? pr.created_at)}`;
  return `Updated ${formatRelativeTime(pr.updated_at ?? pr.created_at)}`;
}

function DayHeader({ label }: { label: string }) {
  return (
    <div className="pr-day-header">
      {label}
    </div>
  );
}

function LabelChip({ name }: { name: string }) {
  return <span className="pr-label-chip">{name}</span>;
}

function PrStatePill({ pr }: { pr: GithubPr }) {
  const { tone, label } = prStateStyle(pr.state);
  return <span className={`pr-state-pill ${tone}`}>{label}</span>;
}

type ConversationItemKind = "body" | "comment" | "review" | "commit" | "event";

type ConversationItem = {
  id: string;
  kind: ConversationItemKind;
  actor: string;
  label: string;
  body?: string | null;
  url?: string | null;
  created_at: string;
};

function buildConversation(pr: GithubPr, detail: GithubPrDetail | null): ConversationItem[] {
  const items: ConversationItem[] = [];
  if (pr.body?.trim()) {
    items.push({
      id: "body",
      kind: "body",
      actor: pr.author,
      label: "opened this pull request",
      body: pr.body.trim(),
      url: pr.url,
      created_at: pr.created_at,
    });
  }

  for (const comment of detail?.comments ?? []) {
    items.push({
      id: `comment-${comment.id}`,
      kind: "comment",
      actor: comment.author,
      label: "commented",
      body: comment.body,
      url: comment.url,
      created_at: comment.created_at,
    });
  }

  for (const review of detail?.reviews ?? []) {
    items.push({
      id: `review-${review.id}`,
      kind: "review",
      actor: review.author,
      label: `reviewed · ${review.state.replaceAll("_", " ").toLowerCase()}`,
      body: review.body,
      url: review.url,
      created_at: review.submitted_at ?? pr.updated_at ?? pr.created_at,
    });
  }

  for (const reviewComment of detail?.review_comments ?? []) {
    items.push({
      id: `review-comment-${reviewComment.id}`,
      kind: "review",
      actor: reviewComment.author,
      label: `commented on ${reviewComment.path ?? "diff"}${reviewComment.line ? `:${reviewComment.line}` : ""}`,
      body: reviewComment.body,
      url: reviewComment.url,
      created_at: reviewComment.created_at,
    });
  }

  for (const commit of detail?.commits ?? []) {
    items.push({
      id: `commit-${commit.sha}`,
      kind: "commit",
      actor: commit.author,
      label: `committed ${commit.sha.slice(0, 7)}`,
      body: commit.message,
      url: commit.url,
      created_at: commit.committed_at,
    });
  }

  if (detail?.files.length) {
    items.push({
      id: "files-summary",
      kind: "event",
      actor: "github",
      label: `changed ${detail.files.length} file${detail.files.length === 1 ? "" : "s"}`,
      body: detail.files.slice(0, 20).map((file) => `${file.status} ${file.filename} (+${file.additions}/−${file.deletions})`).join("\n"),
      created_at: pr.updated_at ?? pr.created_at,
    });
  }

  for (const event of detail?.timeline ?? []) {
    if (["commented", "reviewed", "committed"].includes(event.event)) continue;
    items.push({
      id: `event-${event.id}`,
      kind: "event",
      actor: event.actor ?? "github",
      label: event.event.replaceAll("_", " "),
      body: event.body ?? event.commit_id ?? event.state ?? null,
      url: event.url ?? null,
      created_at: event.created_at,
    });
  }

  return items.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

function extractLinkedBeads(body: string | null | undefined): string[] {
  if (!body) return [];
  return [...new Set((body.match(/\bforge-[a-z0-9-]+\b/gi) ?? []).map((id) => id.toLowerCase()))];
}

function getConversationIcon(kind: ConversationItemKind): typeof CommentIcon {
  switch (kind) {
    case "body":
      return IssueOpenedIcon;
    case "comment":
      return CommentIcon;
    case "review":
      return TagIcon;
    case "commit":
      return FileIcon;
    case "event":
      return LinkIcon;
    default:
      return CommentIcon;
  }
}

function SectionLabel({ icon: Icon, title, status }: { icon: typeof CommentIcon; title: string; status?: string }) {
  return (
    <div className="pr-section-label">
      <span className="pr-section-label-icon"><Icon size={11} /></span>
      <span className="pr-section-label-title">{title}</span>
      {status && <span className="pr-section-label-status">{status}</span>}
    </div>
  );
}

export function renderPrBodyText(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = value
    .replace(/<\/?details[^>]*>/gi, "\n")
    .replace(/<summary[^>]*>/gi, "\n### ")
    .replace(/<\/summary>/gi, "\n")
    .replace(/<h[1-4][^>]*>/gi, "\n### ")
    .replace(/<\/h[1-4]>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/blockquote>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .split("\n");

  let paragraph: string[] = [];
  let listItems: ReactNode[] = [];

  const renderInline = (line: string, key: string): ReactNode => {
    const pattern = /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)|`([^`]+)`|\*\*([^*\n]+)\*\*|(?<![*\w])\*([^*\n]+)\*(?!\*)/g;
    const parts: ReactNode[] = [];
    let lastIndex = 0;
    for (const match of line.matchAll(pattern)) {
      if (match.index === undefined) continue;
      if (match.index > lastIndex) parts.push(line.slice(lastIndex, match.index));
      if (match[1] && match[2]) {
        parts.push(<a key={`${key}-link-${match.index}`} href={match[2]} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{match[1]}</a>);
      } else if (match[3]) {
        parts.push(<code key={`${key}-code-${match.index}`}>{match[3]}</code>);
      } else if (match[4]) {
        parts.push(<strong key={`${key}-b-${match.index}`}>{match[4]}</strong>);
      } else if (match[5]) {
        parts.push(<em key={`${key}-i-${match.index}`}>{match[5]}</em>);
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < line.length) parts.push(line.slice(lastIndex));
    return parts.length > 0 ? parts : line;
  };

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    nodes.push(<p key={`p-${nodes.length}`}>{paragraph.map((line, index) => <span key={index}>{renderInline(line, `p-${nodes.length}-${index}`)}{index < paragraph.length - 1 ? <br /> : null}</span>)}</p>);
    paragraph = [];
  };

  const flushList = () => {
    if (listItems.length === 0) return;
    nodes.push(<ul key={`ul-${nodes.length}`}>{listItems}</ul>);
    listItems = [];
  };

  const parseTableCells = (row: string): string[] =>
    row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Fenced code block ``` or ~~~
    const fence = /^(```|~~~)\s*([\w-]*)\s*$/.exec(trimmed);
    if (fence) {
      flushParagraph();
      flushList();
      const lang = fence[2] || "";
      const code: string[] = [];
      i++;
      while (i < lines.length && !new RegExp("^" + fence[1] + "\\s*$").test(lines[i].trim())) {
        code.push(lines[i]);
        i++;
      }
      i++;
      nodes.push(
        <pre key={`pre-${nodes.length}`} data-lang={lang} className={`rich-code${lang ? ` rich-code-${lang}` : ""}`}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Markdown table: header row + separator + data rows
    const isTableRow = /^\|.*\|$/.test(trimmed);
    const nextIsSeparator = i + 1 < lines.length && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1].trim());
    if (isTableRow && nextIsSeparator) {
      flushParagraph();
      flushList();
      const headers = parseTableCells(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        rows.push(parseTableCells(lines[i].trim()));
        i++;
      }
      nodes.push(
        <table key={`tbl-${nodes.length}`} className="rich-table">
          <thead>
            <tr>
              {headers.map((h, ci) => <th key={ci}>{renderInline(h, `th-${ci}`)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => <td key={ci}>{renderInline(c, `td-${ri}-${ci}`)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      i++;
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      nodes.push(<h3 key={`h-${i}`}>{renderInline(heading[2], `h-${i}`)}</h3>);
      i++;
      continue;
    }

    const list = /^[-*]\s+(.+)$/.exec(trimmed);
    if (list) {
      flushParagraph();
      listItems.push(<li key={`li-${i}`}>{renderInline(list[1], `li-${i}`)}</li>);
      i++;
      continue;
    }

    flushList();
    paragraph.push(line);
    i++;
  }

  flushParagraph();
  flushList();
  return nodes.length > 0 ? nodes : [value];
}

function RichPrBody({ body }: { body: string }) {
  return <div className="pr-rich-text">{renderPrBodyText(body)}</div>;
}

function ConversationEntry({ item }: { item: ConversationItem }) {
  const [showMore, setShowMore] = useState(false);
  const Icon = getConversationIcon(item.kind);
  const body = item.body?.trim();
  const display = body ? truncateBody(body, item.kind === "body" ? 1800 : 900) : null;

  return (
    <article className={`pr-conversation-entry ${item.kind}`}>
      <div className="pr-entry-marker"><Icon size={11} /></div>
      <div className="pr-entry-main">
        <div className="pr-entry-header">
          <strong>{item.actor}</strong>
          <span>{item.label}</span>
          <time>{formatDateTime(item.created_at)}</time>
          {item.url && <a href={item.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex", alignItems: "center" }}><LinkExternalIcon size={12} /></a>}
        </div>
        {display && (
          <div>
            <div className="pr-body-text"><RichPrBody body={showMore ? body : display.visible} /></div>
            {display.hasMore && !showMore && (
              <button className="pr-show-more" onClick={(e) => { e.stopPropagation(); setShowMore(true); }}>
                show full text
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function PrExpandedBody({ pr }: { pr: GithubPr }) {
  const labels = parseLabels(pr.label_names);
  const hasDiff = pr.additions != null || pr.deletions != null || pr.changed_files != null;
  const [detail, setDetail] = useState<GithubPrDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    const [owner, repoName] = pr.repo.split("/");
    if (!owner || !repoName) return;
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    apiClient.getPrDetail(owner, repoName, pr.number)
      .then((data) => { if (!cancelled) setDetail(data); })
      .catch((err) => { if (!cancelled) setDetailError(err instanceof Error ? err.message : "Failed to load PR detail"); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [pr.repo, pr.number]);

  const conversation = useMemo(() => buildConversation(pr, detail), [pr, detail]);
  const files = detail?.files ?? [];
  const linkedBeads = useMemo(() => extractLinkedBeads([pr.body, ...(detail?.timeline ?? []).map((event) => event.body ?? "")].filter(Boolean).join("\n")), [pr.body, detail]);

  return (
    <div className="pr-expanded-body">
      <div className="pr-compact-summary">
        <div className="pr-summary-line">
          <span><b>Author</b>{pr.author}</span>
          <span><b>Comments</b>{detail?.comments.length ?? pr.comment_count}</span>
          <span><b>Reviews</b>{detail ? detail.reviews.length + detail.review_comments.length : "—"}</span>
          <span><b>Commits</b>{detail?.commits.length ?? "—"}</span>
          <span><b>Files</b>{files.length > 0 ? files.length : pr.changed_files ?? "—"}</span>
        </div>
        {hasDiff && (
          <div className="pr-summary-line pr-summary-diff">
            <span><b>Repository</b>{pr.repo}</span>
            <span><b>Files</b>{pr.changed_files ?? "—"}</span>
            <span><b>Additions</b><strong className="is-add">+{pr.additions ?? 0}</strong></span>
            <span><b>Deletions</b><strong className="is-del">−{pr.deletions ?? 0}</strong></span>
          </div>
        )}
      </div>

      {labels.length > 0 && (
        <div className="pr-label-row">
          {labels.map((name) => <LabelChip key={name} name={name} />)}
        </div>
      )}

      <section className="pr-section">
        <SectionLabel icon={CommentIcon} title="Conversation" status={detailLoading ? "hydrating GitHub detail…" : detailError ? detailError : detail?.errors && Object.keys(detail.errors).length > 0 ? `${conversation.length} events · partial GitHub data` : `${conversation.length} events`} />
        {pr.url && (
          <a href={pr.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <LinkExternalIcon size={12} />
            Open on GitHub
          </a>
        )}
        {conversation.length > 0 ? (
          <div className="pr-conversation-thread">
            {conversation.map((item) => <ConversationEntry item={item} key={item.id} />)}
          </div>
        ) : (
          <div className="pr-empty-note">No PR conversation detail available yet.</div>
        )}
      </section>

      <section className="pr-section">
        <SectionLabel icon={FileDiffIcon} title="Files" status={files.length ? `${files.length} files` : "no file detail"} />
        {files.length > 0 ? (
          <div className="pr-file-list">
            {files.map((file) => (
              <div className="pr-file-row" key={file.filename}>
                <span className={`pr-file-status ${file.status}`}>{file.status}</span>
                <span className="pr-file-path">{file.filename}</span>
                <span className="pr-file-diff"><span className="is-add">+{file.additions ?? 0}</span><span className="is-del">−{file.deletions ?? 0}</span></span>
              </div>
            ))}
          </div>
        ) : (
          <div className="pr-empty-note">No file detail available yet.</div>
        )}
      </section>

      {linkedBeads.length > 0 && (
        <section className="pr-section">
          <SectionLabel icon={LinkIcon} title="Linked beads" status={`${linkedBeads.length} linked`} />
          <div className="pr-linked-beads">
            {linkedBeads.map((id) => <span key={id} className="pr-linked-bead">{id}</span>)}
          </div>
        </section>
      )}
    </div>
  );
}

function PrRow({
  pr,
  expanded,
  onToggle,
}: {
  pr: GithubPr;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { Icon, color, tone } = prStateStyle(pr.state);
  const repoShort = pr.repo.split("/")[1] ?? pr.repo;
  const time = stateTimestamp(pr);
  const labels = parseLabels(pr.label_names);

  return (
    <div
      className={`pr-row ${expanded ? "is-expanded" : ""} ${tone}`}
      onClick={onToggle}
    >
      <div className="pr-row-main">
        <span className="pr-row-icon" style={{ color }}>
          <Icon size={16} />
        </span>
        <span className="pr-number">#{pr.number}</span>
        <div className="pr-title-block">
          <div className="pr-title-line">
            <span className="pr-title">{pr.title}</span>
            {labels.slice(0, 2).map((name) => <LabelChip key={name} name={name} />)}
          </div>
          <div className="pr-meta-line">
            <span>{repoShort}</span>
            <span>{pr.author}</span>
            <span>{time}</span>
            {pr.comment_count > 0 && <span>{pr.comment_count} comments</span>}
          </div>
        </div>
        <PrStatePill pr={pr} />
        <span className="pr-row-diff">
          {pr.changed_files != null && <em>{pr.changed_files} files</em>}
          {pr.additions != null && <b className="is-add">+{pr.additions}</b>}
          {pr.deletions != null && <b className="is-del">−{pr.deletions}</b>}
        </span>
        <span className="pr-chevron" aria-hidden="true">
          <ChevronDownIcon size={14} />
        </span>
      </div>
      {expanded && <PrExpandedBody pr={pr} />}
    </div>
  );
}

function VirtualizedPrTimeline({ prs }: { prs: GithubPr[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const items: PrItem[] = buildDateGroupedItems(prs, (pr) => pr.updated_at ?? pr.created_at);

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
    <div ref={parentRef} className="pr-timeline" style={{ height: "100%", overflowY: "auto" }}>
      <div
        style={{
          height: rowVirtualizer.getTotalSize(),
          position: "relative",
        }}
      >
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
                <PrRow
                  pr={item.item}
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

export function PrTimeline({ prs }: { prs: GithubPr[] }) {
  if (prs.length === 0) {
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
        No pull requests.
      </div>
    );
  }

  if (typeof window === "undefined") {
    const items: PrItem[] = buildDateGroupedItems(prs, (pr) => pr.updated_at ?? pr.created_at);
    return (
      <div>
        {items.map((item, i) =>
          item.kind === "header" ? (
            <DayHeader key={item.key} label={item.label} />
          ) : (
            <PrRow key={i} pr={item.item} expanded={false} onToggle={() => {}} />
          ),
        )}
      </div>
    );
  }

  return <VirtualizedPrTimeline prs={prs} />;
}
