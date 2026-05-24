import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createXtrmDatabase } from "../../src/core/xtrm-store.ts";
import { Materializer } from "../../src/core/materializer/index.ts";
import { BeadsAdapter } from "../../src/core/materializer/beads-adapter.ts";
import { ChannelRegistry } from "../../src/api/ws/channels.ts";

const root = mkdtempSync(join(tmpdir(), "p2-beads-smoke-"));
const beadsPath = join(root, ".beads");
mkdirSync(beadsPath, { recursive: true });
const jsonl = join(beadsPath, "issues.jsonl");
writeFileSync(jsonl, `${JSON.stringify(issue("A", "Alpha", "open", "2026-05-24T00:00:00.000Z"))}\n`);

const xtrmDb = createXtrmDatabase(join(root, "xtrm.sqlite"));
const registry = new ChannelRegistry();
const published: Array<{ event: string; payload: unknown }> = [];
const originalPublish = registry.publish.bind(registry);
registry.publish = ((channel: string, event: string, payload: unknown, version?: string) => {
  if (channel === "system" && event === "materializer:hint") published.push({ event, payload });
  return originalPublish(channel, event, payload, version);
}) as typeof registry.publish;

const materializer = new Materializer(xtrmDb, registry);
const sourceKey = "beads:fixture";
materializer.register(sourceKey, new BeadsAdapter({ sourceKey, projectId: "fixture", beadsPath, xtrmDb }));

await materializer.runOnce(sourceKey);
const before = readState(xtrmDb, sourceKey);

appendFileSync(jsonl, `${JSON.stringify(issue("B", "Beta", "open", "2026-05-24T00:01:00.000Z"))}\n`);
materializer.trigger(sourceKey);
await waitFor(async () => readActiveCount(xtrmDb) === 2 && published.length === 2, 3000);
const afterAdd = readState(xtrmDb, sourceKey);

writeFileSync(jsonl, `${JSON.stringify(issue("A", "Alpha", "open", "2026-05-24T00:00:00.000Z"))}\n`);
materializer.trigger(sourceKey);
await waitFor(async () => readActiveCount(xtrmDb) === 1 && readTombstones(xtrmDb) === 1 && published.length === 3, 3000);
const afterDelete = readState(xtrmDb, sourceKey);

const log = [
  `before_cursor=${before}`,
  `after_add_cursor=${afterAdd}`,
  `after_delete_cursor=${afterDelete}`,
  `active_rows=${readActiveCount(xtrmDb)}`,
  `tombstones=${readTombstones(xtrmDb)}`,
  `ws_hints=${published.length}`,
].join("\n") + "\n";
console.log(log);
mkdirSync(join("apps/gitboard/tests/smoke"), { recursive: true });
writeFileSync(join("apps/gitboard/tests/smoke/p2-beads-adapter.log"), log);
rmSync(root, { recursive: true, force: true });

function issue(id: string, title: string, status: string, updatedAt: string) {
  return { _type: "issue", id, title, status, priority: 2, issue_type: "task", created_at: updatedAt, updated_at: updatedAt, dependencies: [] };
}

function readState(db: ReturnType<typeof createXtrmDatabase>, sourceKey: string): string {
  const row = db.query("SELECT cursor FROM materialization_state WHERE source_key = ?").get(sourceKey) as { cursor: string } | undefined;
  return row?.cursor ?? "";
}

function readActiveCount(db: ReturnType<typeof createXtrmDatabase>): number {
  return Number((db.query("SELECT COUNT(*) AS count FROM substrate_issues WHERE repo_slug = ? AND deleted_at IS NULL").get("fixture") as { count: number }).count);
}

function readTombstones(db: ReturnType<typeof createXtrmDatabase>): number {
  return Number((db.query("SELECT COUNT(*) AS count FROM substrate_issues WHERE repo_slug = ? AND deleted_at IS NOT NULL").get("fixture") as { count: number }).count);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}
