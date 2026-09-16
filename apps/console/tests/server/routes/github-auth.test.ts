import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { createGithubRouter } from "../../../src/server/routes/github.ts";
import { createDatabase } from "../../../../../packages/core/src/github/database.ts";
import {
  createFileTokenStore,
  createGithubAuthService,
  upsertPr,
  upsertRepo,
  type StoredUserToken,
  type TokenStore,
} from "../../../../../packages/core/src/github/index.ts";
import type { LogEntry } from "../../../../../packages/core/src/runtime/logs.ts";

/**
 * Fake GitHub server: mocked fetch against XTRM_GITHUB_OAUTH_BASE_URL /
 * XTRM_GITHUB_API_BASE_URL overrides. The token endpoint serves a scripted
 * queue; every call records its (faked) timestamp for interval assertions.
 * Flow tests use an in-memory token store and an env client secret so the
 * poll loop performs no real I/O under fake timers.
 */

let dbDir: string;
let secretsDir: string;
let db: Database;
let logLines: string[];
let tokenCalls: Array<{ at: number; body: URLSearchParams }>;
let tokenQueue: Array<Record<string, unknown>>;

const env = () => ({
  XTRM_GITHUB_APP_CLIENT_ID: "Iv23liTESTCLIENT",
  XTRM_GITHUB_APP_SLUG: "xtrm-console",
  XTRM_GITHUB_APP_CLIENT_SECRET: "test-client-secret",
  XTRM_GITHUB_OAUTH_BASE_URL: "https://oauth.fake",
  XTRM_GITHUB_API_BASE_URL: "https://api.fake",
});

/** Test double of the file token store: same semantics, no disk I/O. */
function memoryStore(): TokenStore {
  let rec: StoredUserToken | null = null;
  return {
    kind: "file",
    async get() { return rec; },
    async set(next) { rec = next; },
    async delete() { rec = null; },
  };
}

function seededRecord(token = "ghu_SEEDED_TOKEN"): StoredUserToken {
  const now = Date.now();
  return {
    access_token: token,
    refresh_token: "ghr_SEEDED_REFRESH",
    expires_at: new Date(now + 8 * 60 * 60 * 1000).toISOString(),
    refresh_expires_at: new Date(now + 6 * 30 * 24 * 60 * 60 * 1000).toISOString(),
    obtained_at: new Date(now).toISOString(),
    user: { login: "alice", name: "Alice Doe", avatar_url: "https://avatar.fake/alice.png" },
  };
}

function makeRouter(envOverrides: Record<string, string | undefined> = {}, options: { sharedToken?: boolean; store?: TokenStore } = {}) {
  const merged: Record<string, string> = { ...env(), ...envOverrides } as Record<string, string>;
  for (const key of Object.keys(envOverrides)) if (envOverrides[key] === undefined) delete merged[key];
  const auth = createGithubAuthService({
    env: merged,
    store: options.store ?? memoryStore(),
    registerTokenProvider: false,
    sharedTokenAvailable: () => options.sharedToken ?? false,
  });
  const app = createGithubRouter(db, undefined, (entry: LogEntry) => logLines.push(JSON.stringify(entry)), { auth });
  return { app, auth };
}

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "xtrm404-auth-"));
  secretsDir = mkdtempSync(join(tmpdir(), "xtrm404-secrets-"));
  db = createDatabase(join(dbDir, "state.db"));
  upsertRepo(db, { full_name: "owner/repo", display_name: null, tracked: true, group_name: null, last_polled_at: null, color: null });
  upsertPr(db, {
    repo: "owner/repo", number: 1, title: "PR", body: null, state: "open", author: "alice", url: null,
    additions: null, deletions: null, changed_files: null, comment_count: 0, label_names: null,
    created_at: "2026-09-16T10:00:00Z", updated_at: "2026-09-16T11:00:00Z", merged_at: null, closed_at: null,
  });
  logLines = [];
  tokenCalls = [];
  tokenQueue = [];
  vi.useFakeTimers();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (url === "https://oauth.fake/login/device/code") {
      return jsonResponse({ device_code: "DC_LEAKCODE", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
    }
    if (url === "https://oauth.fake/login/oauth/access_token") {
      tokenCalls.push({ at: Date.now(), body });
      const next = tokenQueue.shift();
      if (!next) throw new Error("fake token endpoint exhausted");
      return jsonResponse(next);
    }
    if (url === "https://api.fake/user") {
      return jsonResponse({ login: "alice", name: "Alice Doe", avatar_url: "https://avatar.fake/alice.png" });
    }
    if (url === "https://api.fake/user/installations") {
      return jsonResponse({
        installations: [{
          id: 42,
          app_slug: "xtrm-console",
          account: { login: "owner", avatar_url: null, html_url: "https://github.com/owner" },
          repository_selection: "selected",
          permissions: { actions: "read", checks: "read", contents: "read", issues: "read", metadata: "read", pull_requests: "read", statuses: "read" },
          html_url: "https://github.com/settings/installations/42",
        }],
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(secretsDir, { recursive: true, force: true });
});

async function pump(ms: number): Promise<void> {
  let left = ms;
  while (left > 0) {
    const step = Math.min(250, left);
    await vi.advanceTimersByTimeAsync(step);
    left -= step;
  }
}

async function signIn(app: ReturnType<typeof createGithubRouter>, token = "ghu_SIGNIN_TOKEN"): Promise<void> {
  tokenQueue.push(
    { error: "authorization_pending" },
    { access_token: token, refresh_token: "ghr_REFRESH1", expires_in: 28800, refresh_token_expires_in: 15897600 },
  );
  const start = await app.request("http://localhost/auth/device/start", { method: "POST" });
  expect(start.status).toBe(202);
  await pump(5400); // poll 1: authorization_pending
  await pump(5400); // poll 2: success
}

describe("GitHub App auth: status and device flow", () => {
  it("reports not_configured without a client id and never crashes", async () => {
    const { app } = makeRouter({ XTRM_GITHUB_APP_CLIENT_ID: undefined });
    const status = await (await app.request("http://localhost/auth/status")).json();
    expect(status).toMatchObject({ state: "not_configured", auth_source: "none" });
    const start = await app.request("http://localhost/auth/device/start", { method: "POST" });
    expect(start.status).toBe(400);
    expect(await start.json()).toMatchObject({ error: "not_configured" });
  });

  it("walks pending -> slow_down (+5s) -> signed_in, polling no faster than the returned interval", async () => {
    tokenQueue.push(
      { error: "authorization_pending" },
      { error: "slow_down", interval: 8 },
      { access_token: "ghu_SUCCESS_TOKEN", refresh_token: "ghr_SUCCESS_REFRESH", expires_in: 28800, refresh_token_expires_in: 15897600 },
    );
    const { app } = makeRouter();

    expect((await (await app.request("http://localhost/auth/status")).json()).state).toBe("signed_out");
    const start = await app.request("http://localhost/auth/device/start", { method: "POST" });
    expect(start.status).toBe(202);
    const startBody = await start.json();
    expect(startBody.device).toMatchObject({ user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 5 });
    expect(JSON.stringify(startBody)).not.toContain("DC_LEAKCODE"); // device_code is never returned

    const pending = await (await app.request("http://localhost/auth/status")).json();
    expect(pending.state).toBe("pending");
    expect(pending.device).toMatchObject({ user_code: "ABCD-1234", interval: 5 });

    // No poll before the interval elapses.
    await pump(4750);
    expect(tokenCalls).toHaveLength(0);
    await pump(500);
    expect(tokenCalls).toHaveLength(1); // t~5s: authorization_pending

    // slow_down: interval must become >= 10s (5+5, max with returned 8).
    await pump(5400);
    expect(tokenCalls).toHaveLength(2);
    // next poll must not fire before another 10s after the slow_down poll
    await pump(8000);
    expect(tokenCalls).toHaveLength(2);
    await pump(2500);
    expect(tokenCalls).toHaveLength(3); // t~20s+: success
    const gaps = tokenCalls.map((call, i) => (i === 0 ? call.at : call.at - tokenCalls[i - 1].at));
    expect(gaps[1]).toBeGreaterThanOrEqual(5000);
    expect(gaps[2]).toBeGreaterThanOrEqual(10000);

    const signedIn = await (await app.request("http://localhost/auth/status")).json();
    expect(signedIn).toMatchObject({ state: "signed_in", auth_source: "user", store: "file", user: { login: "alice", name: "Alice Doe" } });
  });

  it("stops with an expired_token error and returns to signed_out", async () => {
    tokenQueue.push({ error: "expired_token" });
    const { app } = makeRouter();
    await app.request("http://localhost/auth/device/start", { method: "POST" });
    await pump(5400);
    const status = await (await app.request("http://localhost/auth/status")).json();
    expect(status.state).toBe("signed_out");
    expect(status.error).toMatchObject({ code: "expired_token" });
  });

  it("stops on access_denied", async () => {
    tokenQueue.push({ error: "access_denied" });
    const { app } = makeRouter();
    await app.request("http://localhost/auth/device/start", { method: "POST" });
    await pump(5400);
    const status = await (await app.request("http://localhost/auth/status")).json();
    expect(status.state).toBe("signed_out");
    expect(status.error).toMatchObject({ code: "access_denied" });
  });

  it("cancels a pending flow", async () => {
    tokenQueue.push({ error: "authorization_pending" });
    const { app } = makeRouter();
    await app.request("http://localhost/auth/device/start", { method: "POST" });
    await (await app.request("http://localhost/auth/device/cancel", { method: "POST" })).json();
    const status = await (await app.request("http://localhost/auth/status")).json();
    expect(status.state).toBe("signed_out");
    expect(status.device).toBeUndefined();
    await pump(30000);
    expect(tokenCalls).toHaveLength(0); // cancelled before the first poll fired
  });
});

describe("GitHub App auth: refresh and expiry", () => {
  it("refreshes an expired token before use and stays signed_in", async () => {
    tokenQueue.push(
      { error: "authorization_pending" },
      { access_token: "ghu_OLD_TOKEN", refresh_token: "ghr_OLD_REFRESH", expires_in: 10, refresh_token_expires_in: 15897600 },
    );
    const { app, auth } = makeRouter();
    await app.request("http://localhost/auth/device/start", { method: "POST" });
    await pump(10800); // poll 1 pending + poll 2 success (token expires 10s after mint)

    await pump(11_000); // token now past expiry
    tokenQueue.push({ access_token: "ghu_NEW_TOKEN", refresh_token: "ghr_NEW_REFRESH", expires_in: 28800, refresh_token_expires_in: 15897600 });
    const token = await auth.getValidUserToken();
    expect(token).toBe("ghu_NEW_TOKEN");
    const refreshCall = tokenCalls.at(-1);
    expect(refreshCall?.body.get("grant_type")).toBe("refresh_token");
    expect(refreshCall?.body.get("refresh_token")).toBe("ghr_OLD_REFRESH");
    const status = await (await app.request("http://localhost/auth/status")).json();
    expect(status.state).toBe("signed_in");
  });

  it("moves to expired when the refresh fails", async () => {
    tokenQueue.push(
      { error: "authorization_pending" },
      { access_token: "ghu_OLD_TOKEN", refresh_token: "ghr_OLD_REFRESH", expires_in: 10, refresh_token_expires_in: 15897600 },
    );
    const { app, auth } = makeRouter();
    await app.request("http://localhost/auth/device/start", { method: "POST" });
    await pump(32000);
    tokenQueue.push({ error: "invalid_grant" });
    expect(await auth.getValidUserToken()).toBeNull();
    const status = await (await app.request("http://localhost/auth/status")).json();
    expect(status.state).toBe("expired");
    expect(status.error).toMatchObject({ code: "refresh_failed" });
  });
});

describe("GitHub App auth: signout, store, and secret hygiene", () => {
  it("signout deletes the stored token from the file store", async () => {
    const store = createFileTokenStore(secretsDir);
    await store.set(seededRecord());
    const { app } = makeRouter({}, { store });
    expect((await (await app.request("http://localhost/auth/status")).json()).state).toBe("signed_in");
    const signout = await app.request("http://localhost/auth/signout", { method: "POST" });
    expect(await signout.json()).toMatchObject({ state: "signed_out" });
    const after = await (await app.request("http://localhost/auth/status")).json();
    expect(after.state).toBe("signed_out");
    expect(after.user).toBeUndefined();
    expect(() => statSync(join(secretsDir, "github-user-token.json"))).toThrow(/ENOENT/);
  });

  it("writes the token file with 0600 inside a 0700 directory", async () => {
    const store = createFileTokenStore(secretsDir);
    await store.set(seededRecord("ghu_MODECHECK"));
    expect(statSync(join(secretsDir, "github-user-token.json")).mode & 0o777).toBe(0o600);
  });

  it("treats a non-expiring token (expires_at null, no refresh token) as valid", async () => {
    const store = createFileTokenStore(secretsDir);
    await store.set({ ...seededRecord("ghu_NOEXPIRY"), expires_at: null, refresh_expires_at: null, refresh_token: null });
    const { app, auth } = makeRouter({}, { store });
    expect(await auth.getValidUserToken()).toBe("ghu_NOEXPIRY");
    expect((await (await app.request("http://localhost/auth/status")).json()).state).toBe("signed_in");
  });

  it("never leaks the token, refresh token, or device_code into SQLite, logs, or auth responses", async () => {
    const { app } = makeRouter();
    await signIn(app, "ghu_LEAKCHECK_TOKEN");
    // Exercise every auth-facing endpoint after sign-in.
    const responses = [
      await app.request("http://localhost/auth/status"),
      await app.request("http://localhost/auth/installations"),
      await app.request("http://localhost/capabilities?repo=owner/repo"),
      await app.request("http://localhost/prs/owner/repo/1"),
    ];
    const bodies = await Promise.all(responses.map((response) => response.text()));
    const logBlob = logLines.join("\n");

    for (const secret of ["ghu_LEAKCHECK_TOKEN", "ghr_REFRESH1", "DC_LEAKCODE"]) {
      for (const body of bodies) expect(body).not.toContain(secret);
      expect(logBlob).not.toContain(secret);
    }

    // SQLite and every other file under the state dir stay clean.
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
    for (const file of walk(dbDir)) {
      const raw = readFileSync(file, "utf8");
      expect(raw).not.toContain("ghu_LEAKCHECK_TOKEN");
      expect(raw).not.toContain("ghr_REFRESH1");
    }
  });
});

describe("GitHub App installations and capabilities", () => {
  it("lists installations with install_url when signed in", async () => {
    const { app } = makeRouter();
    await signIn(app);
    const body = await (await app.request("http://localhost/auth/installations")).json();
    expect(body.install_url).toBe("https://github.com/apps/xtrm-console/installations/new");
    expect(body.installations).toHaveLength(1);
    expect(body.installations[0]).toMatchObject({
      id: 42,
      account: { login: "owner" },
      repository_selection: "selected",
      html_url: "https://github.com/settings/installations/42",
    });
    expect(body.installations[0].permissions.pull_requests).toBe("read");
  });

  it("returns an empty installation list when signed out", async () => {
    const { app } = makeRouter();
    const body = await (await app.request("http://localhost/auth/installations")).json();
    expect(body).toMatchObject({ install_url: "https://github.com/apps/xtrm-console/installations/new", installations: [] });
  });

  it("maps installed app permissions to read capabilities", async () => {
    const { app } = makeRouter();
    await signIn(app);
    const body = await (await app.request("http://localhost/capabilities?repo=owner/repo")).json();
    expect(body).toEqual({
      auth_source: "user",
      installed: true,
      permissions: { actions: "read", checks: "read", contents: "read", issues: "read", metadata: "read", pull_requests: "read", statuses: "read" },
      can: { read_pulls: true, read_checks: true, read_contents: true, read_issues: true, read_actions: true },
    });
  });

  it("reports not installed for a different owner", async () => {
    const { app } = makeRouter();
    await signIn(app);
    const body = await (await app.request("http://localhost/capabilities?repo=other/repo")).json();
    expect(body).toMatchObject({ auth_source: "user", installed: false });
    expect(body.permissions).toEqual({});
    expect(body.can.read_pulls).toBe(false);
  });

  it("falls back to the shared token capabilities", async () => {
    const { app } = makeRouter({}, { sharedToken: true });
    const body = await (await app.request("http://localhost/capabilities?repo=owner/repo")).json();
    expect(body).toMatchObject({ auth_source: "shared", installed: false, permissions: {} });
    expect(body.can).toEqual({ read_pulls: true, read_checks: true, read_contents: true, read_issues: true, read_actions: true });
  });

  it("reports no capabilities without any credential", async () => {
    const { app } = makeRouter();
    const body = await (await app.request("http://localhost/capabilities?repo=owner/repo")).json();
    expect(body).toEqual({
      auth_source: "none",
      installed: false,
      permissions: {},
      can: { read_pulls: false, read_checks: false, read_contents: false, read_issues: false, read_actions: false },
    });
  });

  it("requires a repo query parameter", async () => {
    const { app } = makeRouter();
    const response = await app.request("http://localhost/capabilities");
    expect(response.status).toBe(400);
  });
});
