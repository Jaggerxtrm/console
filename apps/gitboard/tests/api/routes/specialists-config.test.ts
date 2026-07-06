import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createSpecialistsConfigRouter } from "../../../src/api/routes/specialists-config.ts";

let dir: string;
const originalHome = process.env.HOME;
const originalToken = process.env.CONSOLE_WRITE_ADMIN_TOKEN;
const originalHost = process.env.HOST;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitboard-specialists-config-"));
  process.env.HOME = dir;
  process.env.CONSOLE_WRITE_ADMIN_TOKEN = "secret";
  process.env.HOST = "100.113.49.52";
  await mkdir(join(dir, ".config/specialists"), { recursive: true });
  await writeFile(join(dir, ".config/specialists/user.json"), JSON.stringify({ debugger: { execution: { model: "gpt-4" }, skills: { paths: [] }, beads_write_notes: null } }, null, 2));
  await writeFile(join(dir, ".config/specialists/console.json"), JSON.stringify({ schema_version: 1, base_dirs: [], repos: [] }, null, 2));
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalToken === undefined) delete process.env.CONSOLE_WRITE_ADMIN_TOKEN;
  else process.env.CONSOLE_WRITE_ADMIN_TOKEN = originalToken;
  if (originalHost === undefined) delete process.env.HOST;
  else process.env.HOST = originalHost;
  await rm(dir, { recursive: true, force: true });
});

describe("specialists config router", () => {
  it("reads catalog, user.json, console.json", async () => {
    const app = createApp();
    const res = await app.request("/api/specialists/config", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const json = await res.json() as { specialists: Array<{ name: string }>; userConfig: { content: Record<string, unknown> }; consoleConfig: { content: { repos: unknown[] } } };
    expect(json.specialists.map((entry) => entry.name)).toEqual(["debugger", "executor"]);
    expect(json.userConfig.content).toHaveProperty("debugger");
    expect(json.consoleConfig.content.repos).toEqual([]);
  });

  it("allows same-origin local reads without a token", async () => {
    const app = createApp();
    const res = await app.request("/api/specialists/config", { headers: { host: "localhost" } });
    expect(res.status).toBe(200);
  });

  it("allows configured tailnet host reads without a token", async () => {
    const app = createApp();
    const res = await app.request("http://100.113.49.52:3030/api/specialists/config", { headers: { host: "100.113.49.52:3030" } });
    expect(res.status).toBe(200);
  });

  it("rejects unauthenticated cross-origin reads", async () => {
    const app = createApp();
    const res = await app.request("/api/specialists/config", { headers: { host: "localhost", origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("rejects malformed patch JSON with 400", async () => {
    const app = createApp();
    const res = await app.request("/api/specialists/config/user", { method: "PATCH", headers: authHeaders(), body: "{" });
    expect(res.status).toBe(400);
  });

  it("rolls back user.json when sp edit fails", async () => {
    const app = createApp(() => ({ ok: false, stdout: "", stderr: "nope", status: 1 }));
    const snapshot = await getSnapshot(app);
    const before = await readFile(join(dir, ".config/specialists/user.json"), "utf8");
    const res = await app.request("/api/specialists/config/user", { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ specialist: "debugger", path: "execution.model", op: "set", value: "gpt-5", expectedMtimeMs: snapshot.userConfig.mtimeMs }) });
    expect(res.status).toBe(500);
    expect(JSON.parse(await readFile(join(dir, ".config/specialists/user.json"), "utf8"))).toEqual(JSON.parse(before));
  });

  it("rejects mtime mismatch with 409", async () => {
    const app = createApp();
    const snapshot = await getSnapshot(app);
    await writeFile(join(dir, ".config/specialists/user.json"), JSON.stringify({ debugger: { execution: { model: "other" }, skills: { paths: [] }, beads_write_notes: null } }, null, 2));
    const res = await app.request("/api/specialists/config/user", { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ specialist: "debugger", path: "execution.model", op: "set", value: "gpt-5", expectedMtimeMs: 1 }) });
    expect(res.status).toBe(409);
  });

  it("rejects schema-invalid writes with 422", async () => {
    const app = createApp();
    const snapshot = await getSnapshot(app);
    const res = await app.request("/api/specialists/config/user", { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ specialist: "debugger", path: "execution.timeout_ms", op: "set", value: "bad", expectedMtimeMs: snapshot.userConfig.mtimeMs }) });
    expect(res.status).toBe(422);
  });

  it("updates console registry add remove rescan", async () => {
    const scanned = join(dir, "scan-root/demo-repo/.specialists/db");
    await mkdir(scanned, { recursive: true });
    await writeFile(join(scanned, "observability.db"), "");
    const app = createApp();
    let snapshot = await getSnapshot(app);
    let res = await app.request("/api/specialists/config/console", { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ action: "addBaseDir", baseDir: "~/scan-root", expectedMtimeMs: snapshot.consoleConfig.mtimeMs }) });
    expect(res.status).toBe(200);
    snapshot = await getSnapshot(app);
    res = await app.request("/api/specialists/config/console", { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ action: "addRepo", repo: { name: "manual", path: "/tmp/manual" }, expectedMtimeMs: snapshot.consoleConfig.mtimeMs }) });
    expect(res.status).toBe(200);
    snapshot = await getSnapshot(app);
    res = await app.request("/api/specialists/config/console", { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ action: "removeRepo", previousName: "manual", expectedMtimeMs: snapshot.consoleConfig.mtimeMs }) });
    expect(res.status).toBe(200);
    snapshot = await getSnapshot(app);
    res = await app.request("/api/specialists/config/console", { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ action: "rescan", expectedMtimeMs: snapshot.consoleConfig.mtimeMs }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { content: { repos: Array<{ name: string }> } };
    expect(body.content.repos.map((repo) => repo.name)).toContain("demo-repo");
  });
});

function createApp(runCommand = () => ({ ok: true, stdout: JSON.stringify([{ name: "debugger" }, { name: "executor" }]), stderr: "", status: 0 })) {
  const app = new Hono();
  app.route("/api/specialists/config", createSpecialistsConfigRouter({
    catalogPath: join(dir, "catalog.json"),
    runCommand,
  }));
  return app;
}

async function getSnapshot(app: Hono) {
  const res = await app.request("/api/specialists/config", { headers: authHeaders() });
  return await res.json() as { userConfig: { mtimeMs?: number }; consoleConfig: { mtimeMs?: number } };
}

function authHeaders() {
  return { "Content-Type": "application/json", host: "localhost", "x-console-write-token": "secret" };
}
