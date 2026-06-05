/** @vitest-environment happy-dom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainSummary } from "../../../../src/dashboard/hooks/useChains.ts";

vi.mock("../../../../src/dashboard/lib/client-log.ts", () => ({
  logClientEvent: vi.fn(),
}));

import { ChainDetailPane } from "../../../../src/dashboard/pages/console/specialists/ChainDetailPane.tsx";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/feed-events")) {
      return new Response(JSON.stringify({ events: [
        {
          schema_version: 1,
          event_family: "chain",
          event_name: "participant_joined",
          resource: { participant_kind: "agent", participant_role: "executor" },
          correlation: { job_id: "job-done" },
          body: { evidence_refs: [{ kind: "commit", id: "commit-1", sha: "abc123" }, { kind: "pr", id: "pr-4", number: 4 }] },
          redaction: { status: "redacted" },
          trace: { trace_id: "trace-1", span_id: "span-1" },
          links: [{ kind: "dashboard", href: "/dash/job-done" }],
        },
      ] }), { status: 200 });
    }
    return new Response(JSON.stringify({ text: "DONE\nAUTO+\ncomplete" }), { status: 200 });
  }));
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
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByLabelText("terminal stream").then((node) => node.textContent)).toContain("AUTO+");
  });

  it("renders forensic feed events and keeps result fallback", async () => {
    render(<ChainDetailPane chain={chain("done")} />);

    await waitFor(() => expect(screen.getByText("forensic events")).toBeTruthy());
    expect(screen.getByText("v1").textContent).toBe("v1");
    expect(screen.getByText("chain/participant_joined").textContent).toBe("chain/participant_joined");
    expect(screen.getByText("agent/executor").textContent).toBe("agent/executor");
    expect(screen.getByText("job:job-done").textContent).toBe("job:job-done");
    expect(screen.getByText("redacted").textContent).toBe("redacted");
    expect(screen.getByText("evidence: commit:commit-1, pr:pr-4")).toBeInTheDocument();
    expect(screen.getByText("trace")).toBeInTheDocument();
    expect(screen.getByText("links:1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run result/i })).toBeTruthy();
  });

  it("falls back when forensic feed endpoint fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/feed-events")) return new Response("nope", { status: 404 });
      return new Response(JSON.stringify({ text: "DONE\nAUTO+\ncomplete" }), { status: 200 });
    }));

    render(<ChainDetailPane chain={chain("done")} />);

    expect(await screen.findByRole("button", { name: /run result/i })).toBeTruthy();
    expect(screen.queryByText("forensic events")).toBeNull();
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
