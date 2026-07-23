import { getObservabilityConfig } from "./config.ts";
import {
  __resetObservabilityRegistryForTests,
  listRepos as listCoreRepos,
  type RepoEntry,
} from "../../../../../packages/core/src/observability/registry.ts";

export type { RepoEntry } from "../../../../../packages/core/src/observability/registry.ts";
export { __resetObservabilityRegistryForTests };

export function listRepos(): RepoEntry[] {
  return listCoreRepos(getObservabilityConfig);
}
