/**
 * @jest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StatusColumn } from "../../../../src/dashboard/components/beads/StatusColumn.tsx";
import type { BeadIssue } from "../../../../src/types/beads.ts";

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

describe("StatusColumn", () => {
  it("emits onSelect when a card is clicked", () => {
    const onSelect = vi.fn();
    render(
      <StatusColumn
        title="Ready"
        status="open"
        issues={[issue]}
        selectedId={null}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /test issue title/i }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].id).toBe("forge-001");
  });

  it("marks card aria-pressed when selectedId matches", () => {
    render(
      <StatusColumn
        title="Ready"
        status="open"
        issues={[issue]}
        selectedId="forge-001"
        onSelect={() => {}}
      />,
    );
    const card = screen.getByRole("button", { name: /test issue title/i });
    expect(card.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders empty-state when no issues", () => {
    render(
      <StatusColumn
        title="Ready"
        status="open"
        issues={[]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/No issues in lane/i)).toBeInTheDocument();
  });
});
