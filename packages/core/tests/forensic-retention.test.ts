import { afterEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { pruneForensicEvents, THINKING_RETENTION_DAYS } from "../src/state/forensic-retention.ts";

const NOW = Date.parse("2026-09-18T00:00:00Z");
const DAY = 86_400_000;
let db: Database;

function seed(): Database {
  const d = new Database(":memory:");
  // Mirrors the real schema: an INTEGER primary key plus the string `source_event_id`
  // that evidence actually points at. The first version of this fixture used a text
  // `id` and hid a guard that compared the wrong column (CONSOLE-1).
  d.exec(`CREATE TABLE xtrm_forensic_events (id INTEGER PRIMARY KEY AUTOINCREMENT, source_event_id TEXT, event_family TEXT, event_name TEXT, t_unix_ms INTEGER, body_json TEXT);
          CREATE TABLE xtrm_evidence_refs (id INTEGER PRIMARY KEY, event_source_id TEXT);`);
  const add = (sourceEventId: string, name: string, ageDays: number, body = "{}") =>
    d.prepare("INSERT INTO xtrm_forensic_events (source_event_id, event_family, event_name, t_unix_ms, body_json) VALUES (?,?,?,?,?)").run(sourceEventId, name.split(".")[0], name, NOW - ageDays * DAY, body);
  add("old-thinking", "turn.thinking", 21);
  add("fresh-thinking", "turn.thinking", 19);
  add("cited-thinking", "turn.thinking", 90);
  add("old-tool", "tool.call", 200);
  add("old-text", "turn.text", 200);
  add("idle-run", "materializer.run.completed", 30, '{"rows_written":0,"dependencies_written":0,"forensic_events_written":0,"evidence_refs_written":0}');
  add("useful-run", "materializer.run.completed", 30, '{"rows_written":12,"dependencies_written":0,"forensic_events_written":0,"evidence_refs_written":0}');
  d.prepare("INSERT INTO xtrm_evidence_refs VALUES (1, 'cited-thinking')").run();
  return d;
}

const ids = () => (db.query("select source_event_id from xtrm_forensic_events order by source_event_id").all() as Array<{ source_event_id: string }>).map((r) => r.source_event_id);

afterEach(() => {
  try {
    db?.close();
  } catch {
    // a test that never seeded leaves nothing to close
  }
});

describe("forensic retention", () => {
  it("ages out reasoning text past the window and keeps everything else", () => {
    db = seed();
    const result = pruneForensicEvents(db, { now: NOW });
    expect(result.thinkingDeleted).toBe(1);
    // Fresh reasoning, other families and older-but-cited rows all survive.
    expect(ids()).toEqual(["cited-thinking", "fresh-thinking", "idle-run", "old-text", "old-tool", "useful-run"]);
  });

  it("never deletes a row referenced by evidence, however old", () => {
    db = seed();
    pruneForensicEvents(db, { now: NOW, thinkingRetentionDays: 1 });
    expect(ids()).toContain("cited-thinking");
  });

  it("sweeps legacy idle materializer rows only when asked, and keeps runs that wrote something", () => {
    db = seed();
    const off = pruneForensicEvents(db, { now: NOW });
    expect(off.idleMaterializerDeleted).toBe(0);
    const on = pruneForensicEvents(db, { now: NOW, includeLegacyIdleMaterializer: true });
    expect(on.idleMaterializerDeleted).toBe(1);
    expect(ids()).toContain("useful-run");
    expect(ids()).not.toContain("idle-run");
  });

  it("keeps the operator-set window visible rather than buried in a call site", () => {
    expect(THINKING_RETENTION_DAYS).toBe(20);
  });
});
