import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createXtrmDatabase } from "../../src/core/xtrm-store.ts";
import { normalizeLegacySourceStatus, UnifiedScanner } from "../../src/core/unified-scanner.ts";

describe("UnifiedScanner", () => {
  let tmpDir: string;
  let dbPath: string;
  let repoDir: string;
  let obsDir: string;
  let worktreeDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gitboard-unified-scanner-"));
    dbPath = join(tmpDir, "xtrm.sqlite");
    repoDir = join(tmpDir, "demo-repo");
    obsDir = join(tmpDir, "obs-repo");
    worktreeDir = join(tmpDir, "worktree-repo");
    await mkdir(join(repoDir, ".beads"), { recursive: true });
    await mkdir(join(obsDir, ".specialists"), { recursive: true });
    await mkdir(join(worktreeDir, ".beads"), { recursive: true });
    await writeFile(join(repoDir, ".beads", "metadata.json"), JSON.stringify({ project_id: "demo-project" }));
    await writeFile(join(obsDir, ".specialists", "observability.db"), "");
    await writeFile(join(worktreeDir, ".beads", "metadata.json"), JSON.stringify({ project_id: "worktree-project" }));
    await writeFile(join(worktreeDir, ".git"), "gitdir: /tmp/worktree-gitdir");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("uses metadata.project_id before basename for beads identity", async () => {
    const db = createXtrmDatabase(dbPath);
    const scanner = new UnifiedScanner(db, { beadsSearchPath: tmpDir, observabilityRoots: [tmpDir], parityEnabled: false });

    await scanner.refresh();

    const row = db.query<{ path: string; kind: string; status: string }, []>("SELECT path, kind, status FROM sources WHERE source_key = 'beads:demo-project'").get();
    expect(row?.kind).toBe("beads");
    expect(row?.status).toBe("active");
    expect(row?.path).toBe(join(repoDir, ".beads"));

    db.close();
  });

  it("marks missing discovered sources without deleting rows", async () => {
    const db = createXtrmDatabase(dbPath);
    const scanner = new UnifiedScanner(db, { beadsSearchPath: tmpDir, observabilityRoots: [tmpDir], parityEnabled: false });

    await scanner.refresh();
    await rm(join(repoDir, ".beads"), { recursive: true, force: true });
    await scanner.refresh();

    const row = db.query<{ status: string }, []>("SELECT status FROM sources WHERE source_key = 'beads:demo-project'").get();
    const count = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM sources WHERE source_key = 'beads:demo-project'").get();
    expect(row?.status).toBe("missing");
    expect(count?.c).toBe(1);

    db.close();
  });

  it("preserves manual rows across refresh", async () => {
    const db = createXtrmDatabase(dbPath);
    const scanner = new UnifiedScanner(db, { beadsSearchPath: tmpDir, observabilityRoots: [tmpDir], parityEnabled: false });
    db.query("INSERT INTO sources (source_key, kind, path, origin, status) VALUES ('manual:repo', 'beads', '/manual/repo', 'manual', 'active')").run();

    await scanner.refresh();

    const row = db.query<{ origin: string; status: string }, []>("SELECT origin, status FROM sources WHERE source_key = 'manual:repo'").get();
    expect(row?.origin).toBe("manual");
    expect(row?.status).toBe("active");

    db.close();
  });

  it("skips git worktree paths", async () => {
    const db = createXtrmDatabase(dbPath);
    const scanner = new UnifiedScanner(db, { beadsScanPaths: [tmpDir], observabilityRoots: [tmpDir], parityEnabled: false });

    await scanner.refresh();

    const worktree = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM sources WHERE source_key = 'beads:worktree-project'").get();
    expect(worktree?.c).toBe(0);

    db.close();
  });

  it("skips hidden operational directories while scanning for beads projects", async () => {
    await mkdir(join(repoDir, ".specialists", "jobs", "job-a", ".beads"), { recursive: true });
    await mkdir(join(repoDir, ".xtrm", "nested", ".beads"), { recursive: true });
    await writeFile(join(repoDir, ".specialists", "jobs", "job-a", ".beads", "metadata.json"), JSON.stringify({ project_id: "job-project" }));
    await writeFile(join(repoDir, ".xtrm", "nested", ".beads", "metadata.json"), JSON.stringify({ project_id: "xtrm-nested-project" }));
    const db = createXtrmDatabase(dbPath);
    const scanner = new UnifiedScanner(db, { beadsScanPaths: [tmpDir], observabilityRoots: [tmpDir], parityEnabled: false });

    await scanner.refresh();

    const realProject = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM sources WHERE source_key = 'beads:demo-project'").get();
    const jobProject = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM sources WHERE source_key = 'beads:job-project'").get();
    const xtrmProject = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM sources WHERE source_key = 'beads:xtrm-nested-project'").get();
    expect(realProject?.c).toBe(1);
    expect(jobProject?.c).toBe(0);
    expect(xtrmProject?.c).toBe(0);

    db.close();
  });

  it("normalizes legacy idle beads as active for parity", () => {
    expect(normalizeLegacySourceStatus("idle")).toBe("active");
    expect(normalizeLegacySourceStatus("missing")).toBe("missing");
  });

  it("collapses concurrent refresh calls", async () => {
    const db = createXtrmDatabase(dbPath);
    const scanner = new UnifiedScanner(db, { beadsSearchPath: tmpDir, observabilityRoots: [tmpDir], parityEnabled: false });

    const [first, second] = await Promise.all([scanner.refresh(), scanner.refresh()]);
    expect(first.length).toBe(second.length);

    db.close();
  });
});
