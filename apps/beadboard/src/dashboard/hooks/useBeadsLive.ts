import { useEffect } from "react";
import { useBeadsStore } from "../stores/beads.ts";
import type {
  BeadsBatch,
  BeadsDepDelete,
  BeadsDepUpsert,
  BeadsIssueClose,
  BeadsIssueDeferred,
  BeadsIssueDelete,
  BeadsIssueFlagged,
  BeadsIssueSuperseded,
  BeadsIssueUnflagged,
  BeadsIssueUpsert,
  BeadsKvDelete,
  BeadsKvUpsert,
  BeadsMemoryDelete,
  BeadsMemoryUpsert,
  BeadsRealtimeEvent,
  BeadsSourceHealth,
  BeadsSyncHint,
  RealtimeEnvelope,
} from "../../types/realtime.ts";

type BeadsChangeEnvelope = RealtimeEnvelope<
  BeadsRealtimeEvent,
  | BeadsIssueUpsert
  | BeadsIssueClose
  | BeadsIssueDelete
  | BeadsIssueDeferred
  | BeadsIssueSuperseded
  | BeadsIssueFlagged
  | BeadsIssueUnflagged
  | BeadsDepUpsert
  | BeadsDepDelete
  | BeadsMemoryUpsert
  | BeadsMemoryDelete
  | BeadsKvUpsert
  | BeadsKvDelete
  | BeadsBatch
  | BeadsSyncHint
  | BeadsSourceHealth
>;

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
      let msg: BeadsChangeEnvelope;
      try {
        msg = JSON.parse(event.data as string) as BeadsChangeEnvelope;
      } catch {
        return;
      }
      const projectId = "projectId" in msg.data ? msg.data.projectId : "project_id" in msg.data ? msg.data.project_id : undefined;
      if (!projectId || projectId !== selectedProjectId) return;
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
        case "beads:kv.upsert": upsertKv({ key: msg.data.key, value: msg.data.value, project_id: projectId }); break;
        case "beads:kv.delete": removeKv(msg.data.key ?? ""); break;
        case "beads:batch": applyBatch({ upserts: msg.data.issues, closes: msg.data.closes, deletes: msg.data.deletes, dependencies: msg.data.dependencies, memories: msg.data.memories, kv: msg.data.kv }); break;
        case "beads:sync_hint": applySyncHint(projectId, msg.data.scope); break;
        case "beads:source_health": setSourceHealth(projectId, [{ kind: msg.data.source as "dolt" | "sqlite" | "jsonl" | "unknown", state: msg.data.healthy === false ? "unhealthy" : "available", detail: msg.data.drift ? "drift" : undefined }]); break;
      }
    };
    return () => ws.close();
  }, [applyBatch, applySyncHint, moveToClosed, removeDep, removeIssue, removeKv, removeMemory, selectedProjectId, setSourceHealth, upsertDep, upsertIssue, upsertKv, upsertMemory]);
}
