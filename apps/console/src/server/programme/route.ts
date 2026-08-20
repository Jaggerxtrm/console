// /api/programme — server-side Mercury programme read-model route.
// Each build is pinned to one exact programme commit, validates graph integrity,
// caches with TTL, and fails closed to a degraded last-good snapshot.

import { Hono } from "hono";
import { makeLogEntry } from "../../../../../packages/core/src/runtime/logs.ts";
import { makeSourceHealth, type SourceHealth } from "../../../../../packages/core/src/state/source-health.ts";
import type { ProgrammeChangeSet, ProgrammeSnapshot, ProgrammeSnapshotResponse, ProgrammeSourceHealth } from "../../types/programme.ts";
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
  /** Application-level exposure gate. Production composition must opt in. */
  readonly enabled?: boolean;
}

interface CacheEntry {
  snapshot: ProgrammeSnapshot;
  builtAt: number;
  lastError: string | null;
  lastErrorAt: number | null;
}

type Freshness = "fresh" | "stale" | "degraded";
type CompareWindow = "24h" | "7d" | "30d";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const WINDOW_MS: Record<CompareWindow, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};
const SHA_RE = /^[0-9a-f]{7,40}$/i;

function asObservable(source: ProgrammeSource): ObservableProgrammeSource {
  return source as ObservableProgrammeSource;
}

/** Restrict browser reads of private programme data to the Console origin. */
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
  /** Last different programme snapshot observed by this router process. */
  let previous: ProgrammeSnapshot | null = null;
  let inflight: Promise<CacheEntry> | null = null;

  async function buildSnapshotFrom(candidate: ProgrammeSource): Promise<ProgrammeSnapshot> {
    const observable = asObservable(candidate);
    const buildSource = observable.pin ? await observable.pin() : candidate;
    const snapshot = await buildProgrammeSnapshot(buildSource);
    const enriched = await enrichProgrammeSnapshot(snapshot, buildSource);
    const builtObservable = asObservable(buildSource);
    const swallowedSourceError = builtObservable.sourceError?.() ?? null;
    if (swallowedSourceError) throw new Error(`Programme source incomplete: ${swallowedSourceError}`);
    if (builtObservable.pinnedSha) {
      enriched.programme.sha = builtObservable.pinnedSha;
      enriched.programme.short_sha = builtObservable.pinnedSha.slice(0, 7);
    }
    enriched.provenance.current.programme_actor_registry = enriched.agents.length > 0;
    assertNoDanglingEdges(enriched.graph);
    return enriched;
  }

  async function build(): Promise<CacheEntry> {
    const startedAt = Date.now();
    const enriched = await buildSnapshotFrom(source);
    if (cache && cache.snapshot.programme.sha !== enriched.programme.sha) previous = cache.snapshot;
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
    if (cache && !force && now - cache.builtAt < ttlMs) return { entry: cache, freshness: classify(cache, "fresh") };
    if (cache && !force) {
      if (!inflight) {
        inflight = build()
          .then((next) => { cache = next; return next; })
          .catch((error) => withFailure(error, Date.now()))
          .finally(() => { inflight = null; });
      }
      return { entry: cache, freshness: classify(cache, "stale") };
    }
    if (!inflight) {
      inflight = build()
        .then((next) => { cache = next; return next; })
        .catch((error) => withFailure(error, Date.now()))
        .finally(() => { inflight = null; });
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

  async function snapshotAtRef(ref: string): Promise<ProgrammeSnapshot> {
    if (!SHA_RE.test(ref)) throw new Error("compare ref must be a 7-40 character hexadecimal commit SHA");
    const observable = asObservable(source);
    if (!observable.atRef) throw new Error("programme_history_unavailable");
    return buildSnapshotFrom(await observable.atRef(ref));
  }

  async function compareFromRef(from: string, current: ProgrammeSnapshot): Promise<ProgrammeChangeSet> {
    const baseline = await snapshotAtRef(from);
    return buildChangeSet(baseline, current);
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

  /** Previous different snapshot observed by this process. This is explicitly
   * not labelled browser "Last visit"; the client uses /compare for that. */
  app.get("/changes", async (c) => {
    if (!enabled) return c.json({ error: "programme_dashboard_disabled" }, 404);
    try {
      const { entry } = await getSnapshot(false);
      if (!previous) return c.json({ previous_sha: null, current_sha: entry.snapshot.programme.sha ?? null, generated_at: entry.snapshot.generated_at, entities: [], relation_count: 0 });
      return c.json(buildChangeSet(previous, entry.snapshot));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message, previous_sha: null, current_sha: null, generated_at: "", entities: [], relation_count: 0 }, 200);
    }
  });

  /** Truthful historical comparison. Supports an explicit source SHA or a
   * bounded time baseline. The target defaults to the exact current snapshot. */
  app.get("/compare", async (c) => {
    if (!enabled) return c.json({ error: "programme_dashboard_disabled" }, 404);
    try {
      const { entry } = await getSnapshot(false);
      const to = c.req.query("to");
      const current = to ? await snapshotAtRef(to) : entry.snapshot;
      const from = c.req.query("from");
      const window = c.req.query("window") as CompareWindow | undefined;

      if (from) return c.json(await compareFromRef(from, current));
      if (!window || !(window in WINDOW_MS)) return c.json({ error: "compare requires from=<sha> or window=24h|7d|30d" }, 400);

      const observable = asObservable(source);
      if (!observable.commitAtOrBefore) return c.json({ error: "programme_history_unavailable" }, 409);
      const cutoff = new Date(Date.now() - WINDOW_MS[window]).toISOString();
      const baselineCommit = await observable.commitAtOrBefore(cutoff);
      if (!baselineCommit) return c.json({ error: `no programme commit at or before ${cutoff}` }, 404);
      return c.json(await compareFromRef(baselineCommit.sha, current));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 400);
    }
  });

  /** Best-effort FILE history, constrained to source paths already admitted to
   * the current read model. Shared files are labelled with the requested
   * entity_key but are never represented as entity-level change history. */
  app.get("/revisions", async (c) => {
    if (!enabled) return c.json({ error: "programme_dashboard_disabled" }, 404);
    const path = c.req.query("path") ?? "";
    const entityKey = c.req.query("entity") ?? "";
    if (!path) return c.json({ error: "path required" }, 400);
    try {
      const { entry } = await getSnapshot(false);
      const matching = entityKey
        ? entry.snapshot.graph.nodes.find((node) => node.id === entityKey && node.source_path === path)
        : entry.snapshot.graph.nodes.find((node) => node.source_path === path);
      if (!matching) return c.json({ error: "path is not an admitted source for the requested programme entity" }, 404);

      const observable = asObservable(source);
      const exactSha = entry.snapshot.programme.sha;
      const historySource = exactSha && observable.atRef
        ? await observable.atRef(exactSha)
        : observable.pin ? await observable.pin() : source;
      const fn = historySource.recentCommitsForPath;
      if (!fn) return c.json({ entity_key: matching.id, path, revisions: [], current_revision_sha: null, previous_revision_sha: null });
      const fetchRevisions = async (candidatePath: string) => {
        const commits = await fn.call(historySource, candidatePath, 10);
        return commits.map((commit) => ({ sha: commit.sha, date: commit.date, subject: commit.subject, url: commit.url }));
      };
      const [history] = await buildRevisionHistory(entry.snapshot, [path], fetchRevisions, { [path]: matching.id });
      return c.json(history ?? { entity_key: matching.id, path, revisions: [], current_revision_sha: null, previous_revision_sha: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message, entity_key: entityKey || path, path, revisions: [], current_revision_sha: null, previous_revision_sha: null }, 200);
    }
  });

  return app;
}
