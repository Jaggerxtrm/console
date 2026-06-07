export type RuntimeHostCapability =
  | "http-api"
  | "websocket"
  | "materializer"
  | "source-health"
  | "github-adapter"
  | "static-dashboard"
  | "internal-logs";

export interface RuntimeHostDescriptor<TDatabase = unknown, TRegistry = unknown, TMaterializer = unknown> {
  compatibilityHost: "apps/gitboard";
  storeDb: TDatabase;
  stateDb: TDatabase | null;
  registry: TRegistry;
  materializer: TMaterializer | null;
  mountedRoutes: readonly string[];
  capabilities: readonly RuntimeHostCapability[];
}

export interface RuntimeHostDescriptorOptions<TDatabase, TRegistry, TMaterializer> {
  storeDb: TDatabase;
  stateDb?: TDatabase | null;
  registry: TRegistry;
  materializer?: TMaterializer | null;
  mountedRoutes: readonly string[];
  capabilities: readonly RuntimeHostCapability[];
}

export function createRuntimeHostDescriptor<TDatabase, TRegistry, TMaterializer>(
  options: RuntimeHostDescriptorOptions<TDatabase, TRegistry, TMaterializer>,
): RuntimeHostDescriptor<TDatabase, TRegistry, TMaterializer> {
  return {
    compatibilityHost: "apps/gitboard",
    storeDb: options.storeDb,
    stateDb: options.stateDb ?? null,
    registry: options.registry,
    materializer: options.materializer ?? null,
    mountedRoutes: [...options.mountedRoutes],
    capabilities: [...options.capabilities],
  };
}

export function runtimeHostHasCapability(host: RuntimeHostDescriptor, capability: RuntimeHostCapability): boolean {
  return host.capabilities.includes(capability);
}
