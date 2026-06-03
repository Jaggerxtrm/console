/** @vitest-environment happy-dom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainSummary } from "../../../../src/dashboard/hooks/useChains.ts";

vi.mock("../../../../src/dashboard/lib/client-log.ts", () => ({
  logClientEvent: vi.fn(),
}));

import { ChainDetailPane } from "../../../../src/dashboard/pages/console/specialists/ChainDetailPane.tsx";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ text: "DONE\nAUTO+\ncomplete" }), { status: 200 })));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChainDetailPane", () => {
  it("lets completed jobs expand the persisted sp feed", async () => {
    render(<ChainDetailPane chain={chain("done")} />);

    const toggle = await screen.findByRole("button", { name: /terminal feed/i });
    await waitFor(() => expect(toggle).toHaveTextContent("3 lines"));
    const resultToggle = await screen.findByRole("button", { name: /run result/i });
    expect(resultToggle).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(resultToggle).toHaveTextContent("3 lines"));
    expect(screen.queryByText(/AUTO\+/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("terminal stream")).not.toBeInTheDocument();

    fireEvent.click(resultToggle);
    expect(resultToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/AUTO\+/)).toBeInTheDocument();

    fireEvent.click(toggle);

    const terminal = await screen.findByLabelText("terminal stream");
    expect(terminal).toHaveTextContent("DONE");
    expect(terminal).toHaveTextContent("AUTO+");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/specialists/jobs/job-done/feed", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("opens live job feeds by default", async () => {
    render(<ChainDetailPane chain={chain("running")} />);

    const toggle = await screen.findByRole("button", { name: /terminal feed/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByLabelText("terminal stream")).toHaveTextContent("AUTO+");
  });
});

function chain(status: "done" | "running"): ChainSummary {
  return {
    chainId: "job-done",
    rootBeadId: "forge-1",
    title: "job-done",
    jobs: [{
      repoSlug: "gitboard",
      beadId: "forge-1",
      jobId: "job-done",
      chainId: null,
      epicId: null,
      chainKind: "debugger",
      specialist: "debugger",
      status,
      updatedAt: "2026-05-31T00:01:00.000Z",
      lastOutput: "fallback output",
      turns: 2,
      tools: 4,
      model: "openai-codex/gpt-5.3-codex",
    }],
    status,
    roles: [{ role: "debugger", status }],
    elapsedMs: 0,
    lastMessage: "fallback output",
    lastUpdatedAt: "2026-05-31T00:01:00.000Z",
  };
}
