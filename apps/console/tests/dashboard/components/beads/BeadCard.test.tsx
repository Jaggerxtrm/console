import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { BeadCard } from "../../../../src/dashboard/components/beads/BeadCard.tsx";
import type { BeadIssue } from "../../../../src/types/beads.ts";

const issue: BeadIssue = {
  id: "B-1",
  title: "Seeded in progress bead",
  description: null,
  status: "in_progress",
  priority: 1,
  issue_type: "task",
  owner: null,
  created_at: "2026-01-01T00:00:00.000Z",
  created_by: null,
  updated_at: "2026-01-01T00:00:00.000Z",
  project_id: "project-1",
  dependencies: [],
  related_ids: [],
  labels: [],
};

const openIssue: BeadIssue = { ...issue, id: "B-2", status: "open" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BeadCard specialist badge", () => {
  it("renders badge for in-progress bead", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ jobs: [{ jobId: "abcdef0123", specialist: "executor", status: "running", repoSlug: "repo-a" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    render(<BeadCard issue={issue} />);

    // New chip format: "role:jobId·state"
    expect(await screen.findByText(/^executor:abcdef·running$/)).toBeInTheDocument();
  });

  it("renders no badge when jobs empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ jobs: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    render(<BeadCard issue={issue} />);

    await waitFor(() => expect(screen.queryByText("executor")).not.toBeInTheDocument());
  });

  it("does not fetch for non in-progress bead", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(<BeadCard issue={openIssue} />);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByText("executor")).not.toBeInTheDocument();
  });

  it("renders no badge on api error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<BeadCard issue={issue} />);

    await waitFor(() => expect(screen.queryByText("executor")).not.toBeInTheDocument());
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});
