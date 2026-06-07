import type { MaterializerAdapter } from "./types.ts";

export type AdapterRegistry = Map<string, MaterializerAdapter<any, any>>;

export function createAdapterRegistry(): AdapterRegistry {
  return new Map<string, MaterializerAdapter<any, any>>();
}
