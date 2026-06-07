import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ProbeResult = {
  path: string;
  status: number;
  bytes: number;
  ok: boolean;
};

type LogCounts = Record<string, number>;

const port = Number(process.env.PORT ?? 3099);
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = process.env.GITBOARD_DATA_DIR ?? mkdtempSync(join(tmpdir(), "gitboard-deprecation-data-"));
const logDir = process.env.LOG_DIR ?? mkdtempSync(join(tmpdir(), "gitboard-deprecation-logs-"));
const reportPath = process.env.SMOKE_REPORT_PATH ?? join(process.cwd(), "tests/smoke/deprecation-staging-smoke.report.json");
const githubPollerEnabled = process.env.GITBOARD_SMOKE_ENABLE_GITHUB_POLLER === "1";
const githubPollerRequired = process.env.GITBOARD_SMOKE_REQUIRE_GITHUB_POLLER === "1";
const endpointPaths = [
  "/health",
  "/api/substrate/projects",
  "/api/console/graph",
  "/api/feed",
  "/api/specialists/jobs/in-flight",
  "/api/github/repos",
  "/api/github/events",
  "/api/github/repos/stats",
  "/api/github/releases",
  "/api/internal/logs?limit=1000",
];
const logKeys = [
  "materializer.run",
  "materializer.publishHint",
  "channel.publish",
  "api.request.error",
  "api.request.slow",
  "materializer.error",
  "materializer.run.failed",
  "github.events.timing",
  "github.repos.timing",
  "github.releases.timing",
  "poller.cycle.start",
  "poller.cycle.complete",
  "poller.error",
  "poller.rate_limit.changed",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError instanceof Error ? lastError : new Error("health did not become ready");
}

async function probe(path: string): Promise<ProbeResult> {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  return {
    path,
    status: response.status,
    bytes: text.length,
    ok: response.status >= 200 && response.status < 300,
  };
}

async function readLogCounts(): Promise<LogCounts> {
  const response = await fetch(`${baseUrl}/api/internal/logs?limit=1000`);
  const payload = await response.json();
  const rows = Array.isArray(payload.logs) ? payload.logs : Array.isArray(payload) ? payload : [];
  const counts: LogCounts = {};
  for (const key of logKeys) {
    counts[key] = rows.filter((row: unknown) => JSON.stringify(row).includes(key)).length;
  }
  counts.rows = rows.length;
  return counts;
}

async function waitForObservableActivity(timeoutMs: number): Promise<LogCounts> {
  const startedAt = Date.now();
  let counts = await readLogCounts();
  while (Date.now() - startedAt < timeoutMs) {
    if (
      (counts["materializer.run"] ?? 0) > 0 &&
      (counts["materializer.publishHint"] ?? 0) > 0 &&
      (counts["channel.publish"] ?? 0) > 0
    ) {
      return counts;
    }
    await sleep(500);
    counts = await readLogCounts();
  }
  return counts;
}

async function main(): Promise<void> {
  mkdirSync(join(process.cwd(), "tests/smoke"), { recursive: true });

  const serverEnv: Record<string, string | undefined> = {
    ...process.env,
    PORT: String(port),
    GITBOARD_DATA_DIR: dataDir,
    LOG_DIR: logDir,
  };
  if (!githubPollerEnabled) serverEnv.SKIP_GITHUB_POLLER = "1";
  else delete serverEnv.SKIP_GITHUB_POLLER;

  const server = Bun.spawn(["bun", "src/index.ts"], {
    cwd: process.cwd(),
    env: serverEnv,
    stdout: "ignore",
    stderr: "ignore",
  });

  const startedAt = new Date().toISOString();
  try {
    await waitForHealth(20_000);
    const probes: ProbeResult[] = [];
    for (const path of endpointPaths) {
      probes.push(await probe(path));
    }
    const logCounts = await waitForObservableActivity(15_000);
    const failures = [
      ...probes.filter((result) => !result.ok).map((result) => `${result.path} returned ${result.status}`),
    ];

    for (const key of ["materializer.run", "materializer.publishHint", "channel.publish"]) {
      if ((logCounts[key] ?? 0) === 0) failures.push(`${key}=0`);
    }

    for (const key of ["api.request.error", "materializer.error", "materializer.run.failed"]) {
      if ((logCounts[key] ?? 0) > 0) failures.push(`${key}=${logCounts[key]}`);
    }

    const githubPollerEvidence = {
      enabled: githubPollerEnabled,
      required: githubPollerRequired,
      cycleStarts: logCounts["poller.cycle.start"] ?? 0,
      cycleCompletes: logCounts["poller.cycle.complete"] ?? 0,
      routeTimingEvents: (logCounts["github.events.timing"] ?? 0) + (logCounts["github.repos.timing"] ?? 0) + (logCounts["github.releases.timing"] ?? 0),
      errors: logCounts["poller.error"] ?? 0,
      rateLimitChanges: logCounts["poller.rate_limit.changed"] ?? 0,
      classifiedUnavailableCredentials: githubPollerEnabled && !(process.env.GITHUB_TOKEN || process.env.GH_TOKEN),
    };
    if (githubPollerRequired && githubPollerEvidence.cycleStarts === 0 && !githubPollerEvidence.classifiedUnavailableCredentials) {
      failures.push("github poller enabled smoke produced no poller cycle evidence");
    }

    const report = {
      startedAt,
      completedAt: new Date().toISOString(),
      baseUrl,
      dataDir,
      logDir,
      skipGithubPoller: !githubPollerEnabled,
      githubPollerEvidence,
      probes,
      logCounts,
      ok: failures.length === 0,
      failures,
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    server.kill();
    await server.exited.catch(() => {});
    if (!process.env.GITBOARD_DATA_DIR) rmSync(dataDir, { recursive: true, force: true });
    if (!process.env.LOG_DIR) rmSync(logDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
