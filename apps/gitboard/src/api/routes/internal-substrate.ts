import { Hono } from "hono";
import type { Database } from "bun:sqlite";

export function createInternalSubstrateRouter(xtrmDb?: Database | null): Hono {
  const app = new Hono();

  app.get("/substrate/schema", (c) => {
    if (!isLocalhost(c.req.header("host") ?? "")) return c.json({ error: "forbidden" }, 403);
    if (!xtrmDb) return c.json({ columns: [], counts: { with_priority_nonzero: 0, with_type_nontask: 0, with_labels: 0, with_related: 0 } });

    const columns = (xtrmDb.query("PRAGMA table_info(substrate_issues)").all() as Array<{ name: string }>).map((column) => column.name);
    const counts = xtrmDb.query("SELECT COUNT(*) AS total, SUM(CASE WHEN priority IS NOT NULL AND priority <> 2 THEN 1 ELSE 0 END) AS with_priority_nonzero, SUM(CASE WHEN issue_type IS NOT NULL AND issue_type <> 'task' THEN 1 ELSE 0 END) AS with_type_nontask, SUM(CASE WHEN labels IS NOT NULL AND labels <> '[]' AND labels <> '' THEN 1 ELSE 0 END) AS with_labels, SUM(CASE WHEN related_ids IS NOT NULL AND related_ids <> '[]' AND related_ids <> '' THEN 1 ELSE 0 END) AS with_related FROM substrate_issues").get() as { with_priority_nonzero: number; with_type_nontask: number; with_labels: number; with_related: number } | undefined;
    return c.json({ columns, counts: counts ?? { with_priority_nonzero: 0, with_type_nontask: 0, with_labels: 0, with_related: 0 } });
  });

  return app;
}

function isLocalhost(host: string): boolean {
  return host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
}
