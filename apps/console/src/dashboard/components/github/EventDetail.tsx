import { useState } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { RepoIcon, GitBranchIcon, LinkExternalIcon, ChevronDownIcon } from "@primer/octicons-react";
import type { GithubEvent, GithubCommit } from "../../../../src/types/github.ts";

interface Props {
  event: GithubEvent | null;
  commits: GithubCommit[];
}

const EVENT_COLORS: Record<string, string> = {
  PushEvent: "var(--event-push)",
  PullRequestEvent: "var(--event-pr-open)",
  IssuesEvent: "var(--event-issue-open)",
  ReleaseEvent: "var(--event-release)",
  CreateEvent: "var(--event-branch)",
  WatchEvent: "var(--event-social)",
};

function getEventColor(type: string): string {
  return EVENT_COLORS[type] ?? "var(--text-muted)";
}

const BODY_LINE_CAP = 20;

function CommitRow({ commit }: { commit: GithubCommit }) {
  const [open, setOpen] = useState(false);
  const fullMsg = commit.message_full ?? commit.message;
  const lines = fullMsg.split("\n");
  const subject = lines[0];
  const bodyRaw = lines.slice(1).join("\n").trim();
  const bodyLines = bodyRaw.split("\n");
  const hasBody = bodyRaw.length > 0;
  const cappedBody = bodyLines.slice(0, BODY_LINE_CAP).join("\n");
  const overflow = bodyLines.length - BODY_LINE_CAP;

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} style={{ marginBottom: 8, fontSize: "var(--text-base)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <a
          href={commit.url ?? `https://github.com/${commit.repo}/commit/${commit.sha}`}
          target="_blank"
          rel="noreferrer"
          style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--accent-blue)", flexShrink: 0 }}
        >
          {commit.sha.slice(0, 7)}
        </a>
        <span style={{ color: "var(--text-primary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {subject}
        </span>
        {hasBody && (
          <Collapsible.Trigger style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: "var(--text-sm)", flexShrink: 0 }}>
            <span style={{ display: "inline-flex", transform: open ? "rotate(180deg)" : undefined, transition: "transform 0.15s" }}>
              <ChevronDownIcon size={11} />
            </span>
          </Collapsible.Trigger>
        )}
      </div>
      {hasBody && (
        <Collapsible.Content className="collapsible-content" style={{ overflow: "hidden" }}>
          <pre style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--text-secondary)",
            background: "var(--surface-tertiary)",
            borderRadius: "var(--radius-xs)",
            padding: "6px 8px",
            marginTop: 4,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}>
            {cappedBody}
          </pre>
          {overflow > 0 && (
            <span style={{ fontSize: "var(--text-xs)", color: "var(--accent-blue)", cursor: "pointer" }}>
              Show {overflow} more line{overflow !== 1 ? "s" : ""}
            </span>
          )}
        </Collapsible.Content>
      )}
    </Collapsible.Root>
  );
}

export function EventDetail({ event, commits }: Props) {
  if (!event) {
    return (
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        color: "var(--text-muted)",
        fontSize: "var(--text-base)",
        padding: "var(--spacing-md)",
      }}>
        Select an event to see details.
      </div>
    );
  }

  const eventColor = getEventColor(event.type);
  const hasStats = event.additions != null || event.deletions != null;
  const total = (event.additions ?? 0) + (event.deletions ?? 0);
  const addPct = total > 0 ? ((event.additions ?? 0) / total) * 100 : 0;
  const delPct = total > 0 ? ((event.deletions ?? 0) / total) * 100 : 0;

  return (
    <div className="console-event-detail" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Panel header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 16px",
        borderBottom: "1px solid var(--border-subtle)",
        flexShrink: 0,
        fontSize: "var(--text-sm)",
        color: "var(--text-secondary)",
      }}>
        <RepoIcon size={14} />
        <span>{event.repo}</span>
        {event.branch && (
          <>
            <span style={{ color: "var(--text-muted)" }}>/</span>
            <GitBranchIcon size={14} />
            <span>{event.branch}</span>
          </>
        )}
        {event.url && (
          <a
            href={`https://github.com/${event.repo}`}
            target="_blank"
            rel="noreferrer"
            style={{ marginLeft: "auto", color: "var(--text-muted)" }}
          >
            <LinkExternalIcon size={12} />
          </a>
        )}
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflow: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
        {/* Event title */}
        <div style={{ fontSize: "var(--text-md)", fontWeight: 600, color: "var(--text-primary)" }}>
          {event.title ?? event.type}
        </div>

        {/* Diffstat bar */}
        {hasStats && (
          <div>
            <div style={{
              height: 6,
              background: "var(--surface-tertiary)",
              borderRadius: "var(--radius-xs)",
              overflow: "hidden",
              display: "flex",
              marginBottom: 4,
            }}>
              <div style={{ width: `${addPct}%`, background: "var(--diff-add)" }} />
              <div style={{ width: `${delPct}%`, background: "var(--diff-del)" }} />
            </div>
            <div style={{ display: "flex", gap: 8, fontSize: "var(--text-sm)" }}>
              {event.additions != null && (
                <span style={{ color: "var(--diff-add)" }}>+{event.additions}</span>
              )}
              {event.deletions != null && (
                <span style={{ color: "var(--diff-del)" }}>−{event.deletions}</span>
              )}
              {event.changed_files != null && (
                <span style={{ color: "var(--text-muted)" }}>{event.changed_files} files</span>
              )}
            </div>
          </div>
        )}

        {/* Event body */}
        {event.body && (
          <div style={{
            background: "var(--surface-tertiary)",
            borderLeft: `3px solid ${eventColor}`,
            borderRadius: "var(--radius-sm)",
            padding: "8px 10px",
            fontSize: "var(--text-sm)",
            color: "var(--text-secondary)",
            whiteSpace: "pre-wrap",
          }}>
            {event.body}
          </div>
        )}

        {/* Commits section */}
        {commits.length > 0 && (
          <div>
            <div style={{
              fontSize: "var(--text-xs)",
              textTransform: "none",
              letterSpacing: "0.05em",
              color: "var(--text-muted)",
              marginBottom: 8,
            }}>
              Commits
            </div>
            {commits.map((commit) => (
              <CommitRow key={commit.sha} commit={commit} />
            ))}
          </div>
        )}

        {/* Open on GitHub */}
        {event.url && (
          <a
            href={event.url}
            target="_blank"
            rel="noreferrer"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              padding: "6px 10px",
              marginTop: "auto",
              background: "var(--surface-tertiary)",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius-md)",
              color: "var(--text-secondary)",
              fontSize: "var(--text-sm)",
              textDecoration: "none",
            }}
          >
            <LinkExternalIcon size={12} />
            View on GitHub
          </a>
        )}
      </div>
    </div>
  );
}
