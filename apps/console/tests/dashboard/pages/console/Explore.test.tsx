/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Explore } from "../../../../src/dashboard/pages/console/Explore.tsx";

const logClientEvent = vi.fn();

vi.mock("../../../../src/dashboard/lib/client-log.ts", () => ({
  logClientEvent: (...args: unknown[]) => logClientEvent(...args),
}));

const agentopsPayload = {
  filters: { range: "7d", repoSlug: null, specialist: null, model: null, status: null },
  summary: { totalJobs: 3, activeJobs: 1, doneJobs: 1, errorJobs: 1, tokenTotal: 270, turnsTotal: 13, toolsTotal: 13 },
  facets: {
    repoSlugs: [{ value: "gitboard", count: 2 }, { value: "specialists", count: 1 }],
    specialists: [{ value: "executor", count: 2 }, { value: "reviewer", count: 1 }],
    models: [{ value: "gpt-5", count: 2 }],
    statuses: [{ value: "done", count: 1 }, { value: "error", count: 1 }, { value: "running", count: 1 }],
  },
  statusBreakdown: [{ status: "done", count: 1 }, { status: "error", count: 1 }, { status: "running", count: 1 }],
  specialistLeaderboard: [{ specialist: "executor", jobs: 2, tokenTotal: 220, turnsTotal: 11, toolsTotal: 10 }],
  modelLeaderboard: [{ model: "gpt-5", jobs: 2, tokenTotal: 180, turnsTotal: 6, toolsTotal: 12 }],
  recentJobs: [{ jobId: "job-2", beadId: "forge-b", repoSlug: "gitboard", specialist: "reviewer", status: "error", model: "gpt-5", updatedAtMs: 1782641280000, elapsedMs: 480000, tokenTotal: 50, turns: 2, tools: 3 }],
  slowestJobs: [{ jobId: "job-2", beadId: "forge-b", repoSlug: "gitboard", specialist: "reviewer", status: "error", model: "gpt-5", updatedAtMs: 1782641280000, elapsedMs: 480000, tokenTotal: 50, turns: 2, tools: 3 }],
  source_health: { source: "explore-agentops", status: "fresh", metadata: {} },
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const href = String(url);
    if (href.startsWith("/api/console/explore/agentops")) {
      return new Response(JSON.stringify(agentopsPayload), { headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }));
  window.history.pushState({}, "", "/console/explore");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Explore page", () => {
  it("defaults to native AgentOps without rendering Datasette iframe", async () => {
    render(<Explore />);

    expect(screen.getByRole("tab", { name: /agentops/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTitle(/datasette/i)).not.toBeInTheDocument();

    expect(await screen.findByText("3 jobs")).toBeInTheDocument();
    expect(screen.getByText("Status distribution")).toBeInTheDocument();
    expect(screen.getByText("Specialist leaderboard")).toBeInTheDocument();
    expect(screen.getAllByText("job-2").length).toBeGreaterThan(0);
    expect(logClientEvent).toHaveBeenCalledWith("explore_agentops_loaded", expect.objectContaining({ component: "explore", total_jobs: 3 }));
  });

  it("syncs filter changes into the AgentOps API query", async () => {
    render(<Explore />);

    await screen.findByText("3 jobs");
    fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "gitboard" } });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining("repo_slug=gitboard"), expect.any(Object));
    });
    expect(logClientEvent).toHaveBeenCalledWith("explore_filter_changed", expect.objectContaining({ filter: "repo_slug" }));
  });

  it("soft-handles legacy /sql paths as native AgentOps", async () => {
    window.history.pushState({}, "", "/console/explore/sql");

    render(<Explore />);

    expect(screen.getByRole("tab", { name: /agentops/i })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText(/SQL debug moved out of primary flow/i)).toBeInTheDocument();
    expect(screen.queryByTitle(/datasette/i)).not.toBeInTheDocument();
  });

  it("keeps Forensic and Prometheus tabs as explicit follow-up surfaces", () => {
    render(<Explore />);

    fireEvent.click(screen.getByRole("tab", { name: /forensic/i }));
    expect(window.location.pathname).toBe("/console/explore/forensic");
    expect(screen.getByText("forge-l5mf")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /prometheus/i }));
    expect(window.location.pathname).toBe("/console/explore/prom");
    expect(screen.getByText("forge-qixi")).toBeInTheDocument();
  });

  it("emits bounded drilldown telemetry for job links", async () => {
    render(<Explore />);

    fireEvent.click(await screen.findByRole("link", { name: /slow job job-2/i }));

    expect(logClientEvent).toHaveBeenCalledWith("explore_job_drilldown", expect.objectContaining({ component: "explore", job_hash: expect.stringMatching(/^[a-f0-9]{8}$/) }));
  });
});
