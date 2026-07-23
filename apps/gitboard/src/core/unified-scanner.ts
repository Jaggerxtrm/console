import type { Database } from "bun:sqlite";
import {
  UnifiedScanner as CoreUnifiedScanner,
  type UnifiedScannerConfig,
} from "../../../../packages/core/src/runtime/unified-scanner.ts";
import { listRepos } from "../server/observability/registry.ts";
import { emit } from "./logger.ts";

export class UnifiedScanner extends CoreUnifiedScanner {
  constructor(db: Database, config: UnifiedScannerConfig = {}) {
    super(db, {
      ...config,
      emitLog: config.emitLog ?? emit,
      listObservabilityRepos: config.listObservabilityRepos ?? listRepos,
    });
  }
}

export * from "../../../../packages/core/src/runtime/unified-scanner.ts";
