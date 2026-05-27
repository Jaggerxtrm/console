import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { UnifiedScanner, type UnifiedSource } from "../../core/unified-scanner.ts";
import { canRefreshSources, createSourceRefreshState, formatSourceDisplayPath, isAllowedMutationRequest, isAllowedSourceKind, isLocalhost } from "./sources-policy.ts";

type SourceRow = { source_key: string; kind: string; path: string; origin: string; status: string; discovered_at: string | null; last_seen_at: string | null };
type SourceView = { source_key: string; kind: string; display_path: string; origin: string; status: string; discovered_at: string | null; last_seen_at: string | null };
type PinRequestBody = { path: string; kind: string };

const sourceRefreshState = createSourceRefreshState();

function buildSourceKey(kind: string, path: string): string {
  return `${kind}:${path}`;
}

function parseSourceRef(sourceKey: string): { kind: string; path: string } {
  const index = sourceKey.indexOf(":");
  if (index < 0) return { kind: "beads", path: sourceKey };
  return { kind: sourceKey.slice(0, index), path: sourceKey.slice(index + 1) };
}

function hasHistoricalData(xtrmDb: Database, sourceKey: string): boolean {
  const state = xtrmDb.query("SELECT 1 FROM materialization_state WHERE source_key = ? LIMIT 1").get(sourceKey);
  if (state) return true;
  const { kind, path } = parseSourceRef(sourceKey);
  if (kind === "beads") {
    const repoSlug = path.split(/[\\/]+/).pop() ?? path;
    return Boolean(xtrmDb.query("SELECT 1 FROM substrate_issues WHERE repo_slug = ? LIMIT 1").get(repoSlug) || xtrmDb.query("SELECT 1 FROM specialist_jobs WHERE bead_id = ? LIMIT 1").get(repoSlug));
  }
  if (kind === "observability") {
    return Boolean(xtrmDb.query("SELECT 1 FROM specialist_jobs WHERE chain_id = ? LIMIT 1").get(sourceKey));
  }
  return false;
}

function mapSourceRow(row: SourceRow): SourceView {
  return { source_key: row.source_key, kind: row.kind, display_path: formatSourceDisplayPath(row.path), origin: row.origin, status: row.status, discovered_at: row.discovered_at, last_seen_at: row.last_seen_at };
}

function getSourceRow(xtrmDb: Database, sourceKey: string): SourceRow | null {
  return xtrmDb.query("SELECT source_key, kind, path, origin, status, discovered_at, last_seen_at FROM sources WHERE source_key = ? LIMIT 1").get(sourceKey) as SourceRow | null;
}

function isMutableManualSource(row: SourceRow | null): boolean {
  return row?.origin === "manual";
}

export function createSourcesRouter(xtrmDb: Database | null, scanner: UnifiedScanner | null = null): Hono {
  const routes = new Hono();

  routes.get("/", async (c) => {
    if (!xtrmDb) return c.json({ sources: [] });
    if (scanner) return c.json({ sources: await scanner.getSources() });
    const sources = xtrmDb.query<SourceRow, []>("SELECT source_key, kind, path, origin, status, discovered_at, last_seen_at FROM sources ORDER BY kind ASC, source_key ASC").all();
    return c.json({ sources: sources.map(mapSourceRow) });
  });

  routes.post("/pin", async (c) => {
    if (!xtrmDb || !isAllowedMutationRequest(c.req.url, c.req.header("host") ?? "", c.req.header("origin") ?? null, c.req.header("x-gitboard-sources-admin-token") ?? null)) return c.json({ error: "forbidden" }, 403);
    const body = (await c.req.json<Partial<PinRequestBody>>().catch(() => null)) as Partial<PinRequestBody> | null;
    const path = body?.path?.trim();
    const kind = body?.kind?.trim();
    if (!path || !kind) return c.json({ error: "missing path or kind" }, 400);
    if (!isAllowedSourceKind(kind)) return c.json({ error: "invalid kind" }, 400);
    const sourceKey = buildSourceKey(kind, path);
    xtrmDb.query("INSERT INTO sources (source_key, kind, path, origin, status, discovered_at, last_seen_at) VALUES (?, ?, ?, 'manual', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(source_key) DO UPDATE SET kind=excluded.kind, path=excluded.path, origin='manual', status='active', last_seen_at=CURRENT_TIMESTAMP").run(sourceKey, kind, path);
    return c.json({ source_key: sourceKey, kind, display_path: formatSourceDisplayPath(path) });
  });

  routes.delete("/pin/:source_key", (c) => {
    if (!xtrmDb || !isAllowedMutationRequest(c.req.url, c.req.header("host") ?? "", c.req.header("origin") ?? null, c.req.header("x-gitboard-sources-admin-token") ?? null)) return c.json({ error: "forbidden" }, 403);
    const sourceKey = c.req.param("source_key");
    const row = getSourceRow(xtrmDb, sourceKey);
    if (!isMutableManualSource(row)) return c.json({ error: "source not manual" }, 409);
    if (hasHistoricalData(xtrmDb, sourceKey)) {
      xtrmDb.query("UPDATE sources SET status = 'unpinned' WHERE source_key = ? AND origin = 'manual'").run(sourceKey);
      return c.json({ source_key: sourceKey, status: "unpinned" });
    }
    xtrmDb.query("DELETE FROM sources WHERE source_key = ? AND origin = 'manual'").run(sourceKey);
    return c.json({ source_key: sourceKey, status: "deleted" });
  });

  routes.post("/refresh", async (c) => {
    if (!isAllowedMutationRequest(c.req.url, c.req.header("host") ?? "", c.req.header("origin") ?? null, c.req.header("x-gitboard-sources-admin-token") ?? null)) return c.json({ error: "forbidden" }, 403);
    if (!scanner) return c.json({ error: "sources refresh unavailable" }, 503);
    const gate = canRefreshSources(Date.now(), sourceRefreshState);
    if (!gate.ok) return c.json(gate.body, gate.status);
    const refreshPromise = scanner.refresh();
    sourceRefreshState.inFlight = refreshPromise as Promise<unknown>;
    try {
      const sources = (await refreshPromise) as UnifiedSource[];
      sourceRefreshState.lastCompletedAt = Date.now();
      return c.json({ refreshed: sources.length, sources: sources.map((source) => ({ source_key: source.sourceKey, kind: source.kind, display_path: formatSourceDisplayPath(source.path), status: source.status })) });
    } finally {
      sourceRefreshState.inFlight = null;
    }
  });

  return routes;
}

