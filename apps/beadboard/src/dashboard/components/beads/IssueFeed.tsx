/**
 * IssueFeed - primary inline issue feed with expandable dossiers
 */

import { useMemo, type ReactNode } from "react";
import { ChevronRightIcon, ChevronDownIcon, GitBranchIcon, LinkIcon, AlertIcon, IssueOpenedIcon, MilestoneIcon, NorthStarIcon, ProjectIcon, ToolsIcon, DependabotIcon } from "@primer/octicons-react";
import type { BeadDependency, BeadIssue, BeadIssueDetail } from "../../../types/beads.ts";

interface IssueFeedProps {
  issues: BeadIssue[];
  selectedIssueId: string | null;
  selectedIssueDetail: BeadIssueDetail | null;
  loadingDetailId: string | null;
  onIssueSelect: (issue: BeadIssue) => void;
  getAgent?: (issueId: string) => string | null;
}

const STATUS_LABELS: Record<string, string> = {
  in_progress: "In progress",
  open: "Ready",
  in_review: "In review",
  blocked: "Blocked",
  deferred: "Deferred",
  closed: "Closed",
};

const TYPE_LABELS: Record<string, string> = {
  bug: "Bug",
  feature: "Feature",
  task: "Task",
  epic: "Epic",
  chore: "Chore",
};

const TYPE_ICONS: Record<string, typeof IssueOpenedIcon> = {
  bug: IssueOpenedIcon,
  feature: NorthStarIcon,
  task: ProjectIcon,
  epic: MilestoneIcon,
  chore: ToolsIcon,
};

export function IssueFeed({ issues, selectedIssueId, selectedIssueDetail, loadingDetailId, onIssueSelect, getAgent }: IssueFeedProps) {
  const issueById = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues]);
  const epicChildren = useMemo(() => groupChildrenByEpic(issues), [issues]);
  const topLevelIssues = useMemo(() => issues.filter((issue) => !getEpicParentId(issue, issueById)), [issueById, issues]);

  return (
    <div className="bead-feed">
      <div className="module-list">
        {topLevelIssues.length === 0 ? (
          <EmptyFeed />
        ) : (
          topLevelIssues.map((issue) => {
            const children = epicChildren.get(issue.id) ?? [];
            return (
              <div key={issue.id}>
                <IssueRow
                  issue={issue}
                  detail={selectedIssueId === issue.id ? selectedIssueDetail : null}
                  isExpanded={selectedIssueId === issue.id}
                  isLoadingDetail={loadingDetailId === issue.id}
                  agent={getAgent?.(issue.id) ?? null}
                  dependencyCount={countDependencies(issue)}
                  childCount={children.length}
                  onClick={() => onIssueSelect(issue)}
                />
                {children.length > 0 && <EpicChildren issues={children} issueById={issueById} selectedIssueId={selectedIssueId} selectedIssueDetail={selectedIssueDetail} loadingDetailId={loadingDetailId} onIssueSelect={onIssueSelect} getAgent={getAgent} />}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function EpicChildren({ issues, issueById, selectedIssueId, selectedIssueDetail, loadingDetailId, onIssueSelect, getAgent }: { issues: BeadIssue[]; issueById: Map<string, BeadIssue>; selectedIssueId: string | null; selectedIssueDetail: BeadIssueDetail | null; loadingDetailId: string | null; onIssueSelect: (issue: BeadIssue) => void; getAgent?: (issueId: string) => string | null; }) {
  const sorted = [...issues].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  return <div className="epic-children">{sorted.map((issue) => <IssueRow key={issue.id} issue={issue} detail={selectedIssueId === issue.id ? selectedIssueDetail : null} isExpanded={selectedIssueId === issue.id} isLoadingDetail={loadingDetailId === issue.id} agent={getAgent?.(issue.id) ?? null} dependencyCount={countDependencies(issue)} childCount={groupChildrenByEpic(issues).get(issue.id)?.length ?? 0} onClick={() => onIssueSelect(issue)} isChild />)}</div>;
}

function IssueRow({ issue, detail, isExpanded, isLoadingDetail, agent, dependencyCount, childCount, onClick, isChild = false }: { issue: BeadIssue; detail: BeadIssueDetail | null; isExpanded: boolean; isLoadingDetail: boolean; agent: string | null; dependencyCount: number; childCount: number; onClick: () => void; isChild?: boolean; }) {
  const isEpic = issue.issue_type === "epic";
  const TypeIcon = TYPE_ICONS[issue.issue_type] ?? IssueOpenedIcon;

  return (
    <article className={`row ${issue.status} ${isEpic ? "epic" : ""} ${isExpanded ? "is-expanded" : ""} ${isChild ? "is-child" : ""}`}>
      <button type="button" className="row-main" onClick={onClick} aria-expanded={isExpanded} aria-controls={`issue-dossier-${issue.id}`}>
        <span className="rail" />
        <span className="id">{issue.id}</span>
        <span className="title-col">
          <span className="title">{issue.title}</span>
          <span className="meta">{issue.owner ?? "unassigned"}<span>{formatCompactDate(issue.updated_at)}</span>{childCount > 0 && <span>{childCount} children</span>}</span>
        </span>
        <span className="type-mark" title={TYPE_LABELS[issue.issue_type] ?? issue.issue_type}><TypeIcon size={13} /></span>
        <span className="meta-right"><span>{dependencyCount} deps</span>{agent && <span className="agent-badge"><DependabotIcon size={10} /> {agent}</span>}</span>
        <span className="state">{STATUS_LABELS[issue.status] ?? issue.status}</span>
        <span className="chev">{isExpanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}</span>
      </button>
      {isExpanded && <IssueDossier id={`issue-dossier-${issue.id}`} detail={detail} issue={issue} loading={isLoadingDetail} />}
    </article>
  );
}

function IssueDossier({ id, detail, issue, loading }: { id: string; detail: BeadIssueDetail | null; issue: BeadIssue; loading: boolean; }) {
  if (loading) return <div id={id} className="bead-expanded-body"><div className="bead-empty-note">Loading dossier...</div></div>;
  return <section id={id} className="bead-expanded-body"><div className="bead-expanded-grid"><DossierSection title="Description"><Markdown value={detail?.description ?? issue.description} empty="No description." /></DossierSection><DossierSection title="Notes"><Markdown value={detail?.notes ?? issue.notes} empty="No notes." /></DossierSection><DossierSection title="Metadata"><div className="bead-dossier-list"><span><b>Created</b><strong>{formatCompactDate(issue.created_at)}</strong></span><span><b>Updated</b><strong>{formatCompactDate(issue.updated_at)}</strong></span></div></DossierSection></div></section>;
}

function DossierSection({ title, children }: { title: string; children: ReactNode }) { return <section className="bead-expanded-section"><div className="bead-section-title">{title}</div>{children}</section>; }

function Markdown({ value, empty }: { value?: string | null; empty: string }) { if (!value?.trim()) return <div className="bead-empty-note">{empty}</div>; return <div className="bead-body-text">{parseMarkdown(value)}</div>; }

function parseMarkdown(value: string): ReactNode[] { return value.replace(/\r\n/g, "\n").split("\n").filter(Boolean).map((line, index) => <p key={index}>{stripHtml(line)}</p>); }

function stripHtml(value: string): string { return value.replace(/<[^>]*>/g, ""); }

function formatCompactDate(iso: string | undefined): string { if (!iso) return "—"; const date = new Date(iso); if (Number.isNaN(date.getTime())) return iso; return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }

function countDependencies(issue: BeadIssue): number { return issue.dependencies.filter((dependency) => dependency.dependency_type !== "parent-child").length; }

function groupChildrenByEpic(issues: BeadIssue[]): Map<string, BeadIssue[]> { const issueById = new Map(issues.map((issue) => [issue.id, issue])); const groups = new Map<string, BeadIssue[]>(); for (const issue of issues) { const parent = getEpicParentId(issue, issueById); if (!parent) continue; const list = groups.get(parent) ?? []; list.push(issue); groups.set(parent, list); } return groups; }

function getEpicParentId(issue: BeadIssue, issueById: Map<string, BeadIssue>): string | null { if (issue.parent_id && issueById.get(issue.parent_id)?.issue_type === "epic") return issue.parent_id; const parentDependency = issue.dependencies.find((dependency) => dependency.dependency_type === "parent-child" && issueById.get(dependency.id)?.issue_type === "epic"); return parentDependency?.id ?? null; }

function EmptyFeed() { return <div className="bead-empty-note">No issues</div>; }
