import type { Database } from "bun:sqlite";
import {
  createBeadsParityHarness as createCoreBeadsParityHarness,
  getPooledDoltClient,
  type BeadsParityOptions,
  type PooledDoltClient,
} from "../../../../../packages/core/src/runtime/beads-parity.ts";
import { ProjectScanner } from "../../core/project-scanner.ts";
import { DoltClient, type DoltConfig } from "../../core/dolt-client.ts";

export type { BeadsParitySummary } from "../../../../../packages/core/src/runtime/beads-parity.ts";

export function createBeadsParityHarness(xtrmDb: Database | null, options: BeadsParityOptions = {}) {
  return createCoreBeadsParityHarness(xtrmDb, {
    ...options,
    scanner: options.scanner ?? new ProjectScanner({
      searchPath: process.env.XDG_PROJECTS_DIR || (process.env.HOME ? `${process.env.HOME}/projects` : "/home"),
      maxDepth: 3,
      excludePatterns: ["node_modules", ".git", ".worktrees", "worktrees", "Library", "Applications", ".cargo", ".npm", ".rustup"],
    }),
    createDoltClient: options.createDoltClient ?? ((config) => new DoltClient(config)),
  });
}

export function __testOnly_getPooledDoltClient(
  clientPool: Map<string, PooledDoltClient>,
  config: DoltConfig,
): DoltClient {
  return getPooledDoltClient(clientPool, config, (value) => new DoltClient(value));
}
