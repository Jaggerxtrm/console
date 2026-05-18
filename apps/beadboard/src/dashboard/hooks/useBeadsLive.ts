import { useEffect } from "react";
import { useBeadsStore } from "../stores/beads.ts";
import type { BeadDependency, BeadIssue, Memory, ProjectSourceHealth } from "../../types/beads.ts";

type BeadsChangeEvent =
  | { event: "beads:issue.upsert"; projectId: string; source: string; version: string; data: { issue: BeadIssue } }
  | { event: "beads:issue.close"; projectId: string; source: string; version: string; data: { id?: string; issueId?: string } }
  | { event: "beads:issue.delete"; projectId: string; source: string; version: string; data: { id?: string; issueId?: string } }
  | { event: "beads:issue.deferred"; projectId: string; source: string; version: string; data: { issue?: BeadIssue; id?: string } }
  | { event: "beads:issue.superseded"; projectId: string; source: string; version: string; data: { issue?: BeadIssue; id?: string } }
  | { event: "beads:issue.flagged"; projectId: string; source: string; version: string; data: { issue?: BeadIssue; id?: string } }
  | { event: "beads:issue.unflagged"; projectId: string; source: string; version: string; data: { issue?: BeadIssue; id?: string } }
  | { event: "beads:dep.upsert"; projectId: string; source: string; version: string; data: { dep: BeadDependency } }
  | { event: "beads:dep.delete"; projectId: string; source: string; version: string; data: { id?: string } }
  | { event: "beads:memory.upsert"; projectId: string; source: string; version: string; data: { memory: Memory } }
  | { event: "beads:memory.delete"; projectId: string; source: string; version: string; data: { id?: string } }
  | { event: "beads:kv.upsert"; projectId: string; source: string; version: string; data: { key: string; value: unknown } }
  | { event: "beads:kv.delete"; projectId: string; source: string; version: string; data: { key?: string } }
  | { event: "beads:batch"; projectId: string; source: string; version: string; data: { issues?: BeadIssue[]; dependencies?: BeadDependency[]; memories?: Memory[]; kv?: Array<{ key: string; value: unknown; project_id: string }>; closes?: string[]; deletes?: string[] } }
  | { event: "beads:sync_hint"; projectId: string; source: string; version: string; data: { reason: string; scope?: string } }
  | { event: "beads:source_health"; projectId: string; source: string; version: string; data: { health: ProjectSourceHealth[] } };

export function useBeadsLive(): void {
  const selectedProjectId = useBeadsStore((state) => state.selectedProjectId);
  const upsertIssue = useBeadsStore((state) => state.upsertIssue);
  const moveToClosed = useBeadsStore((state) => state.moveToClosed);
  const removeIssue = useBeadsStore((state) => state.removeIssue);
  const applyBatch = useBeadsStore((state) => state.applyBatch);
  const applySyncHint = useBeadsStore((state) => state.applySyncHint);
  const setSourceHealth = useBeadsStore((state) => state.setSourceHealth);
  const upsertDep = useBeadsStore((state) => state.upsertDep);
  const removeDep = useBeadsStore((state) => state.removeDep);
  const upsertMemory = useBeadsStore((state) => state.upsertMemory);
  const removeMemory = useBeadsStore((state) => state.removeMemory);
  const upsertKv = useBeadsStore((state) => state.upsertKv);
  const removeKv = useBeadsStore((state) => state.removeKv);

  useEffect(() => {
    const ws = new WebSocket(new URL("/ws", window.location.origin).toString().replace(/^http/, "ws"));
    ws.onopen = () => ws.send(JSON.stringify({ action: "subscribe", channel: "beads:changes", version: "1" }));
    ws.onmessage = (event) => {
      let msg: BeadsChangeEvent;
      try { msg = JSON.parse(event.data as string) as BeadsChangeEvent; } catch { return; }
      if (msg.projectId !== selectedProjectId) return;
      switch (msg.event) {
        case "beads:issue.upsert": upsertIssue(msg.data.issue); break;
        case "beads:issue.close": moveToClosed(msg.data.issueId ?? msg.data.id ?? ""); break;
        case "beads:issue.delete": removeIssue(msg.data.issueId ?? msg.data.id ?? ""); break;
        case "beads:issue.deferred": if (msg.data.issue) upsertIssue(msg.data.issue); break;
        case "beads:issue.superseded": if (msg.data.issue) upsertIssue(msg.data.issue); break;
        case "beads:issue.flagged": if (msg.data.issue) upsertIssue(msg.data.issue); break;
        case "beads:issue.unflagged": if (msg.data.issue) upsertIssue(msg.data.issue); break;
        case "beads:dep.upsert": upsertDep(msg.data.dep); break;
        case "beads:dep.delete": removeDep(msg.data.id ?? ""); break;
        case "beads:memory.upsert": upsertMemory(msg.data.memory); break;
        case "beads:memory.delete": removeMemory(msg.data.id ?? ""); break;
        case "beads:kv.upsert": upsertKv({ key: msg.data.key, value: msg.data.value, project_id: msg.projectId }); break;
        case "beads:kv.delete": removeKv(msg.data.key ?? ""); break;
        case "beads:batch": applyBatch({ upserts: msg.data.issues, closes: msg.data.closes, deletes: msg.data.deletes, dependencies: msg.data.dependencies, memories: msg.data.memories, kv: msg.data.kv }); break;
        case "beads:sync_hint": applySyncHint(msg.projectId, msg.data.scope); break;
        case "beads:source_health": setSourceHealth(msg.projectId, msg.data.health); break;
      }
    };
    return () => ws.close();
  }, [applyBatch, applySyncHint, moveToClosed, removeDep, removeIssue, removeKv, removeMemory, selectedProjectId, setSourceHealth, upsertDep, upsertIssue, upsertKv, upsertMemory]);
}
