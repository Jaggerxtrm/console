export interface SpecialistJob {
  repoSlug: string;
  beadId: string;
  chainId: string | null;
  epicId: string | null;
  chainKind: string | null;
  status: string;
  updatedAt: string;
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

export interface AttachPoolLike {
  withAttached<T>(fn: (db: import("bun:sqlite").Database, attached: ReadonlyArray<AttachedRepoRef>) => T): T;
}
