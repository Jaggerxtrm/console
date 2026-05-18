import { describe, expect, it, vi } from "vitest";
import { BeadsChangeWatcher } from "../../src/core/beads-change-watcher.ts";
import type { BeadIssue, BeadsProject } from "../../src/types/beads.ts";

const project: BeadsProject = {
  id: "proj-1",
  name: "proj-1",
  path: "/tmp/proj-1",
  beadsPath: "/tmp/proj-1/.beads",
  doltPort: 3306,
  status: "active",
  lastScanned: new Date().toISOString(),
  issueCount: 0,
};

function issue(overrides: Partial<BeadIssue> = {}): BeadIssue {
  return {
    id: "1",
    title: "issue",
    description: null,
    status: "open",
    priority: 2,
    issue_type: "task",
    owner: null,
    created_at: new Date().toISOString(),
    created_by: null,
    updated_at: new Date().toISOString(),
    project_id: "proj-1",
    dependencies: [],
    labels: [],
    related_ids: [],
    ...overrides,
  };
}

describe("BeadsChangeWatcher", () => {
  it("emits source health and batch on dolt hash change", async () => {
    const publish = vi.fn();
    const registry = { publish } as any;
    const watcher = new BeadsChangeWatcher({ registry, scanner: { scanAll: vi.fn().mockResolvedValue([project]) } as any });
    vi.spyOn(watcher as any, "getCommitHash").mockResolvedValueOnce("hash-1").mockResolvedValueOnce("hash-2");
    vi.spyOn(watcher as any, "readSnapshot").mockResolvedValue({ issues: [issue()], deps: [], memories: [], kv: [] });
    await (watcher as any).poll(project);
    await (watcher as any).poll(project);
    (watcher as any).flush(false);
    expect(publish).toHaveBeenCalled();
  });

  it("handles jsonl drift signal", async () => {
    const publish = vi.fn();
    const registry = { publish } as any;
    const watcher = new BeadsChangeWatcher({ registry, scanner: { scanAll: vi.fn().mockResolvedValue([project]) } as any });
    vi.spyOn(watcher as any, "getCommitHash").mockResolvedValue(null);
    vi.spyOn(watcher as any, "readSnapshot").mockResolvedValue({ issues: [issue()], deps: [], memories: [], kv: [] });
    await (watcher as any).poll(project);
    (watcher as any).flush(false);
    expect(publish).toHaveBeenCalled();
  });
});
