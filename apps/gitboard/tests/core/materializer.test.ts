import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ChannelRegistry } from "../../src/api/ws/channels.ts";
import { createXtrmDatabase } from "../../src/core/xtrm-store.ts";
import { setDiskEnabled } from "../../src/core/logger.ts";
import { COALESCE_MS } from "../../src/core/materializer/queue.ts";
import { Materializer } from "../../src/core/materializer/index.ts";
import type { MaterializerAdapter } from "../../src/core/materializer/types.ts";

afterEach(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  await rm(join(process.cwd(), ".tmp-materializer"), { recursive: true, force: true });
});

async function createDb() {
  const dir = join(process.cwd(), ".tmp-materializer");
  await mkdir(dir, { recursive: true });
  return createXtrmDatabase(join(dir, "xtrm.sqlite"));
}

function createAdapter(batches: Array<Array<{ issue_id: string; title: string }>>): MaterializerAdapter {
  let cursor = 0;
  return {
    async cursor() {
      return { cursor: 0 };
    },
    async changesSince(input) {
      void input;
      const rows = batches[cursor] ?? [];
      cursor += 1;
      return {
        cursor: { cursor },
        rows: rows.map((row) => ({ repo_slug: "repo/a", issue_id: row.issue_id, title: row.title, state: "open" })),
      };
    },
    async snapshot() {
      const rows = batches.flat().map((row) => ({ repo_slug: "repo/a", issue_id: row.issue_id, title: row.title, state: "open" }));
      return { rows };
    },
  };
}

describe("materializer", () => {
  it("coalesces same source triggers and isolates source failures", async () => {
    setDiskEnabled(false);
    const db = await createDb();
    const registry = new ChannelRegistry();
    const hints: unknown[] = [];
    registry.subscribe("system", { id: "s1", send: (msg) => hints.push(msg) });
    const materializer = new Materializer(db, registry);
    const adapterA = createAdapter([[{ issue_id: "1", title: "one" }], [{ issue_id: "1", title: "one-updated" }]]);
    let shouldFail = true;
    const adapterB: MaterializerAdapter = {
      async cursor() {
        return { cursor: 0 };
      },
      async changesSince() {
        if (shouldFail) throw new Error("boom");
        return { cursor: { cursor: 1 }, rows: [] };
      },
      async snapshot() {
        return { rows: [] };
      },
    };

    materializer.register("a", adapterA);
    materializer.register("b", adapterB);
    materializer.trigger("a");
    materializer.trigger("a");
    materializer.trigger("b");
    await new Promise((resolve) => setTimeout(resolve, COALESCE_MS + 200));

    expect(db.query("SELECT title FROM substrate_issues WHERE repo_slug = 'repo/a' AND issue_id = '1'").get() as { title: string }).toEqual({ title: "one" });
    expect(db.query("SELECT cursor FROM materialization_state WHERE source_key = 'a'").get() as { cursor: string }).toEqual({ cursor: '{"cursor":1}' });
    expect(db.query("SELECT cursor FROM materialization_state WHERE source_key = 'b'").get()).toBeNull();
    expect(hints).toHaveLength(1);

    shouldFail = false;
    materializer.trigger("b");
    await new Promise((resolve) => setTimeout(resolve, COALESCE_MS + 200));
    expect(db.query("SELECT cursor FROM materialization_state WHERE source_key = 'b'").get() as { cursor: string }).toEqual({ cursor: '{"cursor":1}' });
    expect(hints).toHaveLength(2);
    db.close();
  });

  it("rolls back writes when cursor advance crashes, then re-applies", async () => {
    const db = await createDb();
    setDiskEnabled(false);
    const materializer = new Materializer(db, undefined, {
      afterWritesBeforeCursorAdvance: () => {
        throw new Error("crash");
      },
    });
    const adapter = createAdapter([[{ issue_id: "1", title: "one" }]]);
    materializer.register("a", adapter);

    await expect(materializer.runOnce("a")).rejects.toThrow("crash");
    expect(db.query("SELECT count(*) AS count FROM substrate_issues").get() as { count: number }).toEqual({ count: 0 });
    expect(db.query("SELECT cursor FROM materialization_state WHERE source_key = 'a'").get() as { cursor: null }).toEqual({ cursor: null });

    const recovery = new Materializer(db);
    recovery.register("a", createAdapter([[{ issue_id: "1", title: "one" }]]));
    await recovery.runOnce("a");
    expect(db.query("SELECT title FROM substrate_issues WHERE repo_slug = 'repo/a' AND issue_id = '1'").get() as { title: string }).toEqual({ title: "one" });
    expect(db.query("SELECT cursor FROM materialization_state WHERE source_key = 'a'").get() as { cursor: string }).toEqual({ cursor: '{"cursor":1}' });
    db.close();
  });

  it("applies 100 rows in one batch with one hint", async () => {
    const db = await createDb();
    const registry = new ChannelRegistry();
    const hints: unknown[] = [];
    registry.subscribe("system", { id: "s1", send: (msg) => hints.push(msg) });
    const materializer = new Materializer(db, registry);
    const adapter = createAdapter([Array.from({ length: 100 }, (_, i) => ({ issue_id: String(i), title: `t${i}` }))]);
    materializer.register("a", adapter);

    await materializer.runOnce("a");
    const rows = db.query("SELECT issue_id, title FROM substrate_issues WHERE repo_slug = 'repo/a' ORDER BY issue_id").all() as Array<{ issue_id: string; title: string }>;
    expect(rows).toHaveLength(100);
    expect(rows[0]).toEqual({ issue_id: "0", title: "t0" });
    expect(rows[99]).toEqual({ issue_id: "99", title: "t99" });
    expect(hints).toHaveLength(1);
    expect(db.query("SELECT json_extract(cursor, '$.cursor') AS cursor FROM materialization_state WHERE source_key = 'a'").get() as { cursor: number }).toEqual({ cursor: 1 });
    db.close();
  });
});
