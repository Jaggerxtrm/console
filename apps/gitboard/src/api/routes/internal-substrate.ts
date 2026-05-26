import { Hono } from "hono";
import type { Database } from "bun:sqlite";

export function createInternalSubstrateRouter(xtrmDb?: Database | null): Hono {
  const app = new Hono();

  app.get("/substrate/schema", (c) => {
    if (!isLocalhost(c.req.header("host") ?? "")) return c.json({ error: "forbidden" }, 403);
    if (!xtrmDb) return c.json({ columns: [], counts: { with_priority_nonzero: 0, with_type_nontask: 0, with_labels: 0, with_related: 0 } });

    const columns = (xtrmDb.query("PRAGMA table_info(substrate_issues)").all() as Array<{ name: string }>).map((column) => column.name);
    const counts = xtrmDb.query("SELECT COALESCE(SUM(CASE WHEN priority IS NOT NULL AND priority <> 2 THEN 1 ELSE 0 END), 0) AS with_priority_nonzero, COALESCE(SUM(CASE WHEN issue_type IS NOT NULL AND issue_type <> 'task' THEN 1 ELSE 0 END), 0) AS with_type_nontask, COALESCE(SUM(CASE WHEN labels IS NOT NULL AND labels <> '[]' AND labels <> '' THEN 1 ELSE 0 END), 0) AS with_labels, COALESCE(SUM(CASE WHEN related_ids IS NOT NULL AND related_ids <> '[]' AND related_ids <> '' THEN 1 ELSE 0 END), 0) AS with_related FROM substrate_issues").get() as { with_priority_nonzero: number; with_type_nontask: number; with_labels: number; with_related: number } | undefined;
    return c.json({ columns, counts: counts ?? { with_priority_nonzero: 0, with_type_nontask: 0, with_labels: 0, with_related: 0 } });
  });

  return app;
}

function isLocalhost(host: string): boolean {
  const allowedHosts = ["localhost", "127.0.0.1", "[::1]", process.env.HOST].filter((value): value is string => Boolean(value));
  return allowedHosts.some((allowedHost) => host.startsWith(allowedHost));
}
