import { describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => ({
  Database: class {},
}));

const getClosedIssues = vi.fn(async () => [{
  id: "closed-1",
  title: "Closed issue",
  description: null,
  status: "closed",
  priority: 2,
  issue_type: "task",
  owner: null,
  created_at: "2026-01-01T00:00:00.000Z",
  created_by: null,
  updated_at: "2026-01-02T00:00:00.000Z",
  closed_at: "2026-01-02T00:00:00.000Z",
  project_id: "proj-1",
  dependencies: [],
  related_ids: [],
  labels: [],
}]);
const getIssue = vi.fn(async () => null);

vi.mock("../../../src/core/project-scanner.ts", () => ({
  ProjectScanner: class {
    getProject(id: string) {
      if (id !== "proj-1") return null;
      return {
        id: "proj-1",
        name: "repo-a",
        path: "/tmp/repo-a",
        beadsPath: "/tmp/repo-a/.beads",
        doltPort: 3306,
        source: "dolt",
        status: "active",
        lastScanned: "2026-01-01T00:00:00.000Z",
        issueCount: 1,
      };
    }
  },
}));

vi.mock("../../../src/core/dolt-client.ts", () => ({
  DoltClient: class {
    getClosedIssues = getClosedIssues;
    getIssue = getIssue;
  },
}));

vi.mock("../../../../gitboard/src/core/logger.ts", () => ({
  emit: vi.fn(),
  makeLogEntry: vi.fn((source: string, event: string, level: string, message?: string, meta?: Record<string, unknown>) => ({ source, event, level, message, meta })),
}));

const { beadsRoutes } = await import("../../../src/api/routes/beads.ts");

describe("beads routes", () => {
  it("routes /issues/closed to the closed-list handler before issue detail", async () => {
    const response = await beadsRoutes.request("/projects/proj-1/issues/closed?limit=5");
    const body = await response.json() as { issues?: Array<{ id: string; status: string }> };

    expect(response.status).toBe(200);
    expect(body.issues?.[0]).toMatchObject({ id: "closed-1", status: "closed", project_id: "proj-1" });
    expect(getClosedIssues).toHaveBeenCalledWith(5);
    expect(getIssue).not.toHaveBeenCalled();
  });
});
