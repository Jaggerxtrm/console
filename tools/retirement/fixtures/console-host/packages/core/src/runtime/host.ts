/**
 * Host descriptor metadata. The string literal below documents the legacy
 * compatibility host for migration reporting only; it is NOT a module import
 * and must NOT trip the production-import scanner.
 */
export interface RuntimeHostDescriptor {
  readonly owner: "apps/console" | "packages/core";
  readonly compatibilityHost: "apps/gitboard";
  readonly port: number;
}

export function describeHost(port: number): RuntimeHostDescriptor {
  return {
    owner: "apps/console",
    compatibilityHost: "apps/gitboard",
    port,
  };
}
