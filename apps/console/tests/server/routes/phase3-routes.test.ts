import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createExploreAgentopsRouter } from "../../../src/server/routes/explore-agentops.ts";
import { createExploreSqlRouter, isLocalDebugRequest, toUpstreamUrl } from "../../../src/server/routes/explore-sql.ts";
import { createSpecialistsConfigRouter } from "../../../src/server/routes/specialists-config.ts";
import { createSpecialistsControlRouter } from "../../../src/server/routes/specialists-control.ts";
import { createSpecialistsRouter, isSpecialistResultRequestAllowed, MAX_REPO_SLUG_FILTERS } from "../../../src/server/routes/specialists.ts";
import type { SpecialistJob } from "../../../src/types/specialists.ts";

describe("Phase 3 Console route ownership slice", () => {
  it("keeps specialists cache bounded and rejects oversized repo filters", async () => {
    let calls = 0;
    const job = specialistJob("running");
    const app = new Hono().route("/api/specialists", createSpecialistsRouter({
      jobsByBead: () => [],
      inFlightJobs: () => { calls += 1; return [job]; },
      recentJobs: () => [],
      chainById: () => [],
    }, { listRepos: () => [], getEpoch: () => 0 }));

    const first = await app.request("http://localhost/api/specialists/jobs/in-flight");
    const second = await app.request("http://localhost/api/specialists/jobs/in-flight");
    const oversized = await app.request(`http://localhost/api/specialists/jobs/in-flight?repo_slug=${Array.from({ length: MAX_REPO_SLUG_FILTERS + 1 }, (_, index) => `repo-${index}`).join(",")}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(calls).toBe(1);
    expect(oversized.status).toBe(200);
    expect((await oversized.json()).freshness).toBe("degraded");
  });

  it("uses the durable xtrm read model when live materialization is unavailable", async () => {
    const db = new Database(":memory:", { create: true });
    db.exec("CREATE TABLE substrate_job_link (repo_slug TEXT, job_id TEXT, issue_id TEXT, substrate_type TEXT, substrate_id TEXT, created_at TEXT)");
    db.exec("CREATE TABLE specialist_jobs (repo_slug TEXT, job_id TEXT, bead_id TEXT, chain_id TEXT, epic_id TEXT, chain_kind TEXT, status TEXT, updated_at TEXT, specialist TEXT, last_output TEXT, turns INTEGER, tools INTEGER, model TEXT, token_input INTEGER, token_output INTEGER, token_cache_read INTEGER, token_cache_creation INTEGER, token_reasoning INTEGER, token_tool INTEGER, usage_source TEXT)");
    db.exec("CREATE TABLE materialization_state (source_key TEXT, last_status TEXT, last_success_at TEXT)");
    db.prepare("INSERT INTO specialist_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("repo-a", "job-1", "bead-1", "chain-1", null, "executor", "running", "2026-07-23T00:00:00.000Z", "executor", "hello", 1, 2, "model", 3, 4, 0, 0, 0, 0, "test");
    db.prepare("INSERT INTO materialization_state VALUES (?, ?, ?)").run("obs:repo-a", "success", "2026-07-23T00:00:00.000Z");
    const app = new Hono().route("/api/specialists", createSpecialistsRouter(undefined, db, { listRepos: () => [], getEpoch: () => 0 }));

    const response = await app.request("http://localhost/api/specialists/jobs/in-flight");
    expect(response.status).toBe(200);
    expect((await response.json()).in_flight[0]).toMatchObject({ jobId: "job-1", repoSlug: "repo-a" });
    db.close();
  });

  it("requires console write authorization and preserves control channels", async () => {
    process.env.CONSOLE_WRITE_ADMIN_TOKEN = "secret";
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const writeControlMessage = vi.fn().mockResolvedValue(undefined);
    const readJob = vi.fn(() => specialistJob("running"));
    const app = new Hono().route("/api/console/specialists", createSpecialistsControlRouter(null, { runCommand, writeControlMessage, readJob, env: { GITBOARD_SPECIALISTS_BIN: "sp" } }));

    const forbidden = await app.request("http://localhost/api/console/specialists/jobs/job-1/stop", { method: "POST", headers: { host: "localhost", origin: "https://evil.example" }, body: "{}" });
    const hostilePeer = await app.request("http://localhost/api/console/specialists/jobs/job-1/stop", { method: "POST", headers: { host: "localhost", origin: "http://localhost", "x-console-write-token": "secret", "x-xtrm-peer-address": "10.0.0.8" }, body: "{}" });
    const stop = await app.request("http://localhost/api/console/specialists/jobs/job-1/stop", { method: "POST", headers: { host: "localhost", "x-console-write-token": "secret" }, body: "{}" });
    const steer = await app.request("http://localhost/api/console/specialists/jobs/job-1/steer", { method: "POST", headers: { host: "localhost", "x-console-write-token": "secret" }, body: JSON.stringify({ message: "continue" }) });

    expect(forbidden.status).toBe(403);
    expect(hostilePeer.status).toBe(403);
    expect(stop.status).toBe(200);
    expect(steer.status).toBe(200);
    expect(runCommand).toHaveBeenCalledWith("sp", ["stop", "job-1"], expect.anything());
    expect(writeControlMessage).toHaveBeenCalledWith("steer", "job-1", "continue", undefined);
  });

  it("rejects forged fetch metadata for protected specialist payloads", () => {
    expect(isSpecialistResultRequestAllowed(new Request("http://localhost/api/specialists/jobs/job-1/result", { headers: { "sec-fetch-site": "same-origin" } }))).toBe(false);
    expect(isSpecialistResultRequestAllowed(new Request("http://localhost/api/specialists/jobs/job-1/result", { headers: { origin: "http://localhost" } }))).toBe(false);
    expect(isSpecialistResultRequestAllowed(new Request("http://localhost/api/specialists/jobs/job-1/result", {
      headers: { "x-gitboard-shell-token": "secret" },
    }), { GITBOARD_SHELL_PROVIDER_ADMIN_TOKEN: "secret" })).toBe(false);
    expect(isSpecialistResultRequestAllowed(new Request("http://localhost/api/specialists/jobs/job-1/result", {
      headers: { "x-gitboard-shell-token": "secret", "x-xtrm-peer-address": "127.0.0.1" },
    }), { GITBOARD_SHELL_PROVIDER_ADMIN_TOKEN: "secret" })).toBe(true);
  });

  it("revalidates the persisted specialist job id before invoking a control channel", async () => {
    process.env.CONSOLE_WRITE_ADMIN_TOKEN = "secret";
    const writeControlMessage = vi.fn().mockResolvedValue(undefined);
    const malicious = { ...specialistJob("running"), jobId: "../../outside" };
    const app = new Hono().route("/api/console/specialists", createSpecialistsControlRouter(null, {
      writeControlMessage,
      readJob: () => malicious,
      env: { GITBOARD_SPECIALISTS_BIN: "sp" },
    }));

    const response = await app.request("http://localhost/api/console/specialists/jobs/bead-1/steer", {
      method: "POST",
      headers: { host: "localhost", "x-console-write-token": "secret" },
      body: JSON.stringify({ message: "continue" }),
    });

    expect(response.status).toBe(500);
    expect(writeControlMessage).not.toHaveBeenCalled();
  });

  it("filters Explore AgentOps and degrades without a database", async () => {
    const db = new Database(":memory:", { create: true });
    db.exec("CREATE TABLE specialist_jobs (repo_slug TEXT, job_id TEXT, bead_id TEXT, specialist TEXT, status TEXT, model TEXT, turns INTEGER, tools INTEGER, token_input INTEGER, token_output INTEGER, token_cache_read INTEGER, token_cache_creation INTEGER, token_reasoning INTEGER, token_tool INTEGER, created_at TEXT, updated_at_ms INTEGER)");
    db.prepare("INSERT INTO specialist_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("repo-a", "job-1", "bead-1", "executor", "error", "model", 2, 3, 4, 5, 0, 0, 0, 0, "2026-07-23T00:00:00.000Z", Date.now());
    const app = new Hono().route("/api/console/explore", createExploreAgentopsRouter(db));
    const response = await app.request("http://localhost/api/console/explore/agentops?repo_slug=repo-a&status=error");
    expect(response.status).toBe(200);
    expect((await response.json()).summary).toMatchObject({ totalJobs: 1, errorJobs: 1 });
    db.close();

    const degraded = await new Hono().route("/api/console/explore", createExploreAgentopsRouter(null)).request("http://localhost/api/console/explore/agentops");
    expect(degraded.status).toBe(200);
    expect((await degraded.json()).source_health.status).toBe("degraded");
  });

  it("keeps the Datasette proxy loopback-only and rewrites safe responses", async () => {
    expect(toUpstreamUrl("http://localhost/explore/sql/foo?x=1", new URL("http://datasette.test/" )).toString()).toBe("http://datasette.test/foo?x=1");
    expect(toUpstreamUrl("http://localhost/explore/sql//169.254.169.254/latest/meta-data", new URL("http://datasette.test/")).toString()).toBe("http://datasette.test/169.254.169.254/latest/meta-data");
    expect(isLocalDebugRequest(new Request("http://127.0.0.1/explore/sql", { headers: { "x-xtrm-peer-address": "127.0.0.1" } }))).toBe(true);
    expect(isLocalDebugRequest(new Request("http://127.0.0.1/explore/sql"))).toBe(false);
    let forwardedHeaders = new Headers();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      forwardedHeaders = new Headers(init?.headers);
      return new Response("ok", { headers: { location: "http://datasette.test/metadata", "set-cookie": "secret=1" } });
    });
    const app = new Hono().route("/explore/sql", createExploreSqlRouter({ datasetteUrl: "http://datasette.test", fetchImpl: fetchImpl as unknown as typeof fetch }));
    const response = await app.request("http://localhost/explore/sql/metadata", { headers: { host: "localhost", "x-forwarded-host": "attacker.example", "x-xtrm-peer-address": "127.0.0.1", accept: "text/html", cookie: "secret=1" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(forwardedHeaders.get("accept")).toBe("text/html");
    expect(forwardedHeaders.has("host")).toBe(false);
    expect(forwardedHeaders.has("x-forwarded-host")).toBe(false);
    expect(forwardedHeaders.has("cookie")).toBe(false);
  });

  it("persists config mutations with the configured write gate", async () => {
    const home = await mkdtemp(join(tmpdir(), "console-specialists-config-"));
    const previousHome = process.env.HOME;
    const previousToken = process.env.CONSOLE_WRITE_ADMIN_TOKEN;
    process.env.HOME = home;
    process.env.CONSOLE_WRITE_ADMIN_TOKEN = "secret";
    try {
      const app = new Hono().route("/api/specialists/config", createSpecialistsConfigRouter({ catalogPath: join(home, "catalog.json"), runCommand: () => ({ ok: true, stdout: "[]", stderr: "", status: 0 }) }));
      const forbidden = await app.request("http://localhost/api/specialists/config/console", { method: "PATCH", headers: { host: "localhost" }, body: "{}" });
      const response = await app.request("http://localhost/api/specialists/config/console", { method: "PATCH", headers: { host: "localhost", "x-console-write-token": "secret" }, body: JSON.stringify({ action: "addRepo", repo: { name: "demo", path: "/tmp/demo" } }) });
      expect(forbidden.status).toBe(403);
      expect(response.status).toBe(200);
      expect(JSON.parse(await readFile(join(home, ".config", "specialists", "console.json"), "utf8")).repos).toEqual([{ name: "demo", path: "/tmp/demo" }]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousToken === undefined) delete process.env.CONSOLE_WRITE_ADMIN_TOKEN; else process.env.CONSOLE_WRITE_ADMIN_TOKEN = previousToken;
      await rm(home, { recursive: true, force: true });
    }
  });
});

function specialistJob(status: string): SpecialistJob {
  return { jobId: "job-1", repoSlug: "repo-a", beadId: "bead-1", chainId: "chain-1", epicId: null, chainKind: "executor", status, updatedAt: "2026-07-23T00:00:00.000Z", specialist: "executor", lastOutput: null, turns: 1, tools: 1, model: "model" };
}
