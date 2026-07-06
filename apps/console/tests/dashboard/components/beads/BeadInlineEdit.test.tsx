/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BeadLabelsEditor, BeadPriorityEditor, BeadTitleEditor, DeleteBeadButton, NewIssueComposer } from "../../../../src/dashboard/components/beads/inline/BeadInlineEdit.tsx";
import { BeadMutationPanel } from "../../../../src/dashboard/components/beads/inline/BeadMutationPanel.tsx";
import type { BeadIssue } from "../../../../src/types/beads.ts";

vi.mock("../../../../src/dashboard/lib/client-log.ts", () => ({ logClientEvent: vi.fn() }));

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const issue: BeadIssue = {
  id: "forge-1",
  title: "Old title",
  description: "Old description",
  notes: null,
  status: "open",
  priority: 2,
  issue_type: "task",
  owner: null,
  created_at: "2026-01-01T00:00:00.000Z",
  created_by: null,
  updated_at: "2026-01-02T00:00:00.000Z",
  project_id: "console",
  dependencies: [],
  related_ids: [],
  labels: ["ui"],
};

describe("bead inline editors", () => {
  it("renders standalone field editors and emits changed values", () => {
    const title = vi.fn();
    const priority = vi.fn();
    const labels = vi.fn();
    render(<><BeadTitleEditor id="b1" value="old" onChange={title} /><BeadPriorityEditor id="b1" value={2} onChange={priority} /><BeadLabelsEditor id="b1" value={["a"]} onChange={labels} /></>);

    fireEvent.change(screen.getByLabelText("Title for b1"), { target: { value: "new" } });
    fireEvent.click(screen.getAllByText("Save")[0]!);
    fireEvent.change(screen.getByLabelText("Priority for b1"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Labels for b1"), { target: { value: "a, b" } });
    fireEvent.click(screen.getAllByText("Save")[1]!);

    expect(title).toHaveBeenCalledWith("new");
    expect(priority).toHaveBeenCalledWith(1);
    expect(labels).toHaveBeenCalledWith(["a", "b"]);
  });

  it("creates and confirms deletes", async () => {
    const create = vi.fn();
    const del = vi.fn();
    render(<><NewIssueComposer onCreate={create} /><DeleteBeadButton id="forge-1" onDelete={del} /></>);

    fireEvent.change(screen.getByLabelText("New issue title"), { target: { value: "New issue" } });
    fireEvent.click(screen.getByText("Create issue"));
    fireEvent.click(screen.getByText("Delete bead"));
    fireEvent.click(screen.getByText("Confirm delete forge-1"));

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: "New issue", priority: 2, type: "task" })));
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("wires the mutation panel to substrate write API", async () => {
    const onIssueChange = vi.fn();
    const onDeleted = vi.fn();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => new Response(JSON.stringify(String(init?.method ?? "GET") === "DELETE" ? { ok: true, projectId: "console", issueId: "forge-1" } : { issue: { ...issue, title: "Edited" } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    window.fetch = fetchMock as never;
    Object.defineProperty(navigator, "sendBeacon", { value: vi.fn(), configurable: true });
    render(<BeadMutationPanel projectId="console" issue={issue} onIssueChange={onIssueChange} onDeleted={onDeleted} />);

    fireEvent.change(screen.getByLabelText("Title for forge-1"), { target: { value: "Edited" } });
    fireEvent.click(screen.getAllByText("Save")[0]!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/substrate/projects/console/issues/forge-1", expect.objectContaining({ method: "PATCH" })));

    fireEvent.click(screen.getByText("Delete bead"));
    fireEvent.click(screen.getByText("Confirm delete forge-1"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/substrate/projects/console/issues/forge-1", expect.objectContaining({ method: "DELETE" })));
    expect(onIssueChange).toHaveBeenCalled();
    expect(onDeleted).toHaveBeenCalledWith("forge-1");
  });
});
