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

export interface GitboardRuntimeLifecyclePlan {
  capabilities: readonly RuntimeHostCapability[];
  mountedRoutes: readonly string[];
  hasStateDatabase: boolean;
  isDatasetteDebugEnabled: boolean;
  isParityEnabled: boolean;
}

export interface GitboardRuntimeLifecycleOptions {
  hasStateDatabase: boolean;
  isDatasetteDebugEnabled?: boolean;
  isParityEnabled?: boolean;
}

export interface GitboardRuntimeLifecycleFactory<TDatabase, TRegistry, TMaterializer, TScanner, TBeadsWatcher, TObservabilityWatcher, TBeadsParityHarness, TObservabilityParityHarness> {
  storeDb: TDatabase;
  stateDb: TDatabase | null;
  registry: TRegistry;
  createMaterializer: (db: TDatabase, registry: TRegistry) => TMaterializer;
  createScanner: (db: TDatabase, options: { parityEnabled: boolean }) => TScanner;
  createBeadsWatcher: (materializer: TMaterializer, db: TDatabase, registry: TRegistry) => TBeadsWatcher;
  createObservabilityWatcher: () => TObservabilityWatcher;
  createBeadsParityHarness: (db: TDatabase | null, options: { enabled: boolean }) => TBeadsParityHarness;
  createObservabilityParityHarness: (db: TDatabase | null, options: { enabled: boolean }) => TObservabilityParityHarness;
}

export interface GitboardRuntimeLifecycle<TDatabase, TRegistry, TMaterializer, TScanner, TBeadsWatcher, TObservabilityWatcher, TBeadsParityHarness, TObservabilityParityHarness> {
  materializer: TMaterializer | null;
  scanner: TScanner | null;
  beadsWatcher: TBeadsWatcher | null;
  observabilityWatcher: TObservabilityWatcher;
  beadsParityHarness: TBeadsParityHarness;
  observabilityParityHarness: TObservabilityParityHarness;
  runtimeHost: RuntimeHostDescriptor<TDatabase, TRegistry, TMaterializer>;
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

export function createGitboardRuntimeLifecyclePlan(options: GitboardRuntimeLifecycleOptions): GitboardRuntimeLifecyclePlan {
  const isDatasetteDebugEnabled = options.isDatasetteDebugEnabled ?? false;

  return {
    hasStateDatabase: options.hasStateDatabase,
    isDatasetteDebugEnabled,
    isParityEnabled: options.isParityEnabled ?? false,
    capabilities: [
      "http-api",
      "websocket",
      "materializer",
      "source-health",
      "github-adapter",
      "static-dashboard",
      "internal-logs",
    ],
    mountedRoutes: [
      "/api/github",
      "/api/substrate",
      "/api/specialists",
      "/api/console/observability",
      "/api/console/graph",
      "/api/feed",
      "/api/sources",
      "/api/console/shell",
      "/api/console/terminal",
      "/api/console/explore",
      "/api/internal",
      ...(isDatasetteDebugEnabled ? ["/explore/sql"] : []),
      "/health",
      "/console",
      "/gitboard",
    ],
  };
}

export function createGitboardRuntimeLifecycle<TDatabase, TRegistry, TMaterializer, TScanner, TBeadsWatcher, TObservabilityWatcher, TBeadsParityHarness, TObservabilityParityHarness>(
  plan: GitboardRuntimeLifecyclePlan,
  factory: GitboardRuntimeLifecycleFactory<TDatabase, TRegistry, TMaterializer, TScanner, TBeadsWatcher, TObservabilityWatcher, TBeadsParityHarness, TObservabilityParityHarness>,
): GitboardRuntimeLifecycle<TDatabase, TRegistry, TMaterializer, TScanner, TBeadsWatcher, TObservabilityWatcher, TBeadsParityHarness, TObservabilityParityHarness> {
  const materializer = factory.stateDb ? factory.createMaterializer(factory.storeDb, factory.registry) : null;
  const scanner = factory.stateDb ? factory.createScanner(factory.storeDb, { parityEnabled: plan.isParityEnabled }) : null;
  const beadsWatcher = materializer && factory.stateDb ? factory.createBeadsWatcher(materializer, factory.stateDb, factory.registry) : null;
  const observabilityWatcher = factory.createObservabilityWatcher();
  const observabilityParityHarness = factory.createObservabilityParityHarness(factory.stateDb, { enabled: plan.isParityEnabled });
  const beadsParityHarness = factory.createBeadsParityHarness(factory.stateDb, { enabled: plan.isParityEnabled });

  return {
    materializer,
    scanner,
    beadsWatcher,
    observabilityWatcher,
    observabilityParityHarness,
    beadsParityHarness,
    runtimeHost: createRuntimeHostDescriptor({
      storeDb: factory.storeDb,
      stateDb: factory.stateDb,
      registry: factory.registry,
      materializer,
      capabilities: plan.capabilities,
      mountedRoutes: plan.mountedRoutes,
    }),
  };
}

export function runtimeHostHasCapability(host: RuntimeHostDescriptor, capability: RuntimeHostCapability): boolean {
  return host.capabilities.includes(capability);
}
