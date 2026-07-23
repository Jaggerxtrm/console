import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecialistChain } from "../../../../../../packages/core/src/observability/types.ts";
import type { BeadIssue } from "../../../../src/types/beads.ts";
import { IssueOverlay } from "../../../../src/dashboard/components/beads/IssueOverlay.tsx";
import { SpecialistChainGraph } from "../../../../src/dashboard/components/beads/SpecialistChainGraph.tsx";

function mockChainFetch(jobs: Array<{ chainId?: string | null; chain_id?: string | null }>, chain: SpecialistChain[] | null): void {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ jobs }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ chain: chain ? { jobs: chain } : undefined }) });
  vi.stubGlobal("fetch", fetchMock);
}

function getFetchMock(): ReturnType<typeof vi.fn> {
  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

const issue: BeadIssue = {
  id: "bead-1",
  title: "Test bead",
  description: null,
  status: "open",
  priority: 1,
  issue_type: "task",
  owner: null,
  created_at: "2026-01-01T00:00:00.000Z",
  created_by: null,
  updated_at: "2026-01-01T00:00:00.000Z",
  project_id: "proj-1",
  dependencies: [],
  related_ids: [],
  labels: [],
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SpecialistChainGraph", () => {
  it("renders 4 nodes in chain_kind order", async () => {
    const chain = [
      { repoSlug: "repo", beadId: "fix-1", chainId: "chain-1", epicId: null, chainKind: "fix", status: "running", updatedAt: "2026-01-01T00:00:04.000Z" },
      { repoSlug: "repo", beadId: "explore-1", chainId: "chain-1", epicId: null, chainKind: "explorer", status: "done", updatedAt: "2026-01-01T00:00:01.000Z", last_output: "explore output" },
      { repoSlug: "repo", beadId: "exec-1", chainId: "chain-1", epicId: null, chainKind: "executor", status: "running", updatedAt: "2026-01-01T00:00:02.000Z", last_output: "exec output" },
      { repoSlug: "repo", beadId: "review-1", chainId: "chain-1", epicId: null, chainKind: "reviewer", status: "queued", updatedAt: "2026-01-01T00:00:03.000Z", last_output: "review output" },
    ] as unknown as SpecialistChain[];

    mockChainFetch([{ chainId: "chain-1" }], chain);
    render(<SpecialistChainGraph beadId="bead-1" />);

    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(4));
    const labels = screen.getAllByRole("listitem").map((node) => node.textContent ?? "");
    expect(labels[0]).toContain("explorer · done");
    expect(labels[1]).toContain("executor · running");
    expect(labels[2]).toContain("reviewer · queued");
    expect(labels[3]).toContain("fix · running");
  });

  it("renders nothing when bead has no chain_id", async () => {
    mockChainFetch([{ chainId: null, chain_id: null }], null);
    const { container } = render(<SpecialistChainGraph beadId="bead-1" />);
    await waitFor(() => expect(getFetchMock()).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows hover excerpt immediately", async () => {
    const chain = [
      { repoSlug: "repo", beadId: "explore-1", chainId: "chain-1", epicId: null, chainKind: "explorer", status: "done", updatedAt: "2026-01-01T00:00:01.000Z", last_output: "x".repeat(200) },
    ] as unknown as SpecialistChain[];
    mockChainFetch([{ chainId: "chain-1" }], chain);
    render(<SpecialistChainGraph beadId="bead-1" />);

    const node = await screen.findByRole("listitem");
    fireEvent.mouseEnter(node);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/x{117}…/);
  });
});

describe("IssueOverlay", () => {
  it("hides chain panel when no chain_id", async () => {
    mockChainFetch([{ chainId: null }], null);
    render(
      <IssueOverlay
        issue={issue}
        detail={null}
        loading={false}
        projectId="proj-1"
        issueById={new Map()}
        onClose={() => undefined}
      />,
    );

    // chainId=null → useChain short-circuits without calling /chains; graph stays hidden.
    await waitFor(
      () => expect(screen.queryByLabelText("Specialist chain")).toBeNull(),
      { timeout: 2000 },
    );
  });
});
