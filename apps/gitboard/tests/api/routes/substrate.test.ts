import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createSubstrateRouter } from "../../../src/api/routes/substrate.ts";
import { createXtrmDatabase } from "../../../src/core/xtrm-store.ts";

describe("substrate projects", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gitboard-substrate-"));
    dbPath = join(tmpDir, "xtrm.sqlite");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("redacts raw beads path in project listing", async () => {
    const db = createXtrmDatabase(dbPath);
    db.query("INSERT INTO sources (source_key, kind, path, origin, status) VALUES ('beads:demo', 'beads', '/very/private/workspace/demo/.beads', 'manual', 'active')").run();
    const app = createSubstrateRouter(db);

    const response = await app.fetch(new Request("http://localhost/projects", { headers: { host: "localhost" } }));
    expect(response.status).toBe(200);
    const body = await response.json() as { projects: Array<{ path: string; beadsPath: string }> };
    expect(body.projects[0]?.path).not.toContain("/very/private/workspace/demo/.beads");
    expect(body.projects[0]?.beadsPath).not.toContain("/very/private/workspace/demo/.beads");

    db.close();
  });
});
