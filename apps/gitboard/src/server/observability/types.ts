export interface SpecialistJob {
  jobId: string | null;
  repoSlug: string;
  beadId: string;
  chainId: string | null;
  epicId: string | null;
  chainKind: string | null;
  status: string;
  updatedAt: string;
  specialist: string | null;
  lastOutput: string | null;
  /** Total turn count from specialist_job_metrics.total_turns. Null when the
   *  metrics row hasn't materialized yet or the repo lacks the metrics table. */
  turns: number | null;
  /** Total tool-call count from specialist_job_metrics.total_tools. */
  tools: number | null;
  /** Model string from specialist_job_metrics.model (e.g.
   *  "openai-codex/gpt-5.4-mini"). */
  model: string | null;
  tokenUsage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    reasoning: number;
    tool: number;
    source: string | null;
  } | null;
}

export interface SpecialistChain extends SpecialistJob {
  chainId: string;
}

export interface EpicRun extends SpecialistJob {
  epicId: string;
}

export interface AttachedRepoRef {
  alias: string;
  slug: string;
}

export type ObservabilityCoverage = {
  attached: string[];
  skipped: Array<{ slug: string; reason: string }>;
  totalDiscovered: number;
};

export interface AttachPoolLike {
  withAttached<T>(fn: (db: import("bun:sqlite").Database, attached: ReadonlyArray<AttachedRepoRef>) => T): T;
  getCoverage(): ObservabilityCoverage;
}
