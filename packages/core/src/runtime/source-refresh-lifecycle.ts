export interface SourceRefreshLifecycleOptions<T> {
  refreshIntervalMs: number;
  refresh: () => Promise<T>;
}

export class SourceRefreshLifecycle<T> {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;
  private refreshInFlight: Promise<T> | null = null;

  constructor(private readonly options: SourceRefreshLifecycleOptions<T>) {}

  start(): void {
    if (this.running) return;
    this.stopped = false;
    this.running = true;
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.options.refreshIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.refreshInFlight?.catch(() => {});
  }

  refresh(): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("source refresh stopped"));
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.options.refresh();
    return this.refreshInFlight.finally(() => {
      this.refreshInFlight = null;
    });
  }

  isRunning(): boolean {
    return this.running;
  }
}
