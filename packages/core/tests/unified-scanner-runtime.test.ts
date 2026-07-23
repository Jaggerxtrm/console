import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createXtrmDatabase } from "../src/state/database.ts";
import { UnifiedScanner } from "../src/runtime/unified-scanner.ts";
import type { LogEntry } from "../src/runtime/logs.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("UnifiedScanner runtime ownership", () => {
  it("coalesces startup refresh and emits structured lifecycle telemetry", async () => {
    const root = mkdtempSync(join(tmpdir(), "console-scanner-runtime-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(join(project, ".beads"), { recursive: true });
    writeFileSync(join(project, ".beads", "metadata.json"), JSON.stringify({ project_id: "bead-project" }));

    const db = createXtrmDatabase(join(root, "xtrm.sqlite"));
    const entries: LogEntry[] = [];
    const scanner = new UnifiedScanner(db, {
      owner: "apps/console",
      beadsScanPaths: [root],
      observabilityRoots: [join(root, "missing-observability")],
      refreshIntervalMs: 60_000,
      emitLog: (entry) => entries.push(entry),
    });

    scanner.start();
    await scanner.refresh();
    await scanner.stop();

    expect(db.query("SELECT source_key, kind, status FROM sources").all()).toEqual([
      { source_key: "beads:bead-project", kind: "beads", status: "active" },
    ]);
    expect(entries.filter((entry) => entry.event === "refresh.start")).toHaveLength(1);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "scanner.start", data: expect.objectContaining({ owner: "apps/console", outcome: "started" }) }),
      expect.objectContaining({ event: "refresh.end", data: expect.objectContaining({ owner: "apps/console", outcome: "success", duration_ms: expect.any(Number) }) }),
      expect.objectContaining({ event: "scanner.stop", data: expect.objectContaining({ owner: "apps/console", outcome: "stopped" }) }),
    ]));
    expect(JSON.stringify(entries)).not.toContain(root);
    db.close();
  });

  it("uses the same default Beads root for parity discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "unified-scanner-parity-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(join(project, ".beads"), { recursive: true });
    writeFileSync(join(project, ".beads", "metadata.json"), JSON.stringify({ project_id: "parity-project" }));
    const db = createXtrmDatabase(join(root, "xtrm.sqlite"));
    const entries: LogEntry[] = [];
    const previousRoot = process.env.XDG_PROJECTS_DIR;
    process.env.XDG_PROJECTS_DIR = root;
    try {
      const scanner = new UnifiedScanner(db, {
        owner: "apps/console",
        observabilityRoots: [join(root, "missing-observability")],
        parityEnabled: true,
        emitLog: (entry) => entries.push(entry),
        listObservabilityRepos: () => [],
      });
      await scanner.refresh();
      expect(entries.filter((entry) => entry.event === "parity.scanner")).toEqual([]);
    } finally {
      if (previousRoot === undefined) delete process.env.XDG_PROJECTS_DIR;
      else process.env.XDG_PROJECTS_DIR = previousRoot;
      db.close();
    }
  });
});
