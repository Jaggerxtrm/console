// /api/programme — server-side Mercury programme read-model route.
// Each build is pinned to one exact programme commit, validates graph integrity,
// caches with TTL, and fails closed to a degraded last-good snapshot.

import { Hono } from "hono";
import { makeLogEntry } from "../../../../../packages/core/src/runtime/logs.ts";
import { makeSourceHealth, type SourceHealth } from "../../../../../packages/core/src/state/source-health.ts";
import type { ProgrammeSnapshot, ProgrammeSnapshotResponse, ProgrammeSourceHealth } from "../../types/programme.ts";
import type { HostLogger } from "../log.ts";
import { assertNoDanglingEdges, buildProgrammeSnapshot, enrichProgrammeSnapshot } from "./read-model.ts";
import { createGithubProgrammeSource, type ObservableProgrammeSource } from "./source.ts";
import type { ProgrammeSource } from "./read-model.ts";

export interface ProgrammeRouteOptions {
  readonly logger?: HostLogger;
  readonly source?: ProgrammeSource;
  /** Snapshot TTL before a background refresh is attempted. */
  readonly cacheTtlMs?: number;
}

interface CacheEntry {
  snapshot: ProgrammeSnapshot;
  builtAt: number;
  lastError: string | null;
  lastErrorAt: number | null;
}

type Freshness = "fresh" | "stale" | "degraded";

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function asObservable(source: ProgrammeSource): ObservableProgrammeSource {
  return source as ObservableProgrammeSource;
}

export function createProgrammeRouter(options: ProgrammeRouteOptions = {}): Hono {
  const app = new Hono();
  const logger = options.logger;
  const source = options.source ?? createGithubProgrammeSource();
  const ttlMs = options.cacheTtlMs ?? DEFAULT_TTL_MS;

  const emit = (event: string, level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}) => {
    logger?.emit(makeLogEntry("api", event, level, message, fields));
  };

  let cache: CacheEntry | null = null;
  let inflight: Promise<CacheEntry> | null = null;

  async function build(): Promise<CacheEntry> {
    const startedAt = Date.now();
    const observable = asObservable(source);
    const buildSource = observable.pin ? await observable.pin() : source;
    const snapshot = await buildProgrammeSnapshot(buildSource);
    const enriched = await enrichProgrammeSnapshot(snapshot, buildSource);
    const builtObservable = asObservable(buildSource);
    const swallowedSourceError = builtObservable.sourceError?.() ?? null;
    if (swallowedSourceError) throw new Error(`Programme source incomplete: ${swallowedSourceError}`);
    if (builtObservable.pinnedSha) {
      enriched.programme.sha = builtObservable.pinnedSha;
      enriched.programme.short_sha = builtObservable.pinnedSha.slice(0, 7);
    }
    // Hosted source availability differs from the hermetic builder: never claim
    // an actor registry when no registry actors were actually materialized.
    enriched.provenance.current.programme_actor_registry = enriched.agents.length > 0;
    assertNoDanglingEdges(enriched.graph);
    const entry: CacheEntry = { snapshot: enriched, builtAt: startedAt, lastError: null, lastErrorAt: null };
    emit("programme.snapshot.built", "info", "programme snapshot built", {
      ms: Date.now() - startedAt,
      programmeSha: enriched.programme.sha,
      workstreams: enriched.workstreams.length,
      assignments: enriched.assignments.length,
      nodes: enriched.graph.nodes.length,
      edges: enriched.graph.edges.length,
    });
    return entry;
  }

  function withFailure(error: unknown, now: number): CacheEntry {
    const message = error instanceof Error ? error.message : String(error);
    const next: CacheEntry = cache
      ? { ...cache, lastError: message, lastErrorAt: now }
      : { snapshot: emptySnapshot(), builtAt: now, lastError: message, lastErrorAt: now };
    cache = next;
    return next;
  }

  function classify(entry: CacheEntry, healthy: Exclude<Freshness, "degraded">): Freshness {
    return entry.lastError ? "degraded" : healthy;
  }

  async function getSnapshot(force = false): Promise<{ entry: CacheEntry; freshness: Freshness }> {
    const now = Date.now();
    if (cache && !force && now - cache.builtAt < ttlMs) {
      return { entry: cache, freshness: classify(cache, "fresh") };
    }
    if (cache && !force) {
      // Stale: try a background refresh; serve the last-good copy meanwhile.
      if (!inflight) {
        inflight = build()
          .then((next) => {
            cache = next;
            return next;
          })
          .catch((error) => withFailure(error, Date.now()))
          .finally(() => {
            inflight = null;
          });
      }
      return { entry: cache, freshness: classify(cache, "stale") };
    }
    if (!inflight) {
      inflight = build()
        .then((next) => {
          cache = next;
          return next;
        })
        .catch((error) => withFailure(error, Date.now()))
        .finally(() => {
          inflight = null;
        });
    }
    const entry = await inflight;
    return { entry, freshness: classify(entry, "fresh") };
  }

  function sourceHealth(entry: CacheEntry, freshness: Freshness): ProgrammeSourceHealth {
    const status = freshness === "degraded" ? "degraded" : freshness === "stale" ? "stale" : "fresh";
    return makeSourceHealth("programme", status, {
      checked_at: new Date().toISOString(),
      message: entry.lastError ?? undefined,
      metadata: {
        built_at: new Date(entry.builtAt).toISOString(),
        ...(entry.lastErrorAt ? { last_error_at: new Date(entry.lastErrorAt).toISOString() } : {}),
      },
    });
  }

  app.get("/", async (c) => {
    const force = c.req.query("refresh") === "true";
    try {
      const { entry, freshness } = await getSnapshot(force);
      const response: ProgrammeSnapshotResponse = {
        snapshot: entry.snapshot,
        freshness,
        source_health: sourceHealth(entry, freshness),
        error: entry.lastError,
      };
      return c.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit("programme.snapshot.error", "error", message);
      const degraded: ProgrammeSnapshotResponse = {
        snapshot: cache?.snapshot ?? null,
        freshness: "degraded",
        source_health: makeSourceHealth("programme", "degraded", { message }) as SourceHealth,
        error: message,
      };
      return c.json(degraded, 200);
    }
  });

  return app;
}

function emptySnapshot(): ProgrammeSnapshot {
  return {
    schema_version: 3,
    generated_at: new Date().toISOString(),
    programme: { repository: "mercuryintelligence/program", branch: "master", sha: null, short_sha: null },
    now: { title: "", evidence_cutoff: null, path: "NOW.md" },
    business: {},
    workstreams: [],
    assignments: [],
    research: [],
    decisions: [],
    proposals: [],
    agents: [],
    jira_refs: [],
    operator_input_refs: [],
    activity: [],
    graph: { nodes: [], edges: [], metadata_fields: [], identity_collisions: [] },
    identity_collisions: [],
    evidence_boundary: {},
    state_records: [],
    journals: [],
    publication_facts: [],
    state_history_semantics: {
      current_state_precedence: "",
      journal_authority: "",
      publication_separation: "",
      unsafe_nested_relationship_policy: "",
      suppressed_unsafe_nested_edges: 0,
    },
    provenance: { current: { programme_actor_registry: false, state_actor_assignment_fields: false, wrapper_publication_facts: false, xtrm_mutation_receipts: false }, rules: [], live_receipt_gate: "" },
    source_health: makeSourceHealth("programme", "degraded", { message: "snapshot unavailable" }),
  };
}
