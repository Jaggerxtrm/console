import { afterEach, describe, expect, it } from "vitest";
import {
  DASHBOARD_PERFORMANCE_BUDGETS,
  DASHBOARD_SLOW_PATHS,
  expectWsStateWinsOverStaleHttp,
  installFetchCallCounter,
  preferFreshByTimestamp,
} from "./realtime-helpers.ts";

type VersionedRecord = {
  repo: string;
  number: number;
  title: string;
  updated_at: string;
};

let fetchCounter: ReturnType<typeof installFetchCallCounter> | null = null;

afterEach(() => {
  fetchCounter?.restore();
  fetchCounter = null;
});

describe("dashboard performance budgets", () => {
  it("names every currently known slow dashboard path", () => {
    expect(DASHBOARD_SLOW_PATHS).toEqual([
      "/api/console/graph",
      "/api/beads/projects",
      "/api/github/prs",
      "/api/specialists/jobs",
    ]);
  });

  it("keeps the realtime budget stricter than route slow logging", () => {
    expect(DASHBOARD_PERFORMANCE_BUDGETS.realtime.wsApplyMs).toBeLessThan(
      DASHBOARD_PERFORMANCE_BUDGETS.routeLatencyMs.slowLog,
    );
    expect(DASHBOARD_PERFORMANCE_BUDGETS.realtime.staleHttpMustNotOverwriteWs).toBe(true);
  });
});

describe("fetch-count instrumentation", () => {
  it("counts endpoint families so inactive tab requests can be detected", async () => {
    fetchCounter = installFetchCallCounter({
      "/api/github/events": { data: [] },
      "/api/console/graph": { nodes: [], edges: [] },
    });

    await fetch("/api/github/events?limit=50");
    await fetch("/api/console/graph?project_id=repo");
    await fetch("/api/github/events?limit=50&offset=50");

    expect(fetchCounter.count("/api/github/events")).toBe(2);
    expect(fetchCounter.count("/api/console/graph")).toBe(1);
    expect(fetchCounter.count((call) => call.pathname.startsWith("/api/github"))).toBe(2);
  });
});

describe("realtime stale-response guard", () => {
  it("documents the invariant that a later stale HTTP payload cannot overwrite a newer WS update", () => {
    const initial: VersionedRecord = {
      repo: "owner/repo",
      number: 1,
      title: "initial",
      updated_at: "2026-05-20T10:00:00.000Z",
    };
    const staleHttp: VersionedRecord = {
      ...initial,
      title: "stale-http",
      updated_at: "2026-05-20T10:01:00.000Z",
    };
    const wsUpdate: VersionedRecord = {
      ...initial,
      title: "ws-wins",
      updated_at: "2026-05-20T10:02:00.000Z",
    };

    expectWsStateWinsOverStaleHttp({
      initial,
      staleHttp,
      wsUpdate,
      merge: (current, incoming) => preferFreshByTimestamp(current, incoming, (item) => item.updated_at),
      getTimestamp: (item) => item.updated_at,
    });
  });
});
