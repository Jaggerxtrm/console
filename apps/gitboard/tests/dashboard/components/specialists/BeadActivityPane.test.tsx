/** @vitest-environment happy-dom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { logClientEvent } from "../../../../src/dashboard/lib/client-log.ts";
vi.mock("../../../../src/dashboard/lib/client-log.ts", () => ({
  logClientEvent: vi.fn(),
}));

describe("BeadActivityPane", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "sendBeacon", { value: vi.fn(() => true), configurable: true });
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("mounts running stream, collapses done feed, and expands with telemetry", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("bead_id=")) {
        return new Response(JSON.stringify({ jobs: [
          { jobId: "job-running", repoSlug: "repo-a", beadId: "bead-1", chainId: "chain-1", epicId: null, chainKind: "executor", status: "running", updatedAt: "2026-01-01T00:00:00.000Z", specialist: "exec", lastOutput: "running output", turns: null, tools: null, model: null },
          { jobId: "job-done", repoSlug: "repo-a", beadId: "bead-1", chainId: "chain-1", epicId: null, chainKind: "reviewer", status: "done", updatedAt: "2026-01-01T00:00:00.000Z", specialist: "rev", lastOutput: "# fallback result", turns: null, tools: null, model: null },
        ] }), { status: 200 });
      }
      if (url.includes("/feed")) {
        if (url.includes("job-running")) {
          return new Response(JSON.stringify({ text: "01:36:12 [job-running] LIVE running feed" }), { status: 200 });
        }
        return new Response(JSON.stringify({ text: "01:36:17 [job-done] TURN+ turn=18 total=44983" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { BeadActivityPane } = await import("../../../../src/dashboard/components/specialists/BeadActivityPane.tsx");
    render(React.createElement(BeadActivityPane, { beadId: "bead-1" }));

    await waitFor(() => expect(document.querySelectorAll(".terminal-stream")).toHaveLength(1));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/job-running/feed"))).toBe(true));
    expect(screen.getByRole("button", { name: /expand terminal feed/i })).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/feed"))).toBe(true));
    await waitFor(() => expect(screen.getByText("fallback result")).toBeTruthy());
    expect(logClientEvent).toHaveBeenCalledWith("bead_activity.mount", { beadId: "bead-1", jobIdHint: undefined });
    expect(logClientEvent).toHaveBeenCalledWith("bead_activity.result.rendered", expect.objectContaining({ beadId: "bead-1", jobId: "job-done", hasResult: true }));

    fireEvent.click(screen.getByRole("button", { name: /expand terminal feed/i }));
    await waitFor(() => expect(document.querySelectorAll(".terminal-stream")).toHaveLength(2));
    expect(document.querySelectorAll(".terminal-stream")).toHaveLength(2);
    expect(logClientEvent).toHaveBeenCalledWith("bead_activity.feed.expand", expect.objectContaining({ beadId: "bead-1", jobId: "job-done", reason: "user" }));

    cleanup();
    expect(logClientEvent).toHaveBeenCalledWith("bead_activity.feed.collapse", expect.objectContaining({ beadId: "bead-1", jobId: "job-done", reason: "unmount" }));
    expect(logClientEvent).toHaveBeenCalledWith("bead_activity.unmount", { beadId: "bead-1", jobIdHint: undefined });
  });

  it("renders loading and empty states", async () => {
    let resolveJobs!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveJobs = resolve; })) as unknown as typeof fetch);

    const { BeadActivityPane } = await import("../../../../src/dashboard/components/specialists/BeadActivityPane.tsx");
    render(React.createElement(BeadActivityPane, { beadId: "bead-empty" }));

    expect(screen.getByText("Loading specialist activity...")).toBeInTheDocument();
    resolveJobs(new Response(JSON.stringify({ jobs: [] }), { status: 200 }));
    await waitFor(() => expect(screen.getByText("No specialist activity yet.")).toBeInTheDocument());
  });

  it("renders fetch failures as an announced error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 })) as unknown as typeof fetch);

    const { BeadActivityPane } = await import("../../../../src/dashboard/components/specialists/BeadActivityPane.tsx");
    render(React.createElement(BeadActivityPane, { beadId: "bead-error" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("jobs 500");
  });
});
