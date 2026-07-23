import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createXtrmDatabase } from "../../src/state/database.ts";
import { UnifiedScanner } from "../../src/runtime/unified-scanner.ts";

function createBeadsProject(repoDir: string, projectId?: string): Promise<void> {
  return mkdir(join(repoDir, ".beads"), { recursive: true }).then(() => writeFile(join(repoDir, ".beads", "metadata.json"), JSON.stringify(projectId ? { project_id: projectId } : {})));
}

describe("UnifiedScanner live fs", () => {
  let tmpDir: string;
  let dbPath: string;
  let alphaDir: string;
  let betaDir: string;
  let obsDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gitboard-unified-scanner-live-"));
    dbPath = join(tmpDir, "xtrm.sqlite");
    alphaDir = join(tmpDir, "alpha-repo");
    betaDir = join(tmpDir, "beta-repo");
    obsDir = join(tmpDir, "obs-repo");

    await createBeadsProject(alphaDir, "alpha-project");
    await createBeadsProject(betaDir);
    await mkdir(join(obsDir, ".specialists"), { recursive: true });
    await writeFile(join(obsDir, ".specialists", "observability.db"), "sqlite");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("discovers beads and observability sources from live tmpdir layout", async () => {
    const db = createXtrmDatabase(dbPath);
    const scanner = new UnifiedScanner(db, { beadsSearchPath: tmpDir, observabilityRoots: [tmpDir], parityEnabled: false });

    await scanner.refresh();

    const rows = db.query<{ source_key: string; kind: string; path: string; status: string }, []>("SELECT source_key, kind, path, status FROM sources ORDER BY source_key ASC").all();
    expect(rows).toEqual([
      { source_key: "beads:alpha-project", kind: "beads", path: join(alphaDir, ".beads"), status: "active" },
      { source_key: "beads:beta-repo", kind: "beads", path: join(betaDir, ".beads"), status: "active" },
      { source_key: "obs:obs-repo", kind: "observability", path: join(obsDir, ".specialists", "observability.db"), status: "active" },
    ]);

    db.close();
  });

  it("marks removed projects missing and keeps manual pins", async () => {
    const db = createXtrmDatabase(dbPath);
    const scanner = new UnifiedScanner(db, { beadsSearchPath: tmpDir, observabilityRoots: [tmpDir], parityEnabled: false });
    db.query("INSERT INTO sources (source_key, kind, path, origin, status) VALUES ('manual:/pinned', 'beads', '/manual/pinned', 'manual', 'active')").run();

    await scanner.refresh();
    await rm(join(alphaDir, ".beads"), { recursive: true, force: true });
    await scanner.refresh();

    const missing = db.query<{ status: string }, []>("SELECT status FROM sources WHERE source_key = 'beads:alpha-project'").get();
    const manual = db.query<{ origin: string; status: string }, []>("SELECT origin, status FROM sources WHERE source_key = 'manual:/pinned'").get();

    expect(missing?.status).toBe("missing");
    expect(manual).toEqual({ origin: "manual", status: "active" });

    db.close();
  });
});
