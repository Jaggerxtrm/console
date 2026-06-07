import type { Database } from "bun:sqlite";
import { Materializer as CoreMaterializer, type MaterializerHooks } from "../../../../../packages/core/src/materializer/index.ts";
import type { ChannelRegistry } from "../../api/ws/channels.ts";
import { bump as bumpEpoch } from "../../server/observability/epoch.ts";
import { emit, makeLogEntry } from "../logger.ts";

export class Materializer extends CoreMaterializer {
  constructor(db: Database, wsRegistry?: ChannelRegistry, hooks: MaterializerHooks = {}) {
    super(db, wsRegistry, {
      ...hooks,
      bumpObservabilityEpoch: hooks.bumpObservabilityEpoch ?? bumpEpoch,
      emitLog: hooks.emitLog ?? ((entry) => {
        emit(makeLogEntry(entry.component, entry.event, entry.level, entry.message, entry.data));
      }),
    });
  }
}

export type { MaterializerHooks } from "../../../../../packages/core/src/materializer/index.ts";
export * from "../../../../../packages/core/src/materializer/index.ts";
