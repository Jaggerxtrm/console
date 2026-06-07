export const COALESCE_MS = 1500;

export type SourceQueueErrorHandler = (sourceKey: string, error: unknown) => void;

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
