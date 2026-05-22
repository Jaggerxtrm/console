const epochs = new Map<string, number>();

export type BumpListener = (repoSlug: string, epoch: number) => void;
const listeners = new Set<BumpListener>();

export function get(repoSlug: string): number {
  return epochs.get(repoSlug) ?? 0;
}

export function bump(repoSlug: string): number {
  const next = get(repoSlug) + 1;
  epochs.set(repoSlug, next);
  for (const cb of listeners) {
    try {
      cb(repoSlug, next);
    } catch (err) {
      // Listener failures must not break the bump pipeline (e.g. WS publish loop),
      // but a silent catch hides dead push paths. Surface to stderr — overthinker
      // flagged this as a blind-spot risk; logger.ts wiring stays out of this
      // low-level module to keep it dep-free.
      console.error(`[observability/epoch] bump listener failed for ${repoSlug}:`, err);
    }
  }
  return next;
}

/**
 * Register a listener called on every epoch bump. Returns an unsubscribe fn.
 * Used by api/server.ts to publish a `specialists:sync_hint` event over WS
 * whenever the observability watcher detects a db change (forge-7cyq).
 */
export function onBump(cb: BumpListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
