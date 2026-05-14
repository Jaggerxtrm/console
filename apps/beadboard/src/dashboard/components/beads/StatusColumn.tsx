/**
 * StatusColumn - Kanban column for issues of a specific status
 */

import { AlertIcon, CheckCircleIcon, CircleIcon, DotFillIcon, PlayIcon, ChevronDownIcon, GitBranchIcon, LinkExternalIcon, CommentDiscussionIcon } from "@primer/octicons-react";
import { useMemo, useState, type ReactNode } from "react";
import type { Interaction, BeadIssue, BeadIssueDetail } from "../../../types/beads.ts";
import { api } from "../../lib/api.ts";
import { BeadCard } from "./BeadCard";

interface StatusColumnProps {
  title: string;
  description?: string;
  status: BeadIssue["status"];
  issues: BeadIssue[];
  projectId: string | null;
  interactions: Interaction[];
  getAgent?: (issueId: string) => string | null;
}

const STATUS_CONFIG: Record<string, { color: string; icon: typeof CircleIcon }> = {
  open: { color: "var(--status-open)", icon: CircleIcon },
  in_progress: { color: "var(--accent-blue)", icon: PlayIcon },
  blocked: { color: "var(--status-blocked)", icon: AlertIcon },
  in_review: { color: "var(--accent-purple)", icon: DotFillIcon },
  closed: { color: "var(--status-closed)", icon: CheckCircleIcon },
};

export function StatusColumn({ title, description, status, issues, projectId, interactions, getAgent }: StatusColumnProps) {
  const config = STATUS_CONFIG[String(status)] ?? { color: "var(--text-muted)", icon: CircleIcon };
  const StatusIcon = config.icon;
  const epicCount = issues.filter((issue) => issue.issue_type === "epic").length;
  const [expandedIssueId, setExpandedIssueId] = useState<string | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<BeadIssueDetail | null>(null);
  const [loadingIssueId, setLoadingIssueId] = useState<string | null>(null);

  const interactionsByIssue = useMemo(() => groupInteractions(interactions), [interactions]);

  async function toggleIssue(issue: BeadIssue) {
    if (expandedIssueId === issue.id) {
      setExpandedIssueId(null);
      setExpandedDetail(null);
      return;
    }
    if (!projectId) {
      setExpandedIssueId(issue.id);
      setExpandedDetail(null);
      return;
    }

    setExpandedIssueId(issue.id);
    setExpandedDetail(null);
    setLoadingIssueId(issue.id);
    try {
      const detail = await api.getIssue(projectId, issue.id);
      setExpandedDetail(detail ?? null);
    } catch (error) {
      console.error(error);
      setExpandedDetail(null);
    } finally {
      setLoadingIssueId(null);
    }
  }

  return (
    <section style={{ display: "flex", flexDirection: "column", minWidth: 292, maxWidth: 336, background: "var(--surface-secondary)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-subtle)", overflow: "hidden" }}>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-subtle)", background: "var(--surface-secondary)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: config.color, display: "inline-flex", lineHeight: 0 }}><StatusIcon size={14} /></span>
          <h3 style={{ fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "0.02em" }}>{title}</h3>
          <span style={{ marginLeft: "auto", fontSize: "var(--text-xs)", color: "var(--text-primary)", background: "var(--surface-tertiary)", border: "1px solid var(--border-subtle)", padding: "2px 7px", borderRadius: "var(--radius-sm)" }}>{issues.length}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
          <span>{description ?? "Issue lane"}</span>
          {epicCount > 0 && <span style={{ marginLeft: "auto", color: "var(--accent-purple)", fontWeight: 700 }}>Epic {epicCount}</span>}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: 10, display: "flex", flexDirection: "column", gap: 9 }}>
        {issues.length === 0 ? (
          <div style={{ padding: "24px 10px", textAlign: "center", color: "var(--text-muted)", fontSize: "var(--text-sm)", border: "1px dashed var(--border-subtle)", borderRadius: "var(--radius-sm)", background: "var(--surface-primary)" }}>No issues in lane</div>
        ) : (
          issues.map((issue) => {
            const isExpanded = expandedIssueId === issue.id;
            return (
              <div key={issue.id} style={{ display: "grid", gap: 8 }}>
                <BeadCard issue={issue} onClick={() => void toggleIssue(issue)} agent={getAgent?.(issue.id)} isExpanded={isExpanded} />
                {isExpanded && (
                  <BeadDossier
                    issue={issue}
                    detail={expandedDetail}
                    loading={loadingIssueId === issue.id}
                    interactions={interactionsByIssue.get(issue.id) ?? []}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

function BeadDossier({ issue, detail, loading, interactions }: { issue: BeadIssue; detail: BeadIssueDetail | null; loading: boolean; interactions: Interaction[]; }) {
  const dependencies = detail?.dependencies ?? issue.dependencies;
  const children = detail?.children ?? [];
  const agent = interactions[0]?.model ?? interactions[0]?.actor ?? null;

  return (
    <section style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)", background: "var(--surface-primary)", padding: 10, display: "grid", gap: 10 }}>
      {loading ? <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>Loading dossier...</div> : null}
      <DossierBlock title="Description">
        <SafeMarkdown value={detail?.description ?? issue.description} empty="No description." />
      </DossierBlock>
      <DossierList title="Dependencies" items={dependencies} empty="No deps." />
      <DossierList title="Children" items={children} empty="No children." />
      <DossierBlock title="Agent">
        {agent ? <span style={{ color: "var(--text-primary)" }}>{agent}</span> : <span style={{ color: "var(--text-muted)" }}>No agent.</span>}
      </DossierBlock>
      <DossierBlock title="Activity">
        {interactions.length === 0 ? <span style={{ color: "var(--text-muted)" }}>No comments loaded.</span> : <div style={{ display: "grid", gap: 6 }}>{interactions.slice(0, 4).map((interaction) => <div key={`${interaction.id}-${interaction.created_at}`} style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-secondary)", fontSize: "var(--text-xs)" }}><CommentDiscussionIcon size={12} />{interaction.kind} · {interaction.actor}{interaction.model ? ` · ${interaction.model}` : ""}</div>)}</div>}
      </DossierBlock>
      {detail ? <div style={{ display: "flex", justifyContent: "flex-end", color: "var(--text-muted)", fontSize: "var(--text-xs)" }}><LinkExternalIcon size={12} />&nbsp;detail loaded</div> : null}
    </section>
  );
}

function DossierBlock({ title, children }: { title: string; children: ReactNode }) {
  return <section style={{ display: "grid", gap: 6 }}><div style={{ fontSize: "var(--text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", fontWeight: 750 }}>{title}</div>{children}</section>;
}

function DossierList({ title, items, empty }: { title: string; items: Array<{ id: string; title: string; status: string; dependency_type: string }>; empty: string; }) {
  return <DossierBlock title={title}>{items.length === 0 ? <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{empty}</div> : <div style={{ display: "grid", gap: 6 }}>{items.map((item) => <div key={`${title}-${item.id}-${item.dependency_type}`} style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-secondary)", fontSize: "var(--text-xs)" }}><GitBranchIcon size={12} />{item.id}<span style={{ color: "var(--text-muted)" }}>{item.title || "Untitled issue"}</span></div>)}</div>}</DossierBlock>;
}

function SafeMarkdown({ value, empty }: { value?: string | null; empty: string }) {
  if (!value?.trim()) return <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{empty}</div>;
  return <div style={{ display: "grid", gap: 6 }}>{parseMarkdown(value)}</div>;
}

function parseMarkdown(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    nodes.push(<p key={index} style={{ margin: 0, color: "var(--text-secondary)", fontSize: "var(--text-sm)", lineHeight: 1.5 }}>{renderInlineMarkdown(trimmed)}</p>);
  }
  return nodes;
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^\)]+\))/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index} style={{ background: "var(--surface-tertiary)", borderRadius: 4, padding: "1px 4px", color: "var(--text-primary)" }}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index} style={{ color: "var(--text-primary)" }}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={index} style={{ color: "var(--text-primary)" }}>{part.slice(1, -1)}</em>;
    const link = part.match(/^\[([^\]]+)\]\(([^\)]+)\)$/);
    if (link) {
      const href = safeHref(link[2]);
      return <a key={index} href={href} target="_blank" rel="noreferrer" style={{ color: "var(--accent-blue)" }}>{link[1]}</a>;
    }
    return stripHtml(part);
  });
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

function safeHref(value: string): string {
  try {
    const url = new URL(value, "https://example.com");
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? value : "#";
  } catch {
    return "#";
  }
}

function groupInteractions(interactions: Interaction[]): Map<string, Interaction[]> {
  return interactions.reduce((map, interaction) => {
    const list = map.get(interaction.issue_id) ?? [];
    list.push(interaction);
    map.set(interaction.issue_id, list);
    return map;
  }, new Map<string, Interaction[]>());
}
