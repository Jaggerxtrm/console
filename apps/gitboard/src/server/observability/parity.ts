import { emit } from "../../core/logger.ts";
import {
  createObservabilityParityHarness as createCoreObservabilityParityHarness,
  type ParityDao,
  type ParityHarness,
} from "../../../../../packages/core/src/observability/parity.ts";
import type { Database } from "bun:sqlite";

export * from "../../../../../packages/core/src/observability/parity.ts";

export function createObservabilityParityHarness(
  xtrmDb: Database | null,
  options: { intervalMs?: number; enabled?: boolean; liveDao?: ParityDao; shadowDao?: ParityDao } = {},
): ParityHarness {
  return createCoreObservabilityParityHarness(xtrmDb, { ...options, emitLog: emit });
}
