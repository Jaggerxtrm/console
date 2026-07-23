import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createXtrmDatabase } from "../../../../packages/core/src/state/database.ts";
import type { LogEntry } from "../../../../packages/core/src/runtime/logs.ts";
import { createConsoleRuntime } from "../../src/server/runtime-lifecycle.ts";
import type { HostLogger } from "../../src/server/log.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Console runtime lifecycle", () => {
  it("owns scanner, watcher and materializer startup without Gitboard imports", async () => {
    const root = mkdtempSync(join(tmpdir(), "console-runtime-lifecycle-"));
    roots.push(root);
    const project = join(root, "project");
    const beadsPath = join(project, ".beads");
    mkdirSync(beadsPath, { recursive: true });
    writeFileSync(join(beadsPath, "metadata.json"), JSON.stringify({ project_id: "console-project" }));
    writeFileSync(join(beadsPath, "issues.jsonl"), `${JSON.stringify({
      id: "console-project-1",
      title: "Console-owned lifecycle",
      status: "open",
      priority: 1,
      issue_type: "task",
      created_at: "2026-07-23T00:00:00.000Z",
      updated_at: "2026-07-23T00:00:00.000Z",
    })}\n`);

    const db = createXtrmDatabase(join(root, "xtrm.sqlite"));
    const entries: LogEntry[] = [];
    const logger = collectingLogger(entries);
    const runtime = createConsoleRuntime({
      db,
      logger,
      beadsScanPaths: [root],
      observabilityRoots: [join(root, "missing-observability")],
      parityEnabled: false,
    });

    await runtime.start();
    await waitFor(() => {
      const row = db.query("SELECT last_status FROM materialization_state WHERE source_key = 'beads:console-project'").get() as { last_status?: string } | null;
      return row?.last_status === "success";
    });
    expect(() => runtime.triggerMaterialization("unknown-project")).toThrow("unknown source: beads:unknown-project");
    await runtime.stop();

    expect(db.query("SELECT issue_id, title FROM substrate_issues WHERE repo_slug = 'console-project'").all()).toEqual([
      { issue_id: "console-project-1", title: "Console-owned lifecycle" },
    ]);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "materializer.trigger", data: expect.objectContaining({ owner: "apps/console", source_key: "beads:console-project" }) }),
      expect.objectContaining({ event: "materializer.run", data: expect.objectContaining({ owner: "apps/console", outcome: "success", source_key: "beads:console-project", duration_ms: expect.any(Number) }) }),
      expect.objectContaining({ event: "materializer.publishHint", data: expect.objectContaining({ owner: "apps/console", outcome: "published", source_key: "beads:console-project" }) }),
      expect.objectContaining({ event: "watcher.start", data: expect.objectContaining({ owner: "apps/console" }) }),
      expect.objectContaining({ event: "watcher.cleanup", data: expect.objectContaining({ owner: "apps/console" }) }),
    ]));
    expect(JSON.stringify(entries)).not.toContain(root);
    db.close();
  });
});

function collectingLogger(entries: LogEntry[]): HostLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    emit: (entry) => entries.push(entry),
    getRing: () => entries,
    getLogDiskDir: () => "",
    flush: async () => {},
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for Console materialization");
}
