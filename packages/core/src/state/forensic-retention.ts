// Forensic retention (CONSOLE-1 follow-up).
//
// `xtrm_forensic_events` had no retention and reached 18.5 GB of a 22 GB store.
// Two families dominate and neither needs to be kept forever:
//   - `turn.thinking`, 4.76M rows, the full reasoning text of every turn;
//   - idle `materializer.run.completed` rows, now no longer written at all.
//
// Only reasoning text is aged out here. Everything else - tool calls, models,
// jobs, evidence - stays, because it is what provenance reads. A row still
// referenced by `xtrm_evidence_refs` is never deleted, whatever its age.
//
// The reference is `xtrm_evidence_refs.event_source_id` -> `source_event_id`
// (a string such as `forensic:53823`), NOT the integer primary key `id`. An
// earlier version of this guard compared against `id`; integer-to-string
// comparison is never equal in SQLite, so the guard silently protected nothing.

import type { Database } from "bun:sqlite";

/** Reasoning text older than this is pruned. Operator-set (CONSOLE-1, 2026-09-18). */
export const THINKING_RETENTION_DAYS = 20;

export interface ForensicRetentionResult {
  thinkingDeleted: number;
  idleMaterializerDeleted: number;
  cutoffMs: number;
}

export interface ForensicRetentionOptions {
  thinkingRetentionDays?: number;
  /** Test seam. */
  now?: number;
  /** Also sweep idle materializer rows written before the emitter was fixed. */
  includeLegacyIdleMaterializer?: boolean;
}

export function pruneForensicEvents(db: Database, options: ForensicRetentionOptions = {}): ForensicRetentionResult {
  const days = options.thinkingRetentionDays ?? THINKING_RETENTION_DAYS;
  const now = options.now ?? Date.now();
  const cutoffMs = now - days * 24 * 60 * 60 * 1000;

  const thinking = db
    .prepare(
      `DELETE FROM xtrm_forensic_events
       WHERE event_name = 'turn.thinking'
         AND t_unix_ms < ?
         AND source_event_id NOT IN (SELECT event_source_id FROM xtrm_evidence_refs WHERE event_source_id IS NOT NULL)`,
    )
    .run(cutoffMs);

  let idle = { changes: 0 };
  if (options.includeLegacyIdleMaterializer) {
    idle = db
      .prepare(
        `DELETE FROM xtrm_forensic_events
         WHERE event_name = 'materializer.run.completed'
           AND body_json LIKE '%"rows_written":0%'
           AND body_json LIKE '%"dependencies_written":0%'
           AND body_json LIKE '%"forensic_events_written":0%'
           AND body_json LIKE '%"evidence_refs_written":0%'
           AND source_event_id NOT IN (SELECT event_source_id FROM xtrm_evidence_refs WHERE event_source_id IS NOT NULL)`,
      )
      .run() as { changes: number };
  }

  return { thinkingDeleted: Number(thinking.changes ?? 0), idleMaterializerDeleted: Number(idle.changes ?? 0), cutoffMs };
}
