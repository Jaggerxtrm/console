import { expect, vi } from "vitest";

export const DASHBOARD_PERFORMANCE_BUDGETS = {
  routeLatencyMs: {
    fast: 250,
    slowLog: 500,
    graphP95: 1_500,
    substrateProjectsP95: 1_000,
    githubListP95: 1_000,
    specialistsJobsP95: 1_000,
  },
  realtime: {
    wsApplyMs: 100,
    staleHttpMustNotOverwriteWs: true,
  },
  fetchCounts: {
    githubInitialLoadMax: 8,
    inactiveTabSwitchMaxUnrelatedFetches: 0,
  },
} as const;

export const DASHBOARD_SLOW_PATHS = [
  "/api/console/graph",
  "/api/substrate/projects",
  "/api/github/prs",
  "/api/specialists/jobs",
] as const;

type FetchLike = typeof fetch;

type FetchCall = {
  url: string;
  pathname: string;
  init?: RequestInit;
};

export type FetchCallCounter = {
  calls: FetchCall[];
  count: (matcher?: string | RegExp | ((call: FetchCall) => boolean)) => number;
  urls: () => string[];
  restore: () => void;
};

function toUrl(input: Parameters<FetchLike>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function toPathname(url: string): string {
  return new URL(url, "http://localhost").pathname;
}

function matches(call: FetchCall, matcher?: string | RegExp | ((call: FetchCall) => boolean)): boolean {
  if (!matcher) return true;
  if (typeof matcher === "string") return call.url.includes(matcher) || call.pathname.includes(matcher);
  if (matcher instanceof RegExp) return matcher.test(call.url) || matcher.test(call.pathname);
  return matcher(call);
}

export function installFetchCallCounter(responseForPath: Record<string, unknown> = {}): FetchCallCounter {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];

  globalThis.fetch = vi.fn(async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const url = toUrl(input);
    const pathname = toPathname(url);
    calls.push({ url, pathname, init });
    const body = responseForPath[pathname] ?? { data: [] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as FetchLike;

  return {
    calls,
    count: (matcher) => calls.filter((call) => matches(call, matcher)).length,
    urls: () => calls.map((call) => call.url),
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

export function createDeferredJsonResponse<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

export function preferFreshByTimestamp<T>(current: T | null, incoming: T, getTimestamp: (item: T) => string | null | undefined): T {
  if (!current) return incoming;
  const currentTs = getTimestamp(current) ?? "";
  const incomingTs = getTimestamp(incoming) ?? "";
  return incomingTs >= currentTs ? incoming : current;
}

export function expectWsStateWinsOverStaleHttp<T>(params: {
  initial: T;
  staleHttp: T;
  wsUpdate: T;
  merge: (current: T | null, incoming: T, source: "http" | "ws") => T;
  getTimestamp: (item: T) => string | null | undefined;
}): void {
  const afterInitial = params.merge(null, params.initial, "http");
  const afterWs = params.merge(afterInitial, params.wsUpdate, "ws");
  const afterLateHttp = params.merge(afterWs, params.staleHttp, "http");

  expect(params.getTimestamp(afterLateHttp)).toBe(params.getTimestamp(params.wsUpdate));
  expect(afterLateHttp).toEqual(params.wsUpdate);
}
