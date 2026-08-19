import type { ChainSummary } from "../../../hooks/useChains.ts";
import type {
  RuntimeEntity,
  RuntimeObservabilityModel,
  RuntimeOverviewResponse,
  RuntimeRelation,
  RuntimeState,
  RuntimeStateTone,
  RuntimeTimelineEvent,
  XtmuxJournalEvent,
  XtmuxPane,
  XtmuxSession,
} from "../../../../types/runtime-observability.ts";
import type { SpecialistJob } from "../../../../types/specialists.ts";

export function buildRuntimeObservabilityModel(
  overview: RuntimeOverviewResponse | null,
  chains: ChainSummary[],
): RuntimeObservabilityModel {
  const sessions = overview?.topology?.sessions ?? [];
  const jobs = chains.flatMap((chain) => chain.jobs);
  const entities: RuntimeEntity[] = [];
  const relations: RuntimeRelation[] = [];
  const sessionGroups: RuntimeObservabilityModel["sessions"] = [];
  const paneIds = new Set<string>();
  const sessionIds = new Set<string>();
  const assignedJobs = new Set<string>();

  for (const session of sessions) {
    const sessionEntity = makeSessionEntity(session);
    entities.push(sessionEntity);
    sessionIds.add(session.session_id);

    const panes = flattenPanes(session).map((pane) => {
      paneIds.add(pane.pane_id);
      const specialistJob = findSpecialistJob(pane, jobs, assignedJobs);
      if (specialistJob) assignedJobs.add(jobKey(specialistJob));
      const entity = makePaneEntity(session, pane, specialistJob);
      entities.push(entity);
      relations.push({
        id: `contains:${session.session_id}:${pane.pane_id}`,
        source: sessionEntity.id,
        target: entity.id,
        kind: "contains",
      });
      return entity;
    });

    sessionGroups.push({ entity: sessionEntity, panes });
  }

  for (const group of sessionGroups) {
    for (const pane of group.panes) {
      if (pane.parentPaneId && paneIds.has(pane.parentPaneId)) {
        relations.push({
          id: `dispatch:pane:${pane.parentPaneId}:${pane.paneId}`,
          source: `pane:${pane.parentPaneId}`,
          target: pane.id,
          kind: "dispatch",
        });
      } else if (pane.parentSessionId && sessionIds.has(pane.parentSessionId)) {
        relations.push({
          id: `dispatch:session:${pane.parentSessionId}:${pane.paneId}`,
          source: `session:${pane.parentSessionId}`,
          target: pane.id,
          kind: "dispatch",
        });
      }
    }
  }

  const unboundSpecialists = jobs
    .filter((job) => !assignedJobs.has(jobKey(job)))
    .map((job, index) => makeSpecialistEntity(job, index));
  entities.push(...unboundSpecialists);

  const timeline = [
    ...(overview?.events ?? []).map(makeRuntimeEvent),
    ...jobs.map(makeSpecialistEvent),
  ].sort((a, b) => b.atMs - a.atMs);

  const paneEntities = entities.filter((entity) => entity.kind === "pane");
  return {
    entities,
    relations,
    sessions: sessionGroups,
    unboundSpecialists,
    timeline,
    counts: {
      sessions: sessionGroups.length,
      panes: paneEntities.length,
      agents: paneEntities.filter((entity) => Boolean(entity.instanceId || entity.role)).length,
      specialists: jobs.length,
      attention: paneEntities.filter((entity) => entity.tone === "attention").length,
      stale: paneEntities.filter((entity) => entity.state === "stale" || entity.state === "unreachable").length,
    },
  };
}

export function normalizeRuntimeState(raw: string | null | undefined): RuntimeState {
  switch ((raw ?? "").trim().toLowerCase().replace(/[ -]/g, "_")) {
    case "running":
    case "working":
    case "busy":
    case "streaming":
    case "starting":
      return "working";
    case "needs_input":
    case "waiting":
    case "waiting_for_input":
      return "waiting_for_input";
    case "idle":
    case "ready":
      return "idle";
    case "done":
    case "completed":
    case "success":
      return "completed";
    case "blocked":
    case "error":
    case "failed":
      return "blocked";
    case "stale":
      return "stale";
    case "unreachable":
    case "disconnected":
      return "unreachable";
    case "off":
    case "terminated":
    case "ended":
      return "terminated";
    default:
      return "unknown";
  }
}

export function runtimeStateTone(state: RuntimeState): RuntimeStateTone {
  if (state === "working") return "active";
  if (state === "waiting_for_input" || state === "blocked" || state === "stale" || state === "unreachable") return "attention";
  if (state === "idle") return "idle";
  if (state === "completed" || state === "terminated") return "done";
  return "unknown";
}

export function relatedEvents(model: RuntimeObservabilityModel, entity: RuntimeEntity, limit = 12): RuntimeTimelineEvent[] {
  return model.timeline.filter((event) => {
    if (entity.paneId && event.paneId === entity.paneId) return true;
    if (entity.instanceId && event.instanceId === entity.instanceId) return true;
    if (entity.beadId && event.beadId === entity.beadId) return true;
    if (entity.sessionId && entity.kind === "session" && event.sessionId === entity.sessionId) return true;
    if (entity.chainId && event.chainId === entity.chainId) return true;
    return false;
  }).slice(0, limit);
}

function makeSessionEntity(session: XtmuxSession): RuntimeEntity {
  const paneCount = flattenPanes(session).length;
  return {
    id: `session:${session.session_id}`,
    kind: "session",
    title: session.name,
    subtitle: `${paneCount} pane${paneCount === 1 ? "" : "s"}${session.attached ? " · attached" : ""}`,
    state: session.active ? "working" : "idle",
    tone: session.active ? "active" : "idle",
    sessionId: session.session_id,
    sessionName: session.name,
    attached: session.attached,
    active: session.active,
    paneCount,
  };
}

function makePaneEntity(session: XtmuxSession, pane: XtmuxPane, specialistJob: SpecialistJob | null): RuntimeEntity {
  const state = normalizeRuntimeState(pane.agent?.state ?? specialistJob?.status);
  const role = pane.agent?.role ?? specialistJob?.specialist ?? specialistJob?.chainKind ?? null;
  const runtime = pane.agent?.runtime ?? inferRuntime(pane.current_command);
  return {
    id: `pane:${pane.pane_id}`,
    kind: "pane",
    title: role || runtime || pane.current_command || pane.pane_id,
    subtitle: `${session.name} · ${pane.pane_id}`,
    state,
    tone: runtimeStateTone(state),
    sessionId: session.session_id,
    sessionName: session.name,
    paneId: pane.pane_id,
    instanceId: pane.agent?.instance_id ?? null,
    beadId: pane.agent?.bead_id ?? specialistJob?.beadId ?? null,
    role,
    runtime,
    command: pane.current_command,
    path: pane.current_path,
    worktree: pane.agent?.worktree ?? null,
    branch: pane.agent?.branch ?? null,
    parentPaneId: pane.agent?.parent_pane_id ?? null,
    parentSessionId: pane.agent?.parent_session_id ?? null,
    specialistJob,
    chainId: specialistJob?.chainId ?? null,
    active: pane.active,
  };
}

function makeSpecialistEntity(job: SpecialistJob, index: number): RuntimeEntity {
  const state = normalizeRuntimeState(job.status);
  const role = job.specialist ?? job.chainKind ?? "specialist";
  return {
    id: `specialist:${jobKey(job)}:${index}`,
    kind: "specialist",
    title: role,
    subtitle: `${job.beadId} · workflow only`,
    state,
    tone: runtimeStateTone(state),
    beadId: job.beadId,
    role,
    specialistJob: job,
    chainId: job.chainId,
  };
}

function findSpecialistJob(pane: XtmuxPane, jobs: SpecialistJob[], assigned: Set<string>): SpecialistJob | null {
  const beadId = pane.agent?.bead_id;
  if (!beadId) return null;
  const candidates = jobs.filter((job) => job.beadId === beadId && !assigned.has(jobKey(job)));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  const role = normalizeRole(pane.agent?.role);
  if (!role) return null;
  return candidates.find((job) => normalizeRole(job.specialist ?? job.chainKind) === role) ?? null;
}

function flattenPanes(session: XtmuxSession): XtmuxPane[] {
  return session.windows.flatMap((window) => window.panes ?? []);
}

function jobKey(job: SpecialistJob): string {
  return job.jobId ?? `${job.chainId ?? "no-chain"}:${job.beadId}:${job.specialist ?? job.chainKind ?? "unknown"}:${job.updatedAt}`;
}

function normalizeRole(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/^specialist[:-]?/, "");
}

function inferRuntime(command: string): string | null {
  const normalized = command.toLowerCase();
  if (normalized.includes("claude")) return "claude";
  if (normalized === "pi" || normalized.includes("pi-coding-agent")) return "pi";
  if (normalized.includes("codex")) return "codex";
  return command || null;
}

function makeRuntimeEvent(event: XtmuxJournalEvent, index: number): RuntimeTimelineEvent {
  const payload = compactPayload(event);
  return {
    id: String(event.eventKey ?? `xtmux:${event.createdAtMs ?? 0}:${index}`),
    atMs: Number(event.createdAtMs ?? 0),
    source: "xtmux",
    type: String(event.type ?? "runtime.event"),
    summary: summarizePayload(payload),
    sessionId: asString(event.sessionId),
    paneId: asString(event.paneId),
    instanceId: asString(event.instanceId),
    beadId: asString(event.beadId),
    correlationId: asString(event.correlationId),
    payload,
  };
}

function makeSpecialistEvent(job: SpecialistJob, index: number): RuntimeTimelineEvent {
  const role = job.specialist ?? job.chainKind ?? "specialist";
  return {
    id: `specialists:${jobKey(job)}:${index}`,
    atMs: safeDateMs(job.updatedAt),
    source: "specialists",
    type: `specialist.${job.status}`,
    summary: `${role} · ${job.beadId}${job.lastOutput ? ` · ${excerpt(job.lastOutput)}` : ""}`,
    beadId: job.beadId,
    chainId: job.chainId,
    payload: {
      job_id: job.jobId,
      repo_slug: job.repoSlug,
      model: job.model,
      turns: job.turns,
      tools: job.tools,
    },
  };
}

function compactPayload(event: XtmuxJournalEvent): Record<string, unknown> {
  const envelopeKeys = new Set(["createdAtMs", "type", "domain", "eventKey", "sessionId", "paneId", "instanceId", "beadId", "correlationId"]);
  return Object.fromEntries(Object.entries(event).filter(([key]) => !envelopeKeys.has(key)));
}

function summarizePayload(payload: Record<string, unknown>): string {
  for (const key of ["summary", "message", "state", "reason", "task", "result", "status"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return excerpt(value);
  }
  const entries = Object.entries(payload).filter(([, value]) => value !== null && value !== undefined).slice(0, 3);
  if (entries.length === 0) return "runtime journal event";
  return entries.map(([key, value]) => `${key}=${excerpt(String(value), 48)}`).join(" · ");
}

function excerpt(value: string, max = 104): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeDateMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
