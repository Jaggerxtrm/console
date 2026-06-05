export type TimeRange = "7d" | "30d" | "all";

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
