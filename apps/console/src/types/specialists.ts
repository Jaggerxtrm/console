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
  turns: number | null;
  tools: number | null;
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
  withAttached<T>(fn: (db: unknown, attached: ReadonlyArray<AttachedRepoRef>) => T): T;
  getCoverage(): ObservabilityCoverage;
}
