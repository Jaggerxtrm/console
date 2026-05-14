/**
 * @jest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatusColumn } from "../../../../src/dashboard/components/beads/StatusColumn.tsx";
import type { BeadIssue, Interaction } from "../../../../src/types/beads.ts";

vi.mock("../../../../src/dashboard/lib/api.ts", () => ({
  api: {
    getIssue: vi.fn(async () => ({
      id: "forge-001",
      title: "Test issue title",
      description: "Loaded `code` *emphasis* [link](https://example.com) <img src=x onerror=alert(1)> <script>alert(1)</script>",
      status: "open",
      priority: 1,
      issue_type: "feature",
      owner: "user@example.com",
      created_at: "2024-01-01T00:00:00Z",
      created_by: "user@example.com",
      updated_at: "2024-01-01T00:00:00Z",
      project_id: "proj-1",
      dependencies: [],
      labels: [],
      related_ids: [],
      dependents: [],
      children: [],
      source: "sqlite",
      sourceHealth: [],
    })),
  },
}));

afterEach(cleanup);

const issue: BeadIssue = {
  id: "forge-001",
  title: "Test issue title",
  description: "Test description",
  status: "open",
  priority: 1,
  issue_type: "feature",
  owner: "user@example.com",
  created_at: "2024-01-01T00:00:00Z",
  created_by: "user@example.com",
  updated_at: "2024-01-01T00:00:00Z",
  project_id: "proj-1",
  dependencies: [{ id: "dep-1", title: "Blocker", status: "open", dependency_type: "blocked_by" }],
  labels: ["frontend"],
  related_ids: [],
};

const interactions: Interaction[] = [
  {
    id: "int-1",
    kind: "comment",
    created_at: "2024-01-01T00:00:00Z",
    actor: "claude",
    issue_id: "forge-001",
    model: "claude-3.7-sonnet",
    project_id: "proj-1",
  },
];

describe("StatusColumn", () => {
  it("expands dossier in place", async () => {
    const user = userEvent.setup();
    render(
      <StatusColumn
        title="Ready"
        status="open"
        issues={[issue]}
        projectId="proj-1"
        interactions={interactions}
      />,
    );

    await user.click(screen.getByRole("button", { name: /test issue title/i }));
    expect(await screen.findByText("Loading dossier...")).toBeInTheDocument();
    expect(await screen.findByText(/Loaded/)).toBeInTheDocument();
    expect(screen.getByText("code")).toBeInTheDocument();
    expect(screen.getByText("emphasis")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "link" })).toHaveAttribute("href", "https://example.com");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText(/alert\(1\)/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /test issue title/i }));
    await waitFor(() => expect(screen.queryByText("Loaded code emphasis link")).not.toBeInTheDocument());
  });
});
