/** @vitest-environment happy-dom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { logClientEvent } from "../../../../src/dashboard/lib/client-log.ts";

vi.mock("../../../../src/dashboard/lib/client-log.ts", () => ({
  logClientEvent: vi.fn(),
}));

describe("Console BeadActivityPane", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "sendBeacon", { value: vi.fn(() => true), configurable: true });
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders done run terminal feed plus markdown result", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("bead_id=")) {
        return new Response(JSON.stringify({ jobs: [
          { jobId: "job-done", repoSlug: "repo-a", beadId: "bead-1", chainId: "chain-1", epicId: null, chainKind: "reviewer", status: "done", updatedAt: "2026-01-01T00:00:00.000Z", specialist: "rev", lastOutput: "# fallback result", turns: null, tools: null, model: null },
        ] }), { status: 200 });
      }
      if (url.includes("/feed")) return new Response(JSON.stringify({ text: "01:36:17 [job-done] TURN+ turn=18 total=44983" }), { status: 200 });
      if (url.includes("/result")) return new Response(JSON.stringify({ text: "# reviewed\n\n**PASS**", content_type: "text/markdown" }), { status: 200 });
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { BeadActivityPane } = await import("../../../../src/dashboard/components/specialists/BeadActivityPane.tsx");
    render(React.createElement(BeadActivityPane, { beadId: "bead-1" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/job-done/feed"))).toBe(true));
    expect(screen.queryByText("reviewed")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /expand result/i }));
    await waitFor(() => expect(screen.getByText("reviewed")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /collapse result/i }));
    expect(screen.queryByText("reviewed")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /expand result/i }));
    await waitFor(() => expect(screen.getByText("reviewed")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /expand terminal feed/i }));

    await waitFor(() => expect(document.querySelectorAll(".terminal-stream")).toHaveLength(1));
    expect(logClientEvent).toHaveBeenCalledWith("bead_activity.result.rendered", expect.objectContaining({ beadId: "bead-1", jobId: "job-done", hasResult: true }));
    expect(logClientEvent).toHaveBeenCalledWith("bead_activity.feed.expand", expect.objectContaining({ beadId: "bead-1", jobId: "job-done", reason: "user" }));
  });

  it("loads the full chain when a chain hint is provided", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/specialists/chains/chain-full")) {
        return new Response(JSON.stringify({ chain: { jobs: [
          { jobId: "job-root", repoSlug: "repo-a", beadId: "bead-1", chainId: "chain-full", epicId: null, chainKind: "executor", status: "done", updatedAt: "2026-01-01T00:00:00.000Z", specialist: "exec", lastOutput: "root fallback", turns: null, tools: null, model: null },
          { jobId: "job-child", repoSlug: "repo-a", beadId: "bead-child", chainId: "chain-full", epicId: null, chainKind: "reviewer", status: "done", updatedAt: "2026-01-01T00:01:00.000Z", specialist: "rev", last_output: "child fallback", turns: null, tools: null, model: null },
        ] } }), { status: 200 });
      }
      if (url.includes("/job-root/result")) return new Response(JSON.stringify({ text: "# root result", content_type: "text/markdown" }), { status: 200 });
      if (url.includes("/job-child/result")) return new Response(JSON.stringify({ text: "# child result", content_type: "text/markdown" }), { status: 200 });
      if (url.includes("/feed")) return new Response(JSON.stringify({ text: "feed" }), { status: 200 });
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { BeadActivityPane } = await import("../../../../src/dashboard/components/specialists/BeadActivityPane.tsx");
    render(React.createElement(BeadActivityPane, { beadId: "bead-1", chainIdHint: "chain-full" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/specialists/chains/chain-full"))).toBe(true));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("bead_id=bead-1"))).toBe(false);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /expand result/i })).toHaveLength(2));
    for (const button of screen.getAllByRole("button", { name: /expand result/i })) {
      fireEvent.click(button);
    }
    expect(await screen.findByText("root result")).toBeInTheDocument();
    expect(await screen.findByText("child result")).toBeInTheDocument();
  });
});
