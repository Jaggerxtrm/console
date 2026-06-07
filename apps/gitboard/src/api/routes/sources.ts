import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { UnifiedScanner, type UnifiedSource } from "../../core/unified-scanner.ts";
import { canRefreshSources, createSourceRefreshState, formatSourceDisplayPath, isAllowedMutationRequest, isAllowedSourceKind, isLocalhost } from "./sources-policy.ts";
import {
  buildSourceKey as coreBuildSourceKey,
  getSourceRow as coreGetSourceRow,
  isMutableManualSource as coreIsMutableManualSource,
  listSources as coreListSources,
  pinSource as corePinSource,
  unpinSource as coreUnpinSource,
  type SourceRow,
} from "../../../../../packages/core/src/state/index.ts";

type SourceView = { source_key: string; kind: string; display_path: string; origin: string; status: string; discovered_at: string | null; last_seen_at: string | null };
type PinRequestBody = { path: string; kind: string };

const sourceRefreshState = createSourceRefreshState();

function mapSourceRow(row: SourceRow): SourceView {
  return { source_key: row.source_key, kind: row.kind, display_path: formatSourceDisplayPath(row.path), origin: row.origin, status: row.status, discovered_at: row.discovered_at, last_seen_at: row.last_seen_at };
}

export function createSourcesRouter(xtrmDb: Database | null, scanner: UnifiedScanner | null = null): Hono {
  const routes = new Hono();

  routes.get("/", async (c) => {
    if (!xtrmDb) return c.json({ sources: [] });
    if (scanner) return c.json({ sources: await scanner.getSources() });
    const sources = coreListSources(xtrmDb);
    return c.json({ sources: sources.map(mapSourceRow) });
  });

  routes.post("/pin", async (c) => {
    if (!xtrmDb || !isAllowedMutationRequest(c.req.url, c.req.header("host") ?? "", c.req.header("origin") ?? null, c.req.header("x-gitboard-sources-admin-token") ?? null)) return c.json({ error: "forbidden" }, 403);
    const body = (await c.req.json<Partial<PinRequestBody>>().catch(() => null)) as Partial<PinRequestBody> | null;
    const path = body?.path?.trim();
    const kind = body?.kind?.trim();
    if (!path || !kind) return c.json({ error: "missing path or kind" }, 400);
    if (!isAllowedSourceKind(kind)) return c.json({ error: "invalid kind" }, 400);
    const result = corePinSource(xtrmDb, kind, path);
    return c.json({ source_key: result.source_key, kind: result.kind, display_path: formatSourceDisplayPath(result.path) });
  });

  routes.delete("/pin/:source_key", (c) => {
    if (!xtrmDb || !isAllowedMutationRequest(c.req.url, c.req.header("host") ?? "", c.req.header("origin") ?? null, c.req.header("x-gitboard-sources-admin-token") ?? null)) return c.json({ error: "forbidden" }, 403);
    const sourceKey = c.req.param("source_key");
    const row = coreGetSourceRow(xtrmDb, sourceKey);
    if (!coreIsMutableManualSource(row)) return c.json({ error: "source not manual" }, 409);
    return c.json(coreUnpinSource(xtrmDb, sourceKey));
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

