export const COALESCE_MS = 1500;

export class SourceQueue {
  private running = false;
  private queued = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  enqueue(run: () => Promise<void>): void {
    this.queued = true;
    if (this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain(run);
    }, COALESCE_MS);
  }

  private async drain(run: () => Promise<void>): Promise<void> {
    if (!this.queued || this.running) return;
    this.running = true;
    this.queued = false;
    try {
      await run();
    } catch {
      // per-source isolation: keep queue moving after one source fails
    } finally {
      this.running = false;
      if (this.queued) this.enqueue(run);
    }
  }
}
