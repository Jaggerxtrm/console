import type { AttachPoolLike } from "./types.js";

export type TimeRange = "7d" | "30d" | "all";

export interface ObservabilitySummary {
  range: TimeRange;
  tokens: {
    totals: TokenTotals;
    bySpecialist: TokenGroup[];
    byModel: ModelTokenGroup[];
  };
  cacheHitRate: { bySpecialist: HitRateGroup[]; byModel: ModelHitRateGroup[] };
  averages: AverageRow[];
  activeRuntime: { bySpecialist: RuntimeGroup[]; byModel: ModelRuntimeGroup[] };
  reliability: ReliabilityRow[];
  slowestJobs: SlowJob[];
  toolUsage: { totals: ToolCount[]; bySpecialist: ToolCrossTab[] };
  reviewerOutcomes: OutcomeCounts;
  contextBurn: ContextBurnRow[];
  stalls: { bySpecialist: StallGroup[]; longest: LongestStall[] };
  chains: { lengthHistogram: ChainBucket[]; epics: EpicCount[] };
}

type TokenTotals = { input: number; output: number; cacheCreation: number; cacheRead: number; total: number };
type TokenGroup = TokenTotals & { specialist: string };
type ModelTokenGroup = TokenTotals & { model: string };
type HitRateGroup = { specialist: string; hitRate: number };
type ModelHitRateGroup = { model: string; hitRate: number };
type AverageRow = { specialist: string; avgTokens: number; avgElapsedMs: number; avgTurns: number; avgTools: number };
type RuntimeGroup = { specialist: string; ms: number };
type ModelRuntimeGroup = { model: string; ms: number };
type ReliabilityRow = { specialist: string; done: number; error: number; cancelled: number; staleWarnings: number };
type SlowJob = { jobId: string; specialist: string; beadId: string; model: string; elapsedMs: number; turns: number; tools: number };
type ToolCount = { tool: string; count: number };
type ToolCrossTab = { specialist: string; tools: ToolCount[] };
type OutcomeCounts = { pass: number; partial: number; fail: number; unknown: number };
type ContextBurnRow = { specialist: string; avgFinalContextPct: number };
type StallGroup = { specialist: string; totalMs: number; staleWarnings: number };
type LongestStall = { jobId: string; specialist: string; totalMs: number };
type ChainBucket = { bucket: "1" | "2" | "3-5" | "6-10" | "10+"; count: number };
type EpicCount = { status: string; count: number };

type Row = {
  specialist: string;
  model: string;
  job_id: string;
  bead_id: string;
  status: string;
  elapsed_ms: number;
  active_runtime_ms: number;
  total_turns: number;
  total_tools: number;
  token_trajectory_json: string | null;
  context_trajectory_json: string | null;
  stall_gaps_json: string | null;
  tool_call_counts_json: string | null;
  run_complete_json: string | null;
  result_output: string | null;
  updated_at_ms: number;
};

export function createMetricsDao(pool: AttachPoolLike) {
  return { summary: (range: TimeRange): ObservabilitySummary => pool.withAttached((db, attached) => summarize(db, attached, range)) };
}

function summarize(db: { prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown } }, attached: ReadonlyArray<{ alias: string }>, range: TimeRange): ObservabilitySummary {
  const cutoff = range === "all" ? 0 : Date.now() - (range === "7d" ? 7 : 30) * 86400000;
  const rows = attached.flatMap(({ alias }) => loadRows(db, alias, cutoff));
  return {
    range,
    tokens: { totals: sumTokens(rows), bySpecialist: tokensBy(rows, (r) => r.specialist, "specialist"), byModel: tokensBy(rows, (r) => r.model, "model") },
    cacheHitRate: { bySpecialist: hitRates(rows, (r) => r.specialist, "specialist"), byModel: hitRates(rows, (r) => r.model, "model") },
    averages: averages(rows),
    activeRuntime: { bySpecialist: runtimeBy(rows, (r) => r.specialist, "specialist"), byModel: runtimeBy(rows, (r) => r.model, "model") },
    reliability: reliability(rows),
    slowestJobs: slowestJobs(rows),
    toolUsage: toolUsage(rows),
    reviewerOutcomes: reviewerOutcomes(rows),
    contextBurn: contextBurn(rows),
    stalls: stalls(rows),
    chains: chains(rows),
  };
}

function loadRows(db: { prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown } }, alias: string, cutoff: number): Row[] {
  if (!hasSpecialistJobMetrics(db, alias)) return [];
  return db.prepare(`
    SELECT COALESCE(j.specialist, 'unknown') AS specialist, COALESCE(m.model, 'unknown') AS model,
      j.job_id, j.bead_id, j.status, COALESCE(m.elapsed_ms, COALESCE(m.completed_at_ms, 0) - COALESCE(m.started_at_ms, 0), 0) AS elapsed_ms,
      COALESCE(m.active_runtime_ms, 0) AS active_runtime_ms, COALESCE(m.total_turns, 0) AS total_turns, COALESCE(m.total_tools, 0) AS total_tools,
      m.token_trajectory_json, m.context_trajectory_json, m.stall_gaps_json, m.tool_call_counts_json, m.run_complete_json,
      r.output AS result_output, COALESCE(m.updated_at_ms, j.updated_at_ms, 0) AS updated_at_ms
    FROM ${alias}.specialist_jobs AS j
    LEFT JOIN ${alias}.specialist_job_metrics AS m ON m.job_id = j.job_id
    LEFT JOIN ${alias}.specialist_results AS r ON r.job_id = j.job_id
    WHERE COALESCE(m.updated_at_ms, j.updated_at_ms, 0) >= ?
  `).all(cutoff) as Row[];
}

function hasSpecialistJobMetrics(db: { prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown } }, alias: string): boolean {
  try {
    db.prepare(`SELECT 1 FROM ${alias}.specialist_job_metrics LIMIT 0`).run();
    return true;
  } catch {
    return false;
  }
}

function sumTokens(rows: Row[]): TokenTotals {
  return rows.reduce<TokenTotals>((acc, row) => {
    const t = parseTokenTrajectory(row.token_trajectory_json);
    return { input: acc.input + t.input, output: acc.output + t.output, cacheCreation: acc.cacheCreation + t.cacheCreation, cacheRead: acc.cacheRead + t.cacheRead, total: acc.total + t.total };
  }, { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 });
}

function tokensBy<T extends string>(rows: Row[], keyOf: (row: Row) => T, keyName: "specialist" | "model"): Array<{ [K in typeof keyName]: T } & TokenTotals> {
  const map = new Map<T, TokenTotals>();
  for (const row of rows) {
    const key = keyOf(row);
    const current = map.get(key) ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 };
    const t = parseTokenTrajectory(row.token_trajectory_json);
    map.set(key, { input: current.input + t.input, output: current.output + t.output, cacheCreation: current.cacheCreation + t.cacheCreation, cacheRead: current.cacheRead + t.cacheRead, total: current.total + t.total });
  }
  return [...map.entries()].map(([key, totals]) => ({ [keyName]: key, ...totals } as { [K in typeof keyName]: T } & TokenTotals)).sort((a, b) => b.total - a.total);
}

function hitRates<T extends string>(rows: Row[], keyOf: (row: Row) => T, keyName: "specialist" | "model"): Array<{ [K in typeof keyName]: T } & { hitRate: number }> {
  const map = new Map<T, { hit: number; denom: number }>();
  for (const row of rows) {
    const key = keyOf(row);
    const t = parseTokenTrajectory(row.token_trajectory_json);
    const current = map.get(key) ?? { hit: 0, denom: 0 };
    map.set(key, { hit: current.hit + t.cacheRead, denom: current.denom + t.cacheRead + t.cacheCreation + t.input });
  }
  return [...map.entries()].map(([key, value]) => ({ [keyName]: key, hitRate: value.denom ? value.hit / value.denom : 0 } as { [K in typeof keyName]: T } & { hitRate: number }));
}

function averages(rows: Row[]): AverageRow[] {
  return by(rows, (r) => r.specialist).map(([specialist, group]) => ({ specialist, avgTokens: avg(group.map((r) => parseTokenTrajectory(r.token_trajectory_json).total)), avgElapsedMs: avg(group.map((r) => r.elapsed_ms)), avgTurns: avg(group.map((r) => r.total_turns)), avgTools: avg(group.map((r) => r.total_tools)) })).sort((a, b) => b.avgTokens - a.avgTokens);
}

function runtimeBy<T extends string>(rows: Row[], keyOf: (row: Row) => T, keyName: "specialist" | "model"): Array<{ [K in typeof keyName]: T } & { ms: number }> {
  const map = new Map<T, number>();
  for (const row of rows) map.set(keyOf(row), (map.get(keyOf(row)) ?? 0) + row.active_runtime_ms);
  return [...map.entries()].map(([key, ms]) => ({ [keyName]: key, ms } as { [K in typeof keyName]: T } & { ms: number })).sort((a, b) => b.ms - a.ms);
}

function reliability(rows: Row[]): ReliabilityRow[] {
  const warnings = warningCounts(rows);
  return by(rows, (r) => r.specialist).map(([specialist, group]) => ({ specialist, done: group.filter((r) => r.status === "done").length, error: group.filter((r) => r.status === "error").length, cancelled: group.filter((r) => r.status === "cancelled").length, staleWarnings: warnings.get(specialist) ?? 0 }));
}

function slowestJobs(rows: Row[]): SlowJob[] {
  return [...rows].sort((a, b) => b.elapsed_ms - a.elapsed_ms).slice(0, 10).map((r) => ({ jobId: r.job_id, specialist: r.specialist, beadId: r.bead_id, model: r.model, elapsedMs: r.elapsed_ms, turns: r.total_turns, tools: r.total_tools }));
}

function toolUsage(rows: Row[]): ObservabilitySummary["toolUsage"] {
  const totals = new Map<string, number>();
  const cross = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const tools = parseJsonObject(row.tool_call_counts_json);
    const specialist = row.specialist;
    const specialistTools = cross.get(specialist) ?? new Map<string, number>();
    for (const [tool, count] of Object.entries(tools)) {
      totals.set(tool, (totals.get(tool) ?? 0) + count);
      specialistTools.set(tool, (specialistTools.get(tool) ?? 0) + count);
    }
    cross.set(specialist, specialistTools);
  }
  return { totals: [...totals.entries()].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count), bySpecialist: [...cross.entries()].map(([specialist, tools]) => ({ specialist, tools: [...tools.entries()].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count) })) };
}

function reviewerOutcomes(rows: Row[]): OutcomeCounts {
  const out = { pass: 0, partial: 0, fail: 0, unknown: 0 };
  for (const row of rows.filter((r) => r.specialist === "reviewer" && r.run_complete_json != null)) {
    const verdict = /(?:## Compliance Verdict|Verdict:|Status:)\s*(PASS|PARTIAL|FAIL)/i.exec(row.result_output ?? "")?.[1]?.toLowerCase();
    if (verdict === "pass") out.pass += 1;
    else if (verdict === "partial") out.partial += 1;
    else if (verdict === "fail") out.fail += 1;
    else out.unknown += 1;
  }
  return out;
}

function contextBurn(rows: Row[]): ContextBurnRow[] {
  return by(rows, (r) => r.specialist).flatMap(([specialist, group]) => {
    const values = group.flatMap((r) => lastContextPct(r.context_trajectory_json));
    return values.length ? [{ specialist, avgFinalContextPct: avg(values) }] : [];
  });
}

function stalls(rows: Row[]): ObservabilitySummary["stalls"] {
  const warnings = warningCounts(rows);
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.specialist, (totals.get(row.specialist) ?? 0) + stallMs(row.stall_gaps_json));
  const bySpecialist = [...totals.entries()].map(([specialist, totalMs]) => ({ specialist, totalMs, staleWarnings: warnings.get(specialist) ?? 0 }));
  const longest = [...rows].map((r) => ({ jobId: r.job_id, specialist: r.specialist, totalMs: stallMs(r.stall_gaps_json) })).sort((a, b) => b.totalMs - a.totalMs).slice(0, 5);
  return { bySpecialist, longest };
}

function chains(rows: Row[]): ObservabilitySummary["chains"] {
  const chainCounts = new Map<string, number>();
  const epicCounts = new Map<string, number>();
  for (const row of rows) chainCounts.set(row.job_id, (chainCounts.get(row.job_id) ?? 0) + 1);
  for (const count of chainCounts.values()) {
    const bucket = count === 1 ? "1" : count === 2 ? "2" : count <= 5 ? "3-5" : count <= 10 ? "6-10" : "10+";
    epicCounts.set(bucket, (epicCounts.get(bucket) ?? 0) + 1);
  }
  for (const row of rows) {
    const status = String(parseJsonObject(row.run_complete_json).status ?? "in_progress");
    epicCounts.set(status, (epicCounts.get(status) ?? 0) + 1);
  }
  return { lengthHistogram: ["1", "2", "3-5", "6-10", "10+"].map((bucket) => ({ bucket: bucket as ChainBucket["bucket"], count: epicCounts.get(bucket) ?? 0 })), epics: [...epicCounts.entries()].filter(([status]) => !["1", "2", "3-5", "6-10", "10+"].includes(status)).map(([status, count]) => ({ status, count })) };
}

function by<T>(rows: Row[], keyOf: (row: Row) => T): Array<[T, Row[]]> {
  const map = new Map<T, Row[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = map.get(key) ?? [];
    group.push(row);
    map.set(key, group);
  }
  return [...map.entries()];
}

function warningCounts(rows: Row[]) {
  const map = new Map<string, number>();
  for (const row of rows) {
    const value = row.run_complete_json ?? "";
    if (value.includes("stale_warning")) map.set(row.specialist, (map.get(row.specialist) ?? 0) + 1);
  }
  return map;
}

function parseTokenTrajectory(value: string | null) {
  const items = parseJsonArray(value);
  let input = 0, output = 0, cacheCreation = 0, cacheRead = 0, total = 0;
  for (const item of items) {
    const item_record = firstRecord(item);
    const usage = firstRecord(item_record.token_usage);
    input += num(usage.input_tokens);
    output += num(usage.output_tokens);
    cacheCreation += num(usage.cache_creation_tokens);
    cacheRead += num(usage.cache_read_tokens);
    total += num(usage.total_tokens ?? (num(usage.input_tokens) + num(usage.output_tokens) + num(usage.cache_creation_tokens) + num(usage.cache_read_tokens)));
  }
  return { input, output, cacheCreation, cacheRead, total };
}

function lastContextPct(value: string | null): number[] {
  const items = parseJsonArray(value);
  const last = items.at(-1);
  if (!last) return [];
  const rec = firstRecord(last);
  return rec.context_pct != null ? [num(rec.context_pct)] : rec.percent != null ? [num(rec.percent)] : rec.value != null ? [num(rec.value)] : [];
}

function stallMs(value: string | null) {
  let total = 0;
  for (const item of parseJsonArray(value)) {
    const rec = firstRecord(item);
    total += Math.max(0, num(rec.end_ms) - num(rec.start_ms));
  }
  return total;
}

function parseJsonArray(value: string | null): unknown[] {
  if (!value) return [];
  try { return JSON.parse(value) as unknown[]; } catch { return []; }
}

function parseJsonObject(value: string | null): Record<string, number> {
  if (!value) return {};
  try { return JSON.parse(value) as Record<string, number>; } catch { return {}; }
}

function firstRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function num(value: unknown) { return typeof value === "number" ? value : Number(value ?? 0); }
function avg(values: number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
