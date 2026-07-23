import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createXtrmDatabase } from "../src/state/database.ts";
import {
  readBeadsSourceFacts,
  readSubstrateProjectConnection,
  readSubstrateProjectRepairActions,
  resolveBeadsProjectRepoPath,
} from "../src/state/substrate-project-service.ts";

describe("substrate project service", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "core-substrate-project-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("preserves unavailable and missing project responses", async () => {
    expect(await readSubstrateProjectConnection(null, "demo")).toEqual({
      source: "none",
      status: "error",
      degraded: true,
      error: "xtrm.sqlite unavailable",
    });
    const db = createXtrmDatabase(join(tempDir, "state.db"));
    expect(await readSubstrateProjectConnection(db, "missing")).toEqual({
      source: "none",
      status: "not_found",
      degraded: true,
      error: "Project not found",
    });
    db.close();
  });

  it("reads source facts and returns the JSONL fallback without probing Dolt", async () => {
    const repoPath = join(tempDir, "demo");
    const beadsPath = join(repoPath, ".beads");
    await mkdir(beadsPath, { recursive: true });
    await writeFile(join(beadsPath, "config.yaml"), "dolt:\n  shared-server: false\ndolt_database: demo_db\n");
    await writeFile(join(beadsPath, "issues.jsonl"), "");
    const db = createXtrmDatabase(join(tempDir, "state.db"));
    db.query("INSERT INTO sources (source_key, kind, path, origin, status) VALUES (?, 'beads', ?, 'manual', 'active')")
      .run("beads:demo", beadsPath);

    const facts = readBeadsSourceFacts(beadsPath);
    expect(facts).toMatchObject({ repoPath, projectName: "demo", doltDatabase: "demo_db", sharedServerEnabled: false });
    expect(facts.jsonlUpdatedAt).toBeTypeOf("string");
    expect(resolveBeadsProjectRepoPath(db, "demo")).toBe(repoPath);
    expect(await readSubstrateProjectConnection(db, "demo")).toMatchObject({
      source: "jsonl",
      status: "jsonl_fallback",
      degraded: true,
      database: "demo_db",
    });
    db.close();
  });

  it("builds the same safe repair actions for a source without a port", async () => {
    const repoPath = join(tempDir, "demo");
    const beadsPath = join(repoPath, ".beads");
    await mkdir(beadsPath, { recursive: true });
    await writeFile(join(beadsPath, "config.yaml"), "dolt:\n  shared-server: false\n");
    const db = createXtrmDatabase(join(tempDir, "state.db"));
    db.query("INSERT INTO sources (source_key, kind, path, origin, status) VALUES (?, 'beads', ?, 'manual', 'active')")
      .run("beads:demo", beadsPath);

    const result = await readSubstrateProjectRepairActions(db, "demo");

    expect(result.status).toBe("jsonl_fallback");
    expect(result.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "rescan_source_health", available: true, endpoint: "/api/substrate/projects/demo/connection" }),
      expect.objectContaining({ id: "start_dolt_server", available: true }),
      expect.objectContaining({ id: "recover_port_config", available: true }),
      expect.objectContaining({ id: "remove_dead_pid_file", available: false }),
    ]));
    expect(result.actions.find(({ id }) => id === "start_dolt_server")?.command).toContain("bd -C");
    expect(result.actions.find(({ id }) => id === "start_dolt_server")?.command).not.toContain(tempDir);
    db.close();
  });
});
