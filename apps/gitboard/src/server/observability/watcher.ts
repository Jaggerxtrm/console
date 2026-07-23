import { getCurrentMaterializer } from "../../api/server.ts";
import {
  createObservabilityWatcher as createCoreObservabilityWatcher,
  type ObservabilityWatcherOptions,
} from "../../../../../packages/core/src/observability/watcher.ts";
import type { RepoEntry } from "../../../../../packages/core/src/observability/registry.ts";

export type { ObservabilityWatcherOptions } from "../../../../../packages/core/src/observability/watcher.ts";

export function createObservabilityWatcher(entries: readonly RepoEntry[], options: ObservabilityWatcherOptions = {}) {
  return createCoreObservabilityWatcher(entries, {
    ...options,
    triggerMaterializer: options.triggerMaterializer ?? ((reason) => getCurrentMaterializer()?.trigger(reason)),
  });
}
