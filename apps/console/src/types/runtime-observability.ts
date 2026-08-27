import type { SpecialistJob } from "./specialists.ts";

export type RuntimeState =
  | "working"
  | "waiting_for_input"
  | "idle"
  | "completed"
  | "blocked"
  | "stale"
  | "unreachable"
  | "terminated"
  | "unknown";

export type RuntimeStateTone = "active" | "attention" | "idle" | "done" | "unknown";

export interface XtmuxAgentBinding {
  instance_id?: string | null;
  state?: string | null;
  bead_id?: string | null;
  task?: string | null;
  prompt_file?: string | null;
  parent_session_id?: string | null;
  parent_pane_id?: string | null;
  last_transition?: string | number | null;
  role?: string | null;
  worktree?: string | null;
  branch?: string | null;
  runtime?: string | null;
}

export interface XtmuxPane {
  pane_id: string;
  pane_index: number;
  active: boolean;
  width: number;
  height: number;
  left: number;
  top: number;
  pid: number;
  current_command: string;
  current_path: string;
  agent?: XtmuxAgentBinding | null;
}

export interface XtmuxWindow {
  window_id: string;
  window_index: number;
  name: string;
  active: boolean;
  panes: XtmuxPane[];
}

export interface XtmuxSession {
  session_id: string;
  name: string;
  created_at_ms: number;
  activity_at_ms: number;
  attached: boolean;
  active: boolean;
  windows: XtmuxWindow[];
}

export interface XtmuxTopology {
  schema_version?: string;
  generated_at_ms?: number;
  host?: { host_id?: string | null };
  sessions: XtmuxSession[];
}

export interface XtmuxJournalEvent {
  createdAtMs?: number;
  type?: string;
  domain?: string | null;
  eventKey?: string | null;
  sessionId?: string | null;
  paneId?: string | null;
  instanceId?: string | null;
  beadId?: string | null;
  correlationId?: string | null;
  [key: string]: unknown;
}

export interface RuntimeSourceHealth {
  status: "ok" | "degraded";
  latency_ms: number;
  error?: string;
}

export interface RuntimeOverviewResponse {
  schema_version: "xtrm.console.runtime-observability.v1";
  generated_at_ms: number;
  topology: XtmuxTopology | null;
  events: XtmuxJournalEvent[];
  source_health: {
    topology: RuntimeSourceHealth;
    journal: RuntimeSourceHealth;
  };
}

export type RuntimeEntityKind = "session" | "pane" | "specialist";

export interface RuntimeEntity {
  id: string;
  kind: RuntimeEntityKind;
  title: string;
  subtitle: string;
  state: RuntimeState;
  tone: RuntimeStateTone;
  sessionId?: string | null;
  sessionName?: string | null;
  paneId?: string | null;
  instanceId?: string | null;
  beadId?: string | null;
  role?: string | null;
  runtime?: string | null;
  command?: string | null;
  path?: string | null;
  worktree?: string | null;
  branch?: string | null;
  parentPaneId?: string | null;
  parentSessionId?: string | null;
  specialistJob?: SpecialistJob | null;
  chainId?: string | null;
  attached?: boolean;
  active?: boolean;
  paneCount?: number;
}

export type RuntimeRelationKind = "contains" | "dispatch" | "correlated";

export interface RuntimeRelation {
  id: string;
  source: string;
  target: string;
  kind: RuntimeRelationKind;
}

export interface RuntimeTimelineEvent {
  id: string;
  atMs: number;
  source: "xtmux" | "specialists";
  type: string;
  summary: string;
  sessionId?: string | null;
  paneId?: string | null;
  instanceId?: string | null;
  beadId?: string | null;
  chainId?: string | null;
  correlationId?: string | null;
  payload?: Record<string, unknown>;
}

export interface RuntimeSessionGroup {
  entity: RuntimeEntity;
  panes: RuntimeEntity[];
}

export interface RuntimeObservabilityModel {
  entities: RuntimeEntity[];
  relations: RuntimeRelation[];
  sessions: RuntimeSessionGroup[];
  unboundSpecialists: RuntimeEntity[];
  timeline: RuntimeTimelineEvent[];
  counts: {
    sessions: number;
    panes: number;
    agents: number;
    specialists: number;
    attention: number;
    stale: number;
  };
}
