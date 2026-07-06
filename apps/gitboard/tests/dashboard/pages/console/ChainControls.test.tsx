/** @vitest-environment happy-dom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChainControls } from "../../../../src/dashboard/pages/console/specialists/ChainControls.tsx";
import { SteerBox } from "../../../../src/dashboard/pages/console/specialists/SteerBox.tsx";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset().mockImplementation((url: string) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ job: job(url.includes("stop") ? "cancelled" : "running") }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("prompt", vi.fn(() => "Resume from hold"));
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: vi.fn(() => true) });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChainControls", () => {
  it("renders standalone controls and sends stop with confirm", async () => {
    const onAction = vi.fn();
    render(<ChainControls chainId="chain-1" jobId="job-1" status="running" onAction={onAction} />);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/console/specialists/jobs/job-1/stop", expect.objectContaining({ method: "POST" })));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1", status: "cancelled" }), "stop");
  });

  it("offers resume only for keep-alive waiting jobs and submits steer", async () => {
    render(<ChainControls chainId="chain-keep" jobId="job-keep" status="waiting" />);

    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/console/specialists/jobs/job-keep/resume", expect.objectContaining({ method: "POST", body: JSON.stringify({ task: "Resume from hold" }) })));

    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    fireEvent.change(screen.getByLabelText("Steer"), { target: { value: "Focus logs" } });
    fireEvent.submit(screen.getByRole("button", { name: "Send steer" }).closest("form")!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/console/specialists/jobs/job-keep/steer", expect.objectContaining({ method: "POST", body: JSON.stringify({ message: "Focus logs" }) })));
  });
});

describe("SteerBox", () => {
  it("renders isolated harness and passes job id + message", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<SteerBox jobId="job-box" onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("Steer"), { target: { value: "Narrow diff" } });
    fireEvent.submit(screen.getByRole("button", { name: "Send steer" }).closest("form")!);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("job-box", "Narrow diff"));
  });
});

function job(status: string) {
  return {
    jobId: "job-1",
    repoSlug: "repo-a",
    beadId: "forge-1",
    chainId: "chain-1",
    epicId: null,
    chainKind: "executor",
    status,
    updatedAt: "2026-07-06T00:00:00.000Z",
    specialist: "executor",
    lastOutput: null,
    turns: null,
    tools: null,
    model: null,
  };
}
