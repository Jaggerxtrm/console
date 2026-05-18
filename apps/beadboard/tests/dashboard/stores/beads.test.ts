import { describe, it, expect, beforeEach } from "vitest";
import { useBeadsStore } from "../../../src/dashboard/stores/beads.ts";
import type { BeadIssue, BeadsProject } from "../../../src/types/beads.ts";

describe("useBeadsStore", () => {
  beforeEach(() => {
    // Reset store state
    useBeadsStore.setState({
      projects: [],
      selectedProjectId: null,
      issues: [],
      closedIssues: [],
      selectedIssue: null,
      memories: [],
      agentSessions: [],
      sourceHealthByProject: {},
      loading: false,
      error: null,
    });
  });

  describe("projects", () => {
    it("sets projects", () => {
      const projects: BeadsProject[] = [
        {
          id: "proj-1",
          name: "Project 1",
          path: "/path/1",
          beadsPath: "/path/1/.beads",
          status: "active",
          lastScanned: new Date().toISOString(),
          issueCount: 5,
        },
      ];

      useBeadsStore.getState().setProjects(projects);
      expect(useBeadsStore.getState().projects).toEqual(projects);
    });

    it("selects a project", () => {
      useBeadsStore.getState().selectProject("proj-1");
      expect(useBeadsStore.getState().selectedProjectId).toBe("proj-1");
    });
  });

  describe("issues", () => {
    const mockIssue: BeadIssue = {
      id: "forge-001",
      title: "Test issue",
      description: "Test description",
      status: "open",
      priority: 1,
      issue_type: "feature",
      owner: "user@example.com",
      created_at: new Date().toISOString(),
      created_by: "user@example.com",
      updated_at: new Date().toISOString(),
      project_id: "proj-1",
      dependencies: [],
      labels: [],
      related_ids: [],
    };

    it("sets issues", () => {
      useBeadsStore.getState().setIssues([mockIssue]);
      expect(useBeadsStore.getState().issues).toHaveLength(1);
      expect(useBeadsStore.getState().issues[0].id).toBe("forge-001");
    });

    it("sets closed issues separately", () => {
      const closedIssue = { ...mockIssue, id: "forge-002", status: "closed" as const };
      useBeadsStore.getState().setClosedIssues([closedIssue]);
      expect(useBeadsStore.getState().closedIssues).toHaveLength(1);
    });

    it("upserts issue at front and replaces by id", () => {
      const older = { ...mockIssue, updated_at: "2025-01-01T00:00:00Z" };
      const newer = { ...mockIssue, updated_at: "2025-01-02T00:00:00Z", title: "Updated" };
      useBeadsStore.getState().setIssues([older]);
      useBeadsStore.getState().upsertIssue(newer);
      expect(useBeadsStore.getState().issues[0].title).toBe("Updated");
      expect(useBeadsStore.getState().issues).toHaveLength(1);
    });

    it("moves issue to closed and removes by id", () => {
      useBeadsStore.getState().setIssues([mockIssue]);
      useBeadsStore.getState().moveToClosed(mockIssue.id);
      expect(useBeadsStore.getState().issues).toHaveLength(0);
      expect(useBeadsStore.getState().closedIssues[0].id).toBe(mockIssue.id);
    });

    it("removes issue from both lanes", () => {
      const closedIssue = { ...mockIssue, id: "forge-002", status: "closed" as const };
      useBeadsStore.getState().setIssues([mockIssue]);
      useBeadsStore.getState().setClosedIssues([closedIssue]);
      useBeadsStore.getState().removeIssue(mockIssue.id);
      expect(useBeadsStore.getState().issues).toHaveLength(0);
      expect(useBeadsStore.getState().closedIssues).toHaveLength(1);
    });

    it("selects an issue", () => {
      useBeadsStore.getState().selectIssue(mockIssue);
      expect(useBeadsStore.getState().selectedIssue?.id).toBe("forge-001");
    });

    it("clears selection with null", () => {
      useBeadsStore.getState().selectIssue(mockIssue);
      useBeadsStore.getState().selectIssue(null);
      expect(useBeadsStore.getState().selectedIssue).toBeNull();
    });
  });

  describe("UI state", () => {
    it("sets loading state", () => {
      useBeadsStore.getState().setLoading(true);
      expect(useBeadsStore.getState().loading).toBe(true);
    });

    it("sets error state", () => {
      useBeadsStore.getState().setError("Something went wrong");
      expect(useBeadsStore.getState().error).toBe("Something went wrong");
    });
  });
});
