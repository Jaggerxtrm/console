/**
 * KanbanBoard - secondary overview layout for bead issues
 */

import { useMemo, useState } from "react";
import type { Interaction, BeadIssue, BeadIssueDetail } from "../../../types/beads.ts";
import { StatusColumn } from "./StatusColumn";
import { IssueOverlay } from "./IssueOverlay.tsx";
import { substrateApi as api } from "../../lib/beads.ts";
import { logClientEvent } from "../../lib/client-log.ts";
import { NewIssueComposer } from "./inline/BeadInlineEdit.tsx";

import type { OpenPr } from "../../lib/beads.ts";

interface KanbanBoardProps {
  issues: BeadIssue[];
  projectId: string | null;
  interactions: Interaction[];
  getAgent?: (issueId: string) => string | null;
  prByIssueId?: Map<string, OpenPr>;
}

const COLUMNS: Array<{ status: BeadIssue["status"]; title: string; description: string }> = [
  { status: "in_progress", title: "In progress", description: "Active operator work" },
  { status: "open", title: "Ready", description: "Unblocked queue" },
  { status: "blocked", title: "Blocked", description: "Needs dependency cleared" },
  { status: "closed", title: "Closed", description: "Recently completed" },
];

export function KanbanBoard({ issues, projectId, interactions, getAgent, prByIssueId }: KanbanBoardProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BeadIssueDetail | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const issuesByStatus = COLUMNS.reduce((acc, col) => {
    acc[col.status] = issues
      .filter((issue) => issue.status === col.status)
      .sort((a, b) => {
        const priorityDiff = (a.priority ?? 99) - (b.priority ?? 99);
        if (priorityDiff !== 0) return priorityDiff;
        return b.updated_at.localeCompare(a.updated_at);
      });
    return acc;
  }, {} as Record<BeadIssue["status"], BeadIssue[]>);

  const issueById = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues]);

  async function openIssue(issue: BeadIssue) {
    setSelectedId(issue.id);
    setDetail(null);
    if (!projectId) return;
    setLoadingId(issue.id);
    try {
      const d = await api.getIssue(projectId, issue.id);
      setDetail(d ?? null);
    } catch (err) {
      console.error(err);
      setDetail(null);
    } finally {
      setLoadingId(null);
    }
  }

  async function createIssue(input: Parameters<typeof api.createIssue>[1]) {
    if (!projectId) return;
    const issue = await api.createIssue(projectId, input);
    logClientEvent("bead.create", { projectId, issueId: issue.id });
    window.dispatchEvent(new CustomEvent("beads:mutated", { detail: { projectId, issueId: issue.id } }));
    await openIssue(issue);
  }

  async function moveIssue(issue: BeadIssue, status: BeadIssue["status"]) {
    if (!projectId || status === issue.status) return;
    const next = await api.updateIssue(projectId, issue.id, { status });
    logClientEvent("bead.status", { projectId, issueId: issue.id, status });
    window.dispatchEvent(new CustomEvent("beads:mutated", { detail: { projectId, issueId: next.id } }));
  }

  const selectedIssue = selectedId ? issueById.get(selectedId) ?? null : null;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-primary)" }}>
      <div style={{ padding: "10px 12px 8px", borderBottom: "1px solid var(--border-subtle)", background: "var(--surface-secondary)" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h2 style={{ fontSize: "var(--header-font-size)", fontWeight: 750, letterSpacing: "0.08em", textTransform: "none", color: "var(--text-primary)", margin: 0 }}>Board overview</h2>
            <p style={{ margin: "4px 0 0", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>Secondary state map. Click a card for the full dossier.</p>
          </div>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)", padding: "3px 8px", background: "var(--surface-tertiary)" }}>{issues.length} issues</span>
        </div>
        {projectId ? <NewIssueComposer onCreate={createIssue} /> : null}
      </div>

      <div style={{ display: "flex", gap: 8, minHeight: 0, flex: 1, overflowX: "auto", padding: 10 }}>
        {COLUMNS.map((col) => (
          <StatusColumn
            key={col.status}
            title={col.title}
            description={col.description}
            status={col.status}
            issues={issuesByStatus[col.status] ?? []}
            getAgent={getAgent}
            selectedId={selectedId}
            onSelect={openIssue}
            prByIssueId={prByIssueId}
            onStatusChange={(issue, status) => void moveIssue(issue, status)}
          />
        ))}
      </div>

      {selectedIssue && (
        <IssueOverlay
          issue={selectedIssue}
          detail={detail}
          loading={loadingId === selectedIssue.id}
          projectId={projectId}
          issueById={issueById}
          onClose={() => { setSelectedId(null); setDetail(null); }}
        />
      )}
    </div>
  );
}
