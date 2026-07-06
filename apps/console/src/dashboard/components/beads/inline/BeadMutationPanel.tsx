import type { BeadIssue } from "../../../../types/beads.ts";
import { logClientEvent } from "../../../lib/client-log.ts";
import { substrateApi } from "../../../lib/beads.ts";
import { BeadAssigneeEditor, BeadDescriptionEditor, BeadLabelsEditor, BeadPriorityEditor, BeadStatusEditor, BeadTitleEditor, BeadTypeEditor, DeleteBeadButton } from "./BeadInlineEdit.tsx";

export function BeadMutationPanel({ projectId, issue, onIssueChange, onDeleted }: { projectId: string; issue: BeadIssue; onIssueChange?: (issue: BeadIssue) => void; onDeleted?: (issueId: string) => void }) {
  async function update(input: Parameters<typeof substrateApi.updateIssue>[2], action: string) {
    const next = await substrateApi.updateIssue(projectId, issue.id, input);
    logClientEvent(`bead.${action}`, { projectId, issueId: issue.id });
    onIssueChange?.(next);
    window.dispatchEvent(new CustomEvent("beads:mutated", { detail: { projectId, issueId: next.id } }));
  }
  return <section className="bead-mutation-panel" aria-label="Bead actions"><BeadTitleEditor id={issue.id} value={issue.title} onChange={(title) => update({ title }, "title")}/><BeadDescriptionEditor id={issue.id} value={issue.description ?? null} onChange={(description) => update({ description }, "description")}/><BeadPriorityEditor id={issue.id} value={issue.priority} onChange={(priority) => update({ priority }, "priority")}/><BeadStatusEditor id={issue.id} value={issue.status} onChange={(status) => update({ status }, "status")}/><BeadTypeEditor id={issue.id} value={String(issue.issue_type)} onChange={(type) => update({ type }, "type")}/><BeadAssigneeEditor id={issue.id} value={issue.assignee ?? null} onChange={(assignee) => update({ assignee }, "assignee")}/><BeadLabelsEditor id={issue.id} value={issue.labels ?? []} onChange={(set) => update({ labels: { set } }, "labels")}/><DeleteBeadButton id={issue.id} onDelete={async () => { await substrateApi.deleteIssue(projectId, issue.id); logClientEvent("bead.delete", { projectId, issueId: issue.id }); onDeleted?.(issue.id); window.dispatchEvent(new CustomEvent("beads:mutated", { detail: { projectId, issueId: issue.id } })); }}/></section>;
}
