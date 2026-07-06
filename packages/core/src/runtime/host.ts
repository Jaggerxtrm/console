export type RuntimeHostCapability =
  | "http-api"
  | "websocket"
  | "materializer"
  | "source-health"
  | "github-adapter"
  | "static-dashboard"
  | "internal-logs";

export type StaticServiceRetirementState = "retained" | "retired";

export interface StaticServiceRouteParity {
  route: string;
  state: StaticServiceRetirementState;
  parityProof: string;
  blockers: readonly string[];
}

export interface RuntimeHostDescriptor<TDatabase = unknown, TRegistry = unknown, TMaterializer = unknown> {
  compatibilityHost: "apps/gitboard";
  storeDb: TDatabase;
  stateDb: TDatabase | null;
  registry: TRegistry;
  materializer: TMaterializer | null;
  mountedRoutes: readonly string[];
  capabilities: readonly RuntimeHostCapability[];
  staticServiceParity: readonly StaticServiceRouteParity[];
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
  staticServiceParity?: readonly StaticServiceRouteParity[];
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
    staticServiceParity: [...(options.staticServiceParity ?? [])],
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

export function createStaticServiceParityTable(): readonly StaticServiceRouteParity[] {
  return [
    {
      route: "/console",
      state: "retained",
      parityProof: "production smoke must prove first-viewport Console assets load with HTTP 200 before app-host static serving can move",
      blockers: ["daemon static asset host not deployed", "systemd gitboard.service still starts apps/gitboard/src/index.ts"],
    },
    {
      route: "/gitboard",
      state: "retained",
      parityProof: "production smoke must prove legacy Gitboard bundle loads with HTTP 200 before compatibility shell removal",
      blockers: ["legacy bundle remains public rollback path", "no replacement route has same deployment proof"],
    },
    {
      route: "/health",
      state: "retained",
      parityProof: "systemd and deploy monitor require health HTTP 200 during restart windows",
      blockers: ["service health check still targets app host", "daemon health descriptor not wired to production service"],
    },
    {
      route: "runtime-descriptor",
      state: "retained",
      parityProof: "runtimeHost descriptor records mounted routes and capabilities for bridge-era verification",
      blockers: ["final wrapper cleanup gate not satisfied", "bridge retirement readiness still depends on static/socket/API probes"],
    },
  ];
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
      staticServiceParity: createStaticServiceParityTable(),
    }),
  };
}

export function runtimeHostHasCapability(host: RuntimeHostDescriptor, capability: RuntimeHostCapability): boolean {
  return host.capabilities.includes(capability);
}
