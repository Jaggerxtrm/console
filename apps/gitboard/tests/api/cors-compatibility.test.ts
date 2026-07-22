import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/server.ts";
import { createXtrmDatabase } from "../../src/core/xtrm-store.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function buildApp() {
  const root = mkdtempSync(join(tmpdir(), "gitboard-cors-compat-"));
  tempDirs.push(root);
  const db = createXtrmDatabase(join(root, "xtrm.sqlite"));
  return createApp(db, db).app;
}

// Locks the hono CORS middleware contract after the GHSA-88fw-hqm2-52qc bump:
// the app mounts bare `cors()` (no `credentials: true`), so it must keep serving
// same-origin traffic and must NOT reflect credentials to arbitrary origins.
describe("hono cors middleware compatibility", () => {
  it("serves same-origin requests successfully", async () => {
    const app = buildApp();
    const res = await app.request("http://localhost:3030/health", {
      headers: { host: "localhost:3030", origin: "http://localhost:3030" },
    });
    expect(res.status).toBe(200);
  });

  it("does not reflect credentialed access to a hostile origin", async () => {
    const app = buildApp();
    const res = await app.request("http://localhost:3030/health", {
      headers: { host: "localhost:3030", origin: "https://evil.example" },
    });
    // Bare cors() uses the wildcard origin and never opts into credentials, so the
    // vulnerable "reflect Origin + Allow-Credentials: true" path stays unreachable.
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    const allowOrigin = res.headers.get("access-control-allow-origin");
    expect(allowOrigin === "*" || allowOrigin === null).toBe(true);
    expect(allowOrigin).not.toBe("https://evil.example");
  });

  it("answers preflight without echoing credentials", async () => {
    const app = buildApp();
    const res = await app.request("http://localhost:3030/health", {
      method: "OPTIONS",
      headers: {
        host: "localhost:3030",
        origin: "https://evil.example",
        "access-control-request-method": "GET",
      },
    });
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});
