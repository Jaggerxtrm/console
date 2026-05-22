import type {
  BeadDependency,
  BeadIssue,
  BeadsProject,
  Interaction,
  Memory,
  ProjectSourceHealth,
} from "./beads.ts";
import type { GithubEvent, GithubIssue, GithubPr, GithubRelease } from "./github.ts";
import type { SourceHealth } from "./source-health.ts";

export const REALTIME_PROTOCOL_VERSION = 1;

export type RealtimeEnvelope<E extends string, D> = {
  type: "event";
  channel: string;
  event: E;
  seq: number;
  ts: string;
  version: string;
  boot_id: string;
  data: D;
};

export type GithubRealtimeEvent =
  | "github:pr.upsert"
  | "github:issue.upsert"
  | "github:event.append"
  | "github:release.upsert"
  | "github:sync_hint"
  | "github:source_health";

export type SystemRealtimeEvent = "system:log";
export type SystemLogPayload = import("./log.ts").LogEntry;

export type SpecialistsRealtimeEvent = "specialists:sync_hint";
export type SpecialistsSyncHint = { reason: string; repo_slug?: string; since_seq?: number };

export type BeadsRealtimeEvent =
  | "beads:issue.upsert"
  | "beads:issue.close"
  | "beads:issue.delete"
  | "beads:issue.deferred"
  | "beads:issue.superseded"
  | "beads:issue.flagged"
  | "beads:issue.unflagged"
  | "beads:dep.upsert"
  | "beads:dep.delete"
  | "beads:memory.upsert"
  | "beads:memory.delete"
  | "beads:kv.upsert"
  | "beads:kv.delete"
  | "beads:comment.append"
  | "beads:batch"
  | "beads:sync_hint"
  | "beads:source_health";

export type GithubPrUpsert = GithubPr;
export type GithubIssueUpsert = GithubIssue;
export type GithubEventAppend = GithubEvent;
export type GithubReleaseUpsert = GithubRelease;
export type GithubSyncHint = { reason: string; channel?: string; since_seq?: number };
export type GithubSourceHealth = SourceHealth & { source: "github"; rate_limit?: { limit: number; remaining: number; reset_at: string } };

export type BeadsIssueUpsert = BeadIssue;
export type BeadsIssueClose = Pick<BeadIssue, "id" | "project_id" | "closed_at" | "close_reason">;
export type BeadsIssueDelete = Pick<BeadIssue, "id" | "project_id">;
export type BeadsIssueDeferred = Pick<BeadIssue, "id" | "project_id">;
export type BeadsIssueSuperseded = Pick<BeadIssue, "id" | "project_id" | "parent_id">;
export type BeadsIssueFlagged = Pick<BeadIssue, "id" | "project_id" | "labels">;
export type BeadsIssueUnflagged = Pick<BeadIssue, "id" | "project_id" | "labels">;
export type BeadsDepUpsert = BeadDependency;
export type BeadsDepDelete = Pick<BeadDependency, "id">;
export type BeadsMemoryUpsert = Memory;
export type BeadsMemoryDelete = Pick<Memory, "id" | "project_id">;
export type BeadsKvUpsert = { key: string; value: unknown; project_id: string };
export type BeadsKvDelete = { key: string; project_id: string };
export type BeadsCommentAppend = Interaction;
export type BeadsBatch = {
  project_id: string;
  issues?: BeadIssue[];
  dependencies?: BeadDependency[];
  memories?: Memory[];
  kv?: Array<{ key: string; value: unknown; project_id: string }>;
  closes?: string[];
  deletes?: string[];
};
export type BeadsSyncHint = { reason: string; project_id?: string; since_seq?: number };
export type BeadsSourceHealth = { project: BeadsProject; health: ProjectSourceHealth[] };
