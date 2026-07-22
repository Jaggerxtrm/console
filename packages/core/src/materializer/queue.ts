export const COALESCE_MS = 1500;
export const MATERIALIZER_MAX_CONCURRENCY = 2;
export const MATERIALIZER_MAX_PENDING = 8;

export type SourceQueueErrorHandler = (sourceKey: string, error: unknown) => void;

export interface MaterializerSchedulerStats {
  active: number;
  pending: number;
  maxActive: number;
  maxPending: number;
  pendingLimit: number;
}

export interface MaterializerScheduleResult {
  accepted: boolean;
  completion?: Promise<void>;
}

export class BoundedMaterializerScheduler {
  private readonly pending: Array<{
    sourceKey: string;
    run: () => Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  private readonly pendingKeys = new Set<string>();
  private readonly runningKeys = new Set<string>();
  private active = 0;
  private maxActive = 0;
  private maxPending = 0;

  constructor(
    private readonly maxConcurrency = MATERIALIZER_MAX_CONCURRENCY,
    readonly pendingLimit = MATERIALIZER_MAX_PENDING,
  ) {}

  submit(sourceKey: string, run: () => Promise<void>): MaterializerScheduleResult {
    if (this.pendingKeys.has(sourceKey) || this.runningKeys.has(sourceKey) || this.pending.length >= this.pendingLimit) return { accepted: false };

    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    this.pending.push({ sourceKey, run, resolve: resolveCompletion, reject: rejectCompletion });
    this.pendingKeys.add(sourceKey);
    this.maxPending = Math.max(this.maxPending, this.pending.length);
    this.pump();
    return { accepted: true, completion };
  }

  getStats(): MaterializerSchedulerStats {
    return {
      active: this.active,
      pending: this.pending.length,
      maxActive: this.maxActive,
      maxPending: this.maxPending,
      pendingLimit: this.pendingLimit,
    };
  }

  private pump(): void {
    while (this.active < this.maxConcurrency && this.pending.length > 0) {
      const task = this.pending.shift()!;
      this.pendingKeys.delete(task.sourceKey);
      this.runningKeys.add(task.sourceKey);
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      void Promise.resolve()
        .then(task.run)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.runningKeys.delete(task.sourceKey);
          this.active -= 1;
          this.pump();
        });
    }
  }
}

export class SourceQueue {
  private running = false;
  private queued = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onError?: SourceQueueErrorHandler) {}

  enqueue(sourceKey: string, run: () => Promise<void>): void {
    this.queued = true;
    if (this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain(sourceKey, run);
    }, COALESCE_MS);
  }

  private async drain(sourceKey: string, run: () => Promise<void>): Promise<void> {
    if (!this.queued || this.running) return;
    this.running = true;
    this.queued = false;
    try {
      await run();
    } catch (error) {
      this.onError?.(sourceKey, error);
    } finally {
      this.running = false;
      if (this.queued) this.enqueue(sourceKey, run);
    }
  }
}
