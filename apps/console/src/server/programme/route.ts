// /api/programme — server-side Mercury programme read-model route.
// Each build is pinned to one exact programme commit, validates graph integrity,
// caches with TTL, and fails closed to a degraded last-good snapshot.

import { Hono } from "hono";
import { makeLogEntry } from "../../../../../packages/core/src/runtime/logs.ts";
import { makeSourceHealth, type SourceHealth } from "../../../../../packages/core/src/state/source-health.ts";
import type { ProgrammeSnapshot, ProgrammeSnapshotResponse, ProgrammeSourceHealth } from "../../types/programme.ts";
import type { HostLogger } from "../log.ts";
import { assertNoDanglingEdges, buildProgrammeSnapshot, enrichProgrammeSnapshot } from "./read-model.ts";
import { buildChangeSet, buildRevisionHistory, summaryFrom } from "./changes.ts";
import { createGithubProgrammeSource, type ObservableProgrammeSource } from "./source.ts";
import type { ProgrammeSource } from "./read-model.ts";

export interface ProgrammeRouteOptions {
  readonly logger?: HostLogger;
  readonly source?: ProgrammeSource;
  /** Snapshot TTL before a background refresh is attempted. */
  readonly cacheTtlMs?: number;
  /**
   * Application-level exposure gate. Focused tests/default standalone routers
   * remain enabled; the production composition root must opt in explicitly.
   */
  readonly enabled?: boolean;
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

/** Restrict browser reads of private programme data to the Console origin.
 * Requests without Origin are governed separately by the deployment/network
 * boundary; this function exists specifically to prevent cross-origin browser
 * exfiltration when the route is enabled. */
export function isAllowedProgrammeOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    const protocolOk = parsed.protocol === "http:" || parsed.protocol === "https:";
    return protocolOk && parsed.host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

export function createProgrammeRouter(options: ProgrammeRouteOptions = {}): Hono {
  const app = new Hono();
  const logger = options.logger;
  const source = options.source ?? createGithubProgrammeSource();
  const ttlMs = options.cacheTtlMs ?? DEFAULT_TTL_MS;
  const enabled = options.enabled ?? true;

  const emit = (event: string, level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}) => {
    logger?.emit(makeLogEntry("api", event, level, message, fields));
  };

  let cache: CacheEntry | null = null;
  let previous: ProgrammeSnapshot | null = null;
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
    previous = cache?.snapshot ?? null;
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
    // With no prior good snapshot, propagate to the route so callers receive
    // snapshot:null. An empty synthetic snapshot would be ambiguous with a real
    // programme containing zero work.
    if (!cache) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const next: CacheEntry = { ...cache, lastError: message, lastErrorAt: now };
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
    if (!enabled) {
      emit("programme.dashboard.disabled", "warn", "programme dashboard route is disabled by deployment policy");
      return c.json({ error: "programme_dashboard_disabled" }, 404);
    }

    const force = c.req.query("refresh") === "true";
    try {
      const { entry, freshness } = await getSnapshot(force);
      const changeSet = previous ? buildChangeSet(previous, entry.snapshot) : null;
      const response: ProgrammeSnapshotResponse = {
        snapshot: entry.snapshot,
        freshness,
        source_health: sourceHealth(entry, freshness),
        error: entry.lastError,
        changes_summary: changeSet ? summaryFrom(changeSet) : null,
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

  app.get("/changes", async (c) => {
    if (!enabled) return c.json({ error: "programme_dashboard_disabled" }, 404);
    try {
      const { entry, freshness } = await getSnapshot(false);
      void freshness;
      if (!previous) {
        return c.json({ previous_sha: null, current_sha: entry.snapshot.programme.sha ?? null, generated_at: entry.snapshot.generated_at, entities: [], relation_count: 0 });
      }
      const changeSet = buildChangeSet(previous, entry.snapshot);
      return c.json(changeSet);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message, previous_sha: null, current_sha: null, generated_at: "", entities: [], relation_count: 0 }, 200);
    }
  });

  app.get("/revisions", async (c) => {
    if (!enabled) return c.json({ error: "programme_dashboard_disabled" }, 404);
    const path = c.req.query("path") ?? "";
    if (!path) return c.json({ error: "path required" }, 400);
    try {
      const { entry } = await getSnapshot(false);
      const observable = asObservable(source);
      const buildSource = observable.pin ? await observable.pin() : source;
      const fetchRevisions = async (p: string) => {
        const fn = buildSource.recentCommitsForPath;
        if (!fn) return [];
        const commits = await fn.call(buildSource, p, 10);
        return commits.map((c2) => ({ sha: c2.sha, date: c2.date, subject: c2.subject, url: c2.url }));
      };
      const [history] = await buildRevisionHistory(entry.snapshot, [path], fetchRevisions);
      return c.json(history ?? { entity_key: path, path, revisions: [], current_revision_sha: null, previous_revision_sha: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message, entity_key: path, path, revisions: [], current_revision_sha: null, previous_revision_sha: null }, 200);
    }
  });

  return app;
}
