import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createXtrmDatabase } from "../../../src/core/xtrm-store.ts";
import { createBeadsWriteRouter } from "../../../src/api/routes/beads-write.ts";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { BeadIssue } from "../../../src/types/beads.ts";

const originalPrimaryToken = process.env.CONSOLE_WRITE_ADMIN_TOKEN;
const originalLegacyToken = process.env.GITBOARD_SOURCES_ADMIN_TOKEN;

describe("beads write routes", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gitboard-beads-write-"));
    process.env.CONSOLE_WRITE_ADMIN_TOKEN = "primary-secret";
    delete process.env.GITBOARD_SOURCES_ADMIN_TOKEN;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalPrimaryToken === undefined) delete process.env.CONSOLE_WRITE_ADMIN_TOKEN;
    else process.env.CONSOLE_WRITE_ADMIN_TOKEN = originalPrimaryToken;
    if (originalLegacyToken === undefined) delete process.env.GITBOARD_SOURCES_ADMIN_TOKEN;
    else process.env.GITBOARD_SOURCES_ADMIN_TOKEN = originalLegacyToken;
  });

  it("rejects non-admin write requests", async () => {
    const db = createDb(tmpDir);
    const app = createBeadsWriteRouter(db);

    const response = await app.fetch(new Request("http://localhost/projects/demo/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost" },
      body: JSON.stringify({ title: "Alpha" }),
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    db.close();
  });

  it("creates issue with correct bd args and cwd", async () => {
    const db = createDb(tmpDir);
    const runBdCommand = vi.fn(async () => ({
      stdout: JSON.stringify({ issue: makeIssue({ id: "forge-123", title: "Alpha" }) }),
      stderr: "",
      exitCode: 0,
    }));
    const app = createBeadsWriteRouter(db, { runBdCommand });

    const response = await app.fetch(new Request("http://localhost/projects/demo/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost", "x-console-write-token": "primary-secret" },
      body: JSON.stringify({ title: "Alpha", description: "Desc", priority: 1, type: "task", assignee: "alice", labels: ["ui", "api"] }),
    }));

    expect(response.status).toBe(200);
    expect(runBdCommand).toHaveBeenCalledWith(join(tmpDir, "demo"), [
      "-C", join(tmpDir, "demo"),
      "--json", "--actor", "console", "--dolt-auto-commit", "on",
      "create", "Alpha",
      "--description", "Desc",
      "--priority", "1",
      "--type", "task",
      "--assignee", "alice",
      "--label", "ui",
      "--label", "api",
    ], "create");
    expect(await response.json()).toEqual({ issue: makeIssue({ id: "forge-123", title: "Alpha" }) });
    db.close();
  });

  it("updates issue with patch args and returns updated bead from reader fallback", async () => {
    const db = createDb(tmpDir);
    const runBdCommand = vi.fn(async () => ({ stdout: JSON.stringify({ ok: true, issue_id: "forge-123" }), stderr: "", exitCode: 0 }));
    const readIssue = vi.fn(() => makeIssue({ id: "forge-123", title: "Updated", status: "blocked", labels: ["p1"] }));
    const app = createBeadsWriteRouter(db, { runBdCommand, readIssue });

    const response = await app.fetch(new Request("http://localhost/projects/demo/issues/forge-123", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", host: "localhost", origin: "http://localhost" },
      body: JSON.stringify({ title: "Updated", status: "blocked", priority: 0, labels: { add: ["p1"], remove: ["old"] } }),
    }));

    expect(response.status).toBe(200);
    expect(runBdCommand).toHaveBeenCalledWith(join(tmpDir, "demo"), [
      "-C", join(tmpDir, "demo"),
      "--json", "--actor", "console", "--dolt-auto-commit", "on",
      "update", "forge-123",
      "--title", "Updated",
      "--priority", "0",
      "--status", "blocked",
      "--add-label", "p1",
      "--remove-label", "old",
    ], "update");
    expect(readIssue).toHaveBeenCalledWith("demo", "forge-123");
    expect(await response.json()).toEqual({ issue: makeIssue({ id: "forge-123", title: "Updated", status: "blocked", labels: ["p1"] }) });
    db.close();
  });

  it("rejects empty update patches without running bd", async () => {
    const db = createDb(tmpDir);
    const runBdCommand = vi.fn();
    const app = createBeadsWriteRouter(db, { runBdCommand });

    const response = await app.fetch(new Request("http://localhost/projects/demo/issues/forge-123", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", host: "localhost", "x-console-write-token": "primary-secret" },
      body: JSON.stringify({ labels: {} }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "No update fields provided" });
    expect(runBdCommand).not.toHaveBeenCalled();
    db.close();
  });

  it("rejects hyphen-prefixed issue identifiers before running bd", async () => {
    const db = createDb(tmpDir);
    const runBdCommand = vi.fn();
    const app = createBeadsWriteRouter(db, { runBdCommand });
    const headers = { "Content-Type": "application/json", host: "localhost", "x-console-write-token": "primary-secret" };

    const updateResponse = await app.fetch(new Request("http://localhost/projects/demo/issues/-forge-123", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "blocked" }),
    }));
    const dependencyResponse = await app.fetch(new Request("http://localhost/projects/demo/issues/forge-123/dependencies", {
      method: "POST",
      headers,
      body: JSON.stringify({ dependsOnIssueId: "-forge-456" }),
    }));

    expect(updateResponse.status).toBe(400);
    expect(await updateResponse.json()).toEqual({ error: "invalid issueId" });
    expect(dependencyResponse.status).toBe(400);
    expect(await dependencyResponse.json()).toEqual({ error: "invalid dependsOnIssueId" });
    expect(runBdCommand).not.toHaveBeenCalled();
    db.close();
  });

  it("closes, reopens, comments, notes, adds dependency, sets priority, and deletes with correct templates", async () => {
    const db = createDb(tmpDir);
    const runBdCommand = vi.fn(async (_repoPath: string, command: string[]) => {
      const op = command[7];
      if (op === "delete") return { stdout: JSON.stringify({ ok: true }), stderr: "", exitCode: 0 };
      const dependencies = op === "dep" ? [{ id: "forge-456", title: "Blocker", status: "open", dependency_type: "blocks" as const }] : [];
      return { stdout: JSON.stringify({ issue: makeIssue({ id: "forge-123", title: op, status: op === "close" ? "closed" : "open", priority: op === "priority" ? 1 : 2, dependencies }) }), stderr: "", exitCode: 0 };
    });
    const app = createBeadsWriteRouter(db, { runBdCommand });

    const closeResponse = await app.fetch(new Request("http://localhost/projects/demo/issues/forge-123/close", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost", "x-console-write-token": "primary-secret" },
      body: JSON.stringify({ reason: "done" }),
    }));
    const reopenResponse = await app.fetch(new Request("http://localhost/projects/demo/issues/forge-123/reopen", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost", "x-console-write-token": "primary-secret" },
      body: "{}",
    }));
    const commentResponse = await app.fetch(new Request("http://localhost/projects/demo/issues/forge-123/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost", "x-console-write-token": "primary-secret" },
      body: JSON.stringify({ text: "ship it" }),
    }));
    const noteResponse = await app.fetch(new Request("http://localhost/projects/demo/issues/forge-123/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost", "x-console-write-token": "primary-secret" },
      body: JSON.stringify({ text: "kept note" }),
    }));
    const dependencyResponse = await app.fetch(new Request("http://localhost/projects/demo/issues/forge-123/dependencies", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost", "x-console-write-token": "primary-secret" },
      body: JSON.stringify({ dependsOnIssueId: "forge-456" }),
    }));
    const priorityResponse = await app.fetch(new Request("http://localhost/projects/demo/issues/forge-123/priority", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost", "x-console-write-token": "primary-secret" },
      body: JSON.stringify({ priority: 1 }),
    }));
    const deleteResponse = await app.fetch(new Request("http://localhost/projects/demo/issues/forge-123", {
      method: "DELETE",
      headers: { host: "localhost", "x-console-write-token": "primary-secret" },
    }));

    expect(closeResponse.status).toBe(200);
    expect(reopenResponse.status).toBe(200);
    expect(commentResponse.status).toBe(200);
    expect(noteResponse.status).toBe(200);
    expect(dependencyResponse.status).toBe(200);
    expect(priorityResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(200);
    expect(runBdCommand.mock.calls.map((call) => call[1])).toEqual([
      ["-C", join(tmpDir, "demo"), "--json", "--actor", "console", "--dolt-auto-commit", "on", "close", "forge-123", "--reason", "done"],
      ["-C", join(tmpDir, "demo"), "--json", "--actor", "console", "--dolt-auto-commit", "on", "reopen", "forge-123"],
      ["-C", join(tmpDir, "demo"), "--json", "--actor", "console", "--dolt-auto-commit", "on", "comment", "forge-123", "ship it"],
      ["-C", join(tmpDir, "demo"), "--json", "--actor", "console", "--dolt-auto-commit", "on", "note", "forge-123", "kept note"],
      ["-C", join(tmpDir, "demo"), "--json", "--actor", "console", "--dolt-auto-commit", "on", "dep", "add", "forge-123", "forge-456"],
      ["-C", join(tmpDir, "demo"), "--json", "--actor", "console", "--dolt-auto-commit", "on", "priority", "forge-123", "1"],
      ["-C", join(tmpDir, "demo"), "--json", "--actor", "console", "--dolt-auto-commit", "on", "delete", "forge-123"],
    ]);
    expect(await dependencyResponse.json()).toEqual({ issue: makeIssue({ id: "forge-123", title: "dep", dependencies: [{ id: "forge-456", title: "Blocker", status: "open", dependency_type: "blocks" }] }) });
    expect(await priorityResponse.json()).toEqual({ issue: makeIssue({ id: "forge-123", title: "priority", priority: 1 }) });
    expect(await deleteResponse.json()).toEqual({ ok: true, issueId: "forge-123", projectId: "demo" });
    db.close();
  });

  it("rejects invalid comment, note, dependency, and priority payloads", async () => {
    const db = createDb(tmpDir);
    const runBdCommand = vi.fn();
    const app = createBeadsWriteRouter(db, { runBdCommand });
    const headers = { "Content-Type": "application/json", host: "localhost", "x-console-write-token": "primary-secret" };

    const responses = await Promise.all([
      app.fetch(new Request("http://localhost/projects/demo/issues/forge-123/comments", { method: "POST", headers, body: JSON.stringify({ text: "" }) })),
      app.fetch(new Request("http://localhost/projects/demo/issues/forge-123/notes", { method: "POST", headers, body: JSON.stringify({ text: "" }) })),
      app.fetch(new Request("http://localhost/projects/demo/issues/forge-123/dependencies", { method: "POST", headers, body: JSON.stringify({ dependsOnIssueId: "" }) })),
      app.fetch(new Request("http://localhost/projects/demo/issues/forge-123/priority", { method: "POST", headers, body: JSON.stringify({ priority: 9 }) })),
    ]);

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400]);
    expect(runBdCommand).not.toHaveBeenCalled();
    db.close();
  });

  it("sanitizes bd failure responses", async () => {
    const db = createDb(tmpDir);
    const runBdCommand = vi.fn(async () => ({
      stdout: "stdout token /tmp/secret-output.json",
      stderr: "stderr secret-token /tmp/demo/.beads/store.db",
      exitCode: 1,
    }));
    const app = createBeadsWriteRouter(db, { runBdCommand });

    const response = await app.fetch(new Request("http://localhost/projects/demo/issues/forge-123/close", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost", "x-console-write-token": "primary-secret" },
      body: JSON.stringify({ reason: "done" }),
    }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "bd close failed" });
    db.close();
  });
});

function createDb(tmpDir: string) {
  const repoDir = join(tmpDir, "demo");
  const beadsDir = join(repoDir, ".beads");
  mkdirSync(beadsDir, { recursive: true });
  const db = createXtrmDatabase(join(tmpDir, "xtrm.sqlite"));
  db.query("INSERT INTO sources (source_key, kind, path, origin, status) VALUES ('beads:demo', 'beads', ?, 'manual', 'active')").run(beadsDir);
  return db;
}

function makeIssue(overrides: Partial<BeadIssue>): BeadIssue {
  return {
    id: overrides.id ?? "forge-1",
    title: overrides.title ?? "Issue",
    description: overrides.description ?? null,
    notes: overrides.notes ?? null,
    status: overrides.status ?? "open",
    priority: overrides.priority ?? 2,
    issue_type: overrides.issue_type ?? "task",
    owner: overrides.owner ?? null,
    created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
    created_by: overrides.created_by ?? null,
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00.000Z",
    closed_at: overrides.closed_at,
    close_reason: overrides.close_reason,
    project_id: overrides.project_id ?? "demo",
    dependencies: overrides.dependencies ?? [],
    parent_id: overrides.parent_id,
    related_ids: overrides.related_ids ?? [],
    labels: overrides.labels ?? [],
    assignee: overrides.assignee,
    metadata: overrides.metadata,
    formula_name: overrides.formula_name,
    template_name: overrides.template_name,
  };
}
