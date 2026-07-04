export interface SourceRefreshLifecycleOptions<T> {
  refreshIntervalMs: number;
  refresh: () => Promise<T>;
}

export class SourceRefreshLifecycle<T> {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private refreshInFlight: Promise<T> | null = null;

  constructor(private readonly options: SourceRefreshLifecycleOptions<T>) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.options.refreshIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  refresh(): Promise<T> {
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

