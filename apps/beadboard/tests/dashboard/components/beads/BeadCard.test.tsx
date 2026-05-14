/**
 * @jest-environment happy-dom
 */
import { describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { BeadCard } from "../../../../src/dashboard/components/beads/BeadCard.tsx";
import type { BeadIssue } from "../../../../src/types/beads.ts";

afterEach(cleanup);

const mockIssue: BeadIssue = {
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
  dependencies: [],
  labels: [],
  related_ids: [],
};

describe("BeadCard", () => {
  it("renders issue title and id", () => {
    render(<BeadCard issue={mockIssue} />);
    expect(screen.getByText("Test issue title")).toBeInTheDocument();
    expect(screen.getByText("forge-001")).toBeInTheDocument();
  });

  it("renders compact metadata without pills", () => {
    render(<BeadCard issue={mockIssue} agent="claude" />);
    expect(screen.getByText("P1")).toBeInTheDocument();
    expect(screen.getByText("claude")).toBeInTheDocument();
    expect(screen.queryByText("0 deps")).not.toBeInTheDocument();
  });
});
