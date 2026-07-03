export type RuntimeOwner = "apps/gitboard" | "packages/core" | "apps/console" | "external";
export type RuntimeSurfaceKind = "schema" | "host" | "materializer" | "read-model" | "source-lifecycle" | "adapter" | "shell" | "realtime" | "service";
export type RuntimeMigrationRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type RuntimeMigrationState = "current-app-runtime" | "core-target-defined" | "core-owned" | "compatibility-shell" | "deprecated";
export type RuntimeMigrationChildStatus = "planned" | "ready" | "blocked";

export interface RuntimeSurface {
  id: string;
  kind: RuntimeSurfaceKind;
  state: RuntimeMigrationState;
  currentOwner: RuntimeOwner;
  targetOwner: RuntimeOwner;
  currentPaths: readonly string[];
  targetExport: string;
  knownHighRiskSymbols: readonly string[];
  preserves: readonly string[];
  deprecationGate: string;
  nextBead: string;
  dependsOn: readonly string[];
}

export interface GitboardRuntimeOwnershipMap {
  appShellTarget: RuntimeSurface;
  surfaces: readonly RuntimeSurface[];
}

export interface RuntimeMigrationChild {
  key: string;
  title: string;
  status: RuntimeMigrationChildStatus;
  dependsOn: readonly string[];
  surfaces: readonly string[];
  gitnexusImpactTargets: readonly string[];
  validation: readonly string[];
  notes: string;
}

export interface RuntimeSmokeGate {
  name: string;
  command?: string;
  requiredEvidence: readonly string[];
}

export interface GitboardFinalRuntimeMigrationPlan {
  epicId: "forge-3dm4";
  targetRuntimeOwner: "@xtrm/core/runtime";
  compatibilityHost: "apps/gitboard";
  daemonTarget: "xt daemon";
  children: readonly RuntimeMigrationChild[];
  smokeGates: readonly RuntimeSmokeGate[];
  productionRestartGate: readonly string[];
  wrapperRetirementChecklist: readonly string[];
}

export interface RuntimeDeprecationReadiness {
  ready: boolean;
  missingSurfaceIds: readonly string[];
  appShellTarget: RuntimeSurface;
}

export function createGitboardRuntimeOwnershipMap(): GitboardRuntimeOwnershipMap {
  const appShellTarget: RuntimeSurface = {
    id: "gitboard-compatibility-shell",
    kind: "shell",
    state: "core-target-defined",
    currentOwner: "apps/gitboard",
    targetOwner: "apps/gitboard",
    currentPaths: ["apps/gitboard/src/index.ts", "apps/gitboard/src/api/server.ts", "apps/gitboard/src/dashboard"],
    targetExport: "@xtrm/core/runtime",
    knownHighRiskSymbols: ["createApp"],
    preserves: ["mounted HTTP routes", "static dashboard serving", "websocket upgrade handling", "local staging startup"],
    deprecationGate: "All runtime surfaces are core-owned and app files only mount routes/static assets or re-export compatibility wrappers.",
    nextBead: "forge-6oae.8",
    dependsOn: ["runtime-host", "materializer-runtime", "console-read-models", "source-lifecycle", "github-adapter"],
  };

  return {
    appShellTarget,
    surfaces: [
      {
        id: "xtrm-state-schema",
        kind: "schema",
        state: "core-target-defined",
        currentOwner: "apps/gitboard",
        targetOwner: "packages/core",
        currentPaths: ["apps/gitboard/src/core/xtrm-store.ts"],
        targetExport: "@xtrm/core/state",
        knownHighRiskSymbols: ["createXtrmDatabase"],
        preserves: ["table names", "additive migration idempotency", "materialization cursors", "forensic/evidence tables", "source health tables"],
        deprecationGate: "apps/gitboard/src/core/xtrm-store.ts delegates to the core state initializer and carries no schema ownership.",
        nextBead: "forge-6oae.2",
        dependsOn: [],
      },
      {
        id: "runtime-host",
        kind: "host",
        state: "core-owned",
        currentOwner: "packages/core",
        targetOwner: "packages/core",
        currentPaths: ["packages/core/src/runtime/host.ts", "apps/gitboard/src/api/server.ts", "apps/gitboard/src/index.ts"],
        targetExport: "@xtrm/core/runtime",
        knownHighRiskSymbols: ["createApp", "startServer"],
        preserves: ["route mounting", "channel registry", "request timing logs", "internal logs", "health endpoint", "materializer lifecycle policy", "degraded readable behavior"],
        deprecationGate: "createApp/startServer remain compatibility wiring over a core-owned runtime lifecycle contract.",
        nextBead: "forge-6oae.3",
        dependsOn: [],
      },
      {
        id: "materializer-runtime",
        kind: "materializer",
        state: "core-target-defined",
        currentOwner: "apps/gitboard",
        targetOwner: "packages/core",
        currentPaths: ["apps/gitboard/src/core/materializer/index.ts", "apps/gitboard/src/server/beads/trigger-watcher.ts", "apps/gitboard/src/server/observability/watcher.ts"],
        targetExport: "@xtrm/core/materializer",
        knownHighRiskSymbols: ["Materializer"],
        preserves: ["cursor advancement", "transaction rollback", "materializer.run completed/failed events", "publish hints", "source queue coalescing"],
        deprecationGate: "Materializer implementation is exported by core and app materializer index is a wrapper only.",
        nextBead: "forge-6oae.4",
        dependsOn: ["xtrm-state-schema", "runtime-host"],
      },
      {
        id: "console-read-models",
        kind: "read-model",
        state: "core-target-defined",
        currentOwner: "apps/gitboard",
        targetOwner: "packages/core",
        currentPaths: ["apps/gitboard/src/api/routes/substrate.ts", "apps/gitboard/src/api/routes/specialists.ts", "apps/gitboard/src/api/routes/feed.ts", "apps/gitboard/src/api/routes/graph.ts", "apps/gitboard/src/core/graph-dao.ts"],
        targetExport: "@xtrm/core/state",
        knownHighRiskSymbols: ["createSubstrateRouter", "createSpecialistsRouter", "createFeedRouter", "createGraphRouter", "createGraphDao"],
        preserves: ["current DTOs", "feed cursor ordering", "forensic/evidence drilldowns", "degraded source-health semantics", "Console read/query only boundary"],
        deprecationGate: "Routes are HTTP adapters over core read-model services and API parity tests remain green.",
        nextBead: "forge-6oae.5",
        dependsOn: ["xtrm-state-schema", "runtime-host"],
      },
      {
        id: "source-lifecycle",
        kind: "source-lifecycle",
        state: "core-target-defined",
        currentOwner: "apps/gitboard",
        targetOwner: "packages/core",
        currentPaths: ["apps/gitboard/src/core/project-scanner.ts", "apps/gitboard/src/core/unified-scanner.ts", "apps/gitboard/src/core/beads-change-watcher.ts", "apps/gitboard/src/server/beads/trigger-watcher.ts", "apps/gitboard/src/server/observability/watcher.ts", "apps/gitboard/src/api/routes/sources.ts"],
        targetExport: "@xtrm/core/runtime",
        knownHighRiskSymbols: ["ProjectScanner", "UnifiedScanner", "BeadsChangeWatcher"],
        preserves: ["discovery roots", "source health statuses", "path redaction", "degraded-but-readable behavior", "observable attach/skip logs", "watcher/scanner lifecycle factory policy"],
        deprecationGate: "Core owns discovery/health services and app supplies only env/config.",
        nextBead: "forge-6oae.6",
        dependsOn: ["runtime-host"],
      },
      {
        id: "github-adapter",
        kind: "adapter",
        state: "core-target-defined",
        currentOwner: "apps/gitboard",
        targetOwner: "packages/core",
        currentPaths: ["apps/gitboard/src/core/github-store.ts", "apps/gitboard/src/core/github-poller.ts", "apps/gitboard/src/core/github-discover.ts", "apps/gitboard/src/core/github-readme.ts", "apps/gitboard/src/api/routes/github.ts"],
        targetExport: "@xtrm/core/github",
        knownHighRiskSymbols: ["GithubPoller"],
        preserves: ["durable GitHub tables", "poller skip behavior", "route DTOs", "channel publish behavior"],
        deprecationGate: "Core owns durable GitHub adapter state and app route/startup code only wires it.",
        nextBead: "forge-6oae.7",
        dependsOn: ["xtrm-state-schema", "runtime-host"],
      },
      {
        id: "realtime-log-delivery",
        kind: "realtime",
        state: "compatibility-shell",
        currentOwner: "apps/gitboard",
        targetOwner: "packages/core",
        currentPaths: ["packages/core/src/runtime/realtime.ts", "packages/core/src/runtime/logs.ts", "packages/core/src/runtime/log-store.ts", "apps/gitboard/src/api/ws/channels.ts", "apps/gitboard/src/api/ws/handler.ts", "apps/gitboard/src/core/logger.ts", "apps/gitboard/src/api/server.ts"],
        targetExport: "@xtrm/core/runtime",
        knownHighRiskSymbols: ["ChannelRegistry", "WsHandler", "emit", "ensureLogStorage"],
        preserves: ["websocket subscription protocol", "replay buffer behavior", "internal log ring", "logger disk retention/write queue", "post-commit sync hints", "request timing/error/slow logs"],
        deprecationGate: "Core owns realtime contracts and reusable logger runtime; app websocket handlers adapt Bun upgrades and ChannelRegistry publishing.",
        nextBead: "forge-3dm4.realtime",
        dependsOn: ["runtime-host", "materializer-runtime"],
      },
      {
        id: "terminal-shell-boundary",
        kind: "shell",
        state: "core-target-defined",
        currentOwner: "apps/gitboard",
        targetOwner: "packages/core",
        currentPaths: ["apps/gitboard/src/api/terminal/bridge.ts", "apps/gitboard/src/api/terminal/provider-registry.ts", "apps/gitboard/src/core/shell-provider-policy.ts", "apps/gitboard/src/core/local-pty-provider.ts"],
        targetExport: "@xtrm/core/terminal/protocol and @xtrm/core/terminal/policy",
        knownHighRiskSymbols: ["TerminalBridge", "parseShellProviderPolicy", "LocalPtyProvider"],
        preserves: ["verified-admin gate", "origin checks", "cwd and shell allowlists", "rate limits", "TTL and idle cleanup", "readonly specialist-feed provider"],
        deprecationGate: "Core owns terminal/shell policy contracts and app code only wires local provider implementations.",
        nextBead: "forge-3dm4.terminal",
        dependsOn: ["runtime-host", "realtime-log-delivery"],
      },
      {
        id: "service-static-retirement",
        kind: "service",
        state: "compatibility-shell",
        currentOwner: "apps/gitboard",
        targetOwner: "packages/core",
        currentPaths: ["apps/gitboard/src/index.ts", "apps/gitboard/src/api/server.ts", "docs/deployment.md", "README.md"],
        targetExport: "@xtrm/core/runtime",
        knownHighRiskSymbols: ["startServer"],
        preserves: ["gitboard.service compatibility alias", "HOST/PORT/GITBOARD_DATA_DIR envs", "/console static host", "/gitboard compatibility bundle", "manual production restart gate"],
        deprecationGate: "gitboard.service remains a host-local compatibility alias for bun --cwd apps/gitboard src/index.ts until the core daemon unit replacement and static retirement probes are complete.",
        nextBead: "forge-3dm4.service",
        dependsOn: ["console-read-models", "source-lifecycle", "github-adapter", "realtime-log-delivery", "terminal-shell-boundary"],
      },
    ],
  };
}

export function createGitboardFinalRuntimeMigrationPlan(): GitboardFinalRuntimeMigrationPlan {
  return {
    epicId: "forge-3dm4",
    targetRuntimeOwner: "@xtrm/core/runtime",
    compatibilityHost: "apps/gitboard",
    daemonTarget: "xt daemon",
    children: [
      {
        key: "final-boundary-docs",
        title: "Plan/document final runtime boundary",
        status: "ready",
        dependsOn: [],
        surfaces: ["gitboard-compatibility-shell"],
        gitnexusImpactTargets: ["createApp", "startServer"],
        validation: ["packages/core runtime ownership tests", "architecture docs updated"],
        notes: "Lock final target states, wrapper retirement checklist, and API compatibility rules before code moves.",
      },
      {
        key: "core-read-model-services",
        title: "Move remaining Console read-model services to core",
        status: "ready",
        dependsOn: ["final-boundary-docs"],
        surfaces: ["console-read-models"],
        gitnexusImpactTargets: ["createSubstrateRouter", "createSpecialistsRouter", "createGraphDao", "createSourcesRouter"],
        validation: ["route-to-core DTO parity tests", "read-model contract tests", "targeted API route tests"],
        notes: "App routes stay mounted and become HTTP adapters over core state services.",
      },
      {
        key: "source-lifecycle-extraction",
        title: "Extract scanner/watchers/source lifecycle behind core runtime contracts",
        status: "blocked",
        dependsOn: ["core-read-model-services"],
        surfaces: ["source-lifecycle"],
        gitnexusImpactTargets: ["ProjectScanner", "UnifiedScanner", "BeadsChangeWatcher"],
        validation: ["source parity tests", "graph/source route tests", "staging smoke with attach/skip logs"],
        notes: "ProjectScanner is CRITICAL risk and must not be bundled with unrelated route cleanup.",
      },
      {
        key: "github-runtime-adapter",
        title: "Move GitHub poller/discovery/readme runtime hooks to core",
        status: "blocked",
        dependsOn: ["final-boundary-docs"],
        surfaces: ["github-adapter"],
        gitnexusImpactTargets: ["GithubPoller", "discoverAndInsert", "getGithubToken"],
        validation: ["GitHub poller tests", "GitHub route tests", "poller-enabled smoke tier"],
        notes: "GitHub tables remain durable external adapter state; only orchestration ownership moves.",
      },
      {
        key: "runtime-host-socket-boundary",
        title: "Move runtime host, websocket, and log delivery contracts to core",
        status: "blocked",
        dependsOn: ["core-read-model-services", "github-runtime-adapter"],
        surfaces: ["runtime-host", "realtime-log-delivery"],
        gitnexusImpactTargets: ["createApp", "startServer", "ChannelRegistry", "WsHandler", "emit"],
        validation: ["runtime host tests", "websocket realtime contract tests", "internal logs tests"],
        notes: "App keeps Bun upgrade adapters until the daemon owns the socket boundary.",
      },
      {
        key: "terminal-shell-safety",
        title: "Move terminal/shell safety boundary contracts to core",
        status: "blocked",
        dependsOn: ["runtime-host-socket-boundary"],
        surfaces: ["terminal-shell-boundary"],
        gitnexusImpactTargets: ["TerminalBridge", "parseShellProviderPolicy", "LocalPtyProvider"],
        validation: ["terminal provider tests", "shell policy tests", "admin/origin denial probes"],
        notes: "Preserve all write-capable shell gates exactly while moving policy ownership.",
      },
      {
        key: "service-static-retirement",
        title: "Turn gitboard service/static host into compatibility wrapper",
        status: "blocked",
        dependsOn: ["source-lifecycle-extraction", "runtime-host-socket-boundary", "terminal-shell-safety"],
        surfaces: ["service-static-retirement"],
        gitnexusImpactTargets: ["startServer"],
        validation: ["production-ready static smoke", "deprecation staging smoke", "deployment doc check"],
        notes: "Document gitboard.service as a compatibility alias for the current Bun app entrypoint; keep /gitboard until explicit UI retirement gates pass.",
      },
      {
        key: "final-wrapper-cleanup",
        title: "Retire obsolete wrappers after parity, smoke, and bridge-readiness gates pass",
        status: "blocked",
        dependsOn: ["service-static-retirement"],
        surfaces: ["gitboard-compatibility-shell", "service-static-retirement"],
        gitnexusImpactTargets: ["createApp", "startServer"],
        validation: ["bridge retirement readiness", "GitNexus detect changes", "staging/prod smoke evidence"],
        notes: "Current final cleanup gate retains app wrappers until bridge readiness is true for feed.rollups, graph.console-joins, and source-health.freshness plus daemon static/socket/API probes.",
      },
    ],
    smokeGates: [
      {
        name: "isolated deprecation smoke",
        command: "bun run --cwd apps/gitboard smoke:deprecation",
        requiredEvidence: ["health ok", "API probes ok", "materializer.run > 0", "materializer.publishHint > 0", "channel.publish > 0", "no materializer/API errors"],
      },
      {
        name: "GitHub poller enabled smoke",
        requiredEvidence: ["SKIP_GITHUB_POLLER is not set", "GitHub auth/token path resolved or classified", "poller cycle/backfill logs observed", "GitHub route probes ok", "rate-limit handling unchanged"],
      },
      {
        name: "production restart smoke",
        requiredEvidence: ["manual gitboard.service restart only", "tailnet health ok", "API route probes ok", "websocket/log probe ok", "materializer/channel logs flowing"],
      },
    ],
    productionRestartGate: [
      "Run local isolated smoke first.",
      "Run staging smoke with log probe.",
      "Run poller-enabled smoke or explicitly classify unavailable GitHub credentials.",
      "Restart production gitboard.service manually only after smoke evidence is captured.",
    ],
    wrapperRetirementChecklist: [
      "Current public API route remains mounted or has a replacement route with parity tests.",
      "Console does not open SQLite and remains UI/read-query only.",
      "Bridge table retirement readiness is true for all daemon-served Console contracts.",
      "GitHub durable adapter state is retained and not treated as temporary bridge data.",
      "WebSocket, terminal, and static route compatibility probes pass.",
      "gitboard.service is documented as a compatibility alias with rollback to the current Bun entrypoint.",
      "GitNexus detect-changes reports only expected symbols and flows.",
    ],
  };
}

export function getReadyRuntimeMigrationSurfaceIds(completedSurfaceIds: readonly string[] = []): string[] {
  const completed = new Set(completedSurfaceIds);
  return createGitboardRuntimeOwnershipMap().surfaces
    .filter((surface) => !completed.has(surface.id))
    .filter((surface) => surface.dependsOn.every((dependency) => completed.has(dependency)))
    .map((surface) => surface.id);
}

export function evaluateGitboardDeprecationReadiness(coreOwnedSurfaceIds: readonly string[]): RuntimeDeprecationReadiness {
  const ownership = createGitboardRuntimeOwnershipMap();
  const coreOwned = new Set(coreOwnedSurfaceIds);
  const missingSurfaceIds = ownership.surfaces
    .filter((surface) => surface.targetOwner === "packages/core")
    .filter((surface) => !coreOwned.has(surface.id))
    .map((surface) => surface.id);

  return {
    ready: missingSurfaceIds.length === 0,
    missingSurfaceIds,
    appShellTarget: ownership.appShellTarget,
  };
}
