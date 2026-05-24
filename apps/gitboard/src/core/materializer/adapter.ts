import type { MaterializerAdapter } from "./types.ts";

export type AdapterRegistry = Map<string, MaterializerAdapter>;

export function createAdapterRegistry(): AdapterRegistry {
  return new Map<string, MaterializerAdapter>();
}
