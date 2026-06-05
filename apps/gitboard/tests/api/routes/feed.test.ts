import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeedRouter } from "../../../src/api/routes/feed.ts";
import { createXtrmDatabase } from "../../../src/core/xtrm-store.ts";

describe("GET /api/feed", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gitboard-feed-"));
    dbPath = join(tmpDir, "xtrm.sqlite");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rolls up materialized specialists, beads, GitHub, and materializer rows", async () => {
    const db = createXtrmDatabase(dbPath);
    seedFeedRows(db);
    const app = createFeedRouter(db);

    const response = await app.fetch(new Request("http://localhost/?limit=10"));
    expect(response.status).toBe(200);
    const body = await response.json() as { rows: Array<Record<string, unknown>>; cursor: { next: string | null } };

    expect(body.rows.map((row) => row.source)).toEqual(["specialists", "beads", "github", "materializer"]);
    expect(body.rows[0]).toEqual(expect.objectContaining({
      kind: "job_completed",
      redaction_status: "clean",
      drilldown: expect.objectContaining({ job_id: "job-1", forensic_event_ids: [1], evidence_ids: ["commit-1"] }),
    }));
    expect(body.rows[3]).toEqual(expect.objectContaining({ source: "materializer", kind: "malformed_source_row", severity: "warn", status: "degraded", redaction_status: "redacted" }));
    expect(body.rows[0]).not.toHaveProperty("body");
    expect(body.rows[0]).not.toHaveProperty("correlation");
    expect(body.rows[0]).not.toHaveProperty("trace");
    expect(body.cursor.next).toBeNull();

    db.close();
  });

  it("paginates after the opaque (t_unix_ms, seq, id) cursor", async () => {
    const db = createXtrmDatabase(dbPath);
    seedFeedRows(db);
    const app = createFeedRouter(db);

    const first = await (await app.fetch(new Request("http://localhost/?limit=2"))).json() as { rows: Array<{ id: string }>; cursor: { next: string | null } };
    expect(first.rows).toHaveLength(2);
    expect(first.cursor.next).toEqual(expect.any(String));

    const second = await (await app.fetch(new Request(`http://localhost/?limit=10&cursor=${encodeURIComponent(first.cursor.next ?? "")}`))).json() as { rows: Array<{ source: string }>; cursor: { next: string | null } };
    expect(second.rows.map((row) => row.source)).toEqual(["github", "materializer"]);
    expect(second.cursor.next).toBeNull();

    db.close();
  });
});

function seedFeedRows(db: ReturnType<typeof createXtrmDatabase>): void {
  db.prepare(`
    INSERT INTO xtrm_forensic_events (
      source_key, source_event_id, repo_slug, job_id, seq, t_unix_ms, timestamp,
      schema_version, severity, event_family, event_name, event_version,
      resource_json, correlation_json, body_json, redaction_json, trace_json, links_json, diagnostics_json, envelope_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "obs:repo-a",
    "job-1:2",
    "repo-a",
    "job-1",
    2,
    1700000000020,
    "2023-11-14T22:13:20.020Z",
    "xtrm.forensic.v1",
    "info",
    "job",
    "job.completed",
    1,
    JSON.stringify({ participant_role: "executor" }),
    JSON.stringify({ job_id: "job-1" }),
    JSON.stringify({ evidence_refs: [{ kind: "commit", id: "commit-1" }] }),
    JSON.stringify({ status: "clean" }),
    JSON.stringify({ trace_id: "trace-1" }),
    JSON.stringify([]),
    JSON.stringify({}),
    JSON.stringify({ schema_version: "xtrm.forensic.v1", event_name: "job.completed" }),
  );
  db.prepare(`
    INSERT INTO xtrm_forensic_events (
      source_key, source_event_id, repo_slug, job_id, seq, t_unix_ms, timestamp,
      schema_version, severity, event_family, event_name, event_version,
      resource_json, correlation_json, body_json, redaction_json, trace_json, links_json, diagnostics_json, envelope_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "materializer:repo-a",
    "malformed:1",
    "repo-a",
    null,
    1,
    1700000003000,
    "2023-11-14T22:13:23.000Z",
    "xtrm.forensic.v1",
    "warn",
    "materializer",
    "malformed_source_row",
    1,
    JSON.stringify({}),
    JSON.stringify({}),
    JSON.stringify({}),
    JSON.stringify({ status: "redacted" }),
    JSON.stringify({}),
    JSON.stringify([]),
    JSON.stringify({ reason: "malformed" }),
    JSON.stringify({ schema_version: "xtrm.forensic.v1", event_name: "malformed_source_row" }),
  );
  db.prepare("INSERT INTO xtrm_evidence_refs (source_key, repo_slug, evidence_id, evidence_kind, job_id, ref_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("obs:repo-a", "repo-a", "commit-1", "commit", "job-1", JSON.stringify({ sha: "abc123" }), "2023-11-14T22:13:20.020Z");
  db.prepare("INSERT INTO substrate_issues (repo_slug, issue_id, title, state, priority, issue_type, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("repo-a", "forge-q5ki", "Telemetry bridge", "in_progress", 1, "task", "2023-11-14T22:13:21.000Z", "2023-11-14T22:13:21.000Z");
  db.prepare("INSERT INTO github_events (id, type, repo, actor, action, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("gh-1", "pull_request", "owner/repo", "alice", "merged", "PR #4 merged", "2023-11-14T22:13:22.000Z");
}
