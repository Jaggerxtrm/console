import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createXtrmDatabase } from "../../../../packages/core/src/state/database.ts";
import type { LogEntry } from "../../../../packages/core/src/runtime/logs.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const ADMIN_TOKEN = "phase4-lifecycle-admin";
const REQUIRED_EVENTS = [
  "runtime.start",
  "scanner.start",
  "refresh.start",
  "refresh.end",
  "materializer.trigger",
  "materializer.run",
  "materializer.publishHint",
  "watcher.start",
  "watcher.attach",
  "watcher.skip",
  "watcher.stop",
  "watcher.cleanup",
  "scanner.stop",
  "runtime.stop",
] as const;

type RunningHost = {
  baseUrl: string;
  process: Bun.Subprocess;
  stdout: Promise<string>;
  stderr: Promise<string>;
};

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "console-phase4-lifecycle-"));
  const dataDir = join(root, "data");
  const projectsDir = join(root, "projects-private-marker");
  const healthyProject = join(projectsDir, "healthy");
  const missingProject = join(projectsDir, "missing-jsonl");
  const logDir = join(root, "logs");
  const observabilityRoot = join(root, "missing-observability");
  await Promise.all([
    mkdir(join(healthyProject, ".beads"), { recursive: true }),
    mkdir(join(missingProject, ".beads"), { recursive: true }),
    mkdir(observabilityRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(healthyProject, ".beads", "metadata.json"), JSON.stringify({ project_id: "phase4-healthy" })),
    writeFile(join(healthyProject, ".beads", "issues.jsonl"), JSON.stringify({
      id: "phase4-healthy.1",
      title: "Console lifecycle smoke",
      description: "materialized by apps/console",
      status: "open",
      priority: 1,
      issue_type: "task",
      owner: null,
      labels: [],
      dependencies: [],
      related_ids: [],
      created_at: "2026-07-21T00:00:00.000Z",
      updated_at: "2026-07-21T00:00:00.000Z",
    }) + "\n"),
    writeFile(join(missingProject, ".beads", "metadata.json"), JSON.stringify({ project_id: "phase4-missing" })),
  ]);

  const port = await reservePort();
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(port),
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_PROJECTS_DIR: projectsDir,
    OBSERVABILITY_ROOTS: observabilityRoot,
    XTRM_DATA_DIR: dataDir,
    LOG_DIR: logDir,
    SKIP_GITHUB_POLLER: "1",
    GITBOARD_ENABLE_PARITY: "0",
    XTRM_ENABLE_PARITY: "0",
    GITBOARD_STARTUP_MATERIALIZE: "0",
    XTRM_STARTUP_MATERIALIZE: "0",
    CONSOLE_WRITE_ADMIN_TOKEN: ADMIN_TOKEN,
  };
  const host = spawnHost(port, environment);
  const spawnedHosts: RunningHost[] = [host];

  try {
    await waitForHealth(host);
    const lockPath = join(dataDir, "xtrm.sqlite.runtime-writer.sqlite");
    assert(existsSync(lockPath), "Console did not hold the runtime writer lease");

    const contender = spawnHost(await reservePort(), environment);
    spawnedHosts.push(contender);
    const contenderExit = await Promise.race([
      contender.process.exited,
      Bun.sleep(5_000).then(() => null),
    ]);
    assert(contenderExit !== null && contenderExit !== 0, "second Console writer was not rejected");
    const contenderStderr = await contender.stderr;
    assert(contenderStderr.includes("active runtime writer"), "writer rejection did not identify the active lease");
    const legacyContender = spawnLegacyHost(await reservePort(), environment);
    spawnedHosts.push(legacyContender);
    const legacyExit = await Promise.race([
      legacyContender.process.exited,
      Bun.sleep(5_000).then(() => null),
    ]);
    assert(legacyExit !== null && legacyExit !== 0, "legacy Gitboard writer was not rejected");
    assert((await legacyContender.stderr).includes("active runtime writer"), "legacy writer rejection did not identify the active lease");

    await waitForMaterialization(host);
    const refresh = await fetch(`${host.baseUrl}/api/sources/refresh`, {
      method: "POST",
      headers: { "x-console-write-token": ADMIN_TOKEN },
    });
    assert(refresh.status === 200 || refresh.status === 202 || refresh.status === 429, `source refresh returned ${refresh.status}`);

    const ring = await readRuntimeLogs(host);
    assert(ring.some((entry) => entry.event === "materializer.run"), "materializer run was absent from the live log ring");
    assert((await fetch(`${host.baseUrl}/health`)).ok, "primary Console became unhealthy after writer contention");

    const primaryExit = await stopHost(host);
    assert(primaryExit === 0, `primary Console did not exit gracefully: ${primaryExit}`);
    const [primaryStdout, primaryStderr] = await Promise.all([host.stdout, host.stderr]);
    assert(!`${primaryStdout}\n${primaryStderr}`.includes(root), "process output leaked an absolute fixture path");
    assert(!`${primaryStdout}\n${primaryStderr}`.includes(ADMIN_TOKEN), "process output leaked the admin token");
    assert(existsSync(lockPath), "runtime writer lease sidecar was not persisted");
    const replacement = spawnHost(await reservePort(), environment);
    spawnedHosts.push(replacement);
    await waitForHealth(replacement);
    assert(await stopHost(replacement) === 0, "replacement Console did not exit gracefully");

    const crashVictim = spawnHost(await reservePort(), environment);
    spawnedHosts.push(crashVictim);
    await waitForHealth(crashVictim);
    crashVictim.process.kill("SIGKILL");
    await crashVictim.process.exited;
    assert(crashVictim.process.exitCode !== 0, "crash lease probe exited successfully");
    const crashReplacement = spawnHost(await reservePort(), environment);
    spawnedHosts.push(crashReplacement);
    await waitForHealth(crashReplacement);
    assert(await stopHost(crashReplacement) === 0, "Console did not reacquire the writer lease after crash");

    const diskEntries = await readDiskLogs(logDir);
    assertLifecycleTelemetry(diskEntries, root, ADMIN_TOKEN);
    assertPersistedState(join(dataDir, "xtrm.sqlite"));

    const discoveryNoise = diskEntries.filter((entry) => entry.event === "scanner.probe").length;
    assert(discoveryNoise === 0, `scanner discovery emitted ${discoveryNoise} unexpected probe warnings`);
    console.log(JSON.stringify({
      smoke: "phase4-lifecycle-telemetry",
      result: "PASS",
      lifecycleEvents: REQUIRED_EVENTS.length,
      scannerDiscoveryNoise: discoveryNoise,
      secondWriterRejected: true,
      legacyWriterRejected: true,
      crashLeaseReleased: true,
      persistedIssue: "phase4-healthy.1",
    }, null, 2));
  } catch (error) {
    await reportFailure(host, error);
    throw error;
  } finally {
    await Promise.allSettled(spawnedHosts.map(stopHost));
    await rm(root, { recursive: true, force: true });
  }
}

function spawnHost(port: number, env: Record<string, string | undefined>): RunningHost {
  const process = Bun.spawn(["bun", "src/server/index.ts"], {
    cwd: join(REPO_ROOT, "apps/console"),
    env: { ...env, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    process,
    stdout: new Response(process.stdout).text(),
    stderr: new Response(process.stderr).text(),
  };
}

function spawnLegacyHost(port: number, env: Record<string, string | undefined>): RunningHost {
  const process = Bun.spawn(["bun", "src/index.ts"], {
    cwd: join(REPO_ROOT, "apps/gitboard"),
    env: {
      ...env,
      PORT: String(port),
      LOG_DIR: join(env.XTRM_DATA_DIR ?? tmpdir(), "legacy-contender-logs"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    process,
    stdout: new Response(process.stdout).text(),
    stderr: new Response(process.stderr).text(),
  };
}

async function reservePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("reserved") });
  const port = server.port ?? 0;
  await server.stop(true);
  assert(port > 0, "failed to reserve an ephemeral port");
  return port;
}

async function waitForHealth(host: RunningHost): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (host.process.exitCode !== null) throw new Error(`Console exited before health (code ${host.process.exitCode})`);
    try {
      if ((await fetch(`${host.baseUrl}/health`)).ok) return;
    } catch {
      // Retry within the bounded startup window.
    }
    await Bun.sleep(100);
  }
  throw new Error("Console health timed out");
}

async function waitForMaterialization(host: RunningHost): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${host.baseUrl}/api/substrate/projects/phase4-healthy/issues/phase4-healthy.1`);
    if (response.ok) return;
    await Bun.sleep(100);
  }
  throw new Error("Console materialization timed out");
}

async function readRuntimeLogs(host: RunningHost): Promise<LogEntry[]> {
  const response = await fetch(`${host.baseUrl}/api/internal/logs?limit=1000`);
  assert(response.ok, `internal logs returned ${response.status}`);
  return await response.json() as LogEntry[];
}

async function stopHost(host: RunningHost): Promise<number | null> {
  if (host.process.exitCode === null) host.process.kill("SIGTERM");
  const exited = await Promise.race([
    host.process.exited.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (!exited && host.process.exitCode === null) {
    host.process.kill("SIGKILL");
    await host.process.exited;
  }
  return host.process.exitCode;
}

async function readDiskLogs(logDir: string): Promise<LogEntry[]> {
  const files = (await readdir(logDir)).filter((name) => name.endsWith(".jsonl")).sort();
  const lines = (await Promise.all(files.map((name) => readFile(join(logDir, name), "utf-8"))))
    .flatMap((content) => content.split("\n"))
    .filter(Boolean);
  return lines.map((line) => JSON.parse(line) as LogEntry);
}

function assertLifecycleTelemetry(entries: LogEntry[], privateRoot: string, secret: string): void {
  for (const event of REQUIRED_EVENTS) {
    const matches = entries.filter((entry) => entry.event === event);
    assert(matches.length > 0, `missing lifecycle event ${event}`);
    assert(matches.some((entry) => entry.data?.owner === "apps/console"), `${event} omitted Console ownership`);
  }
  const refreshEnd = entries.find((entry) => entry.event === "refresh.end" && entry.data?.outcome === "success");
  assert(typeof refreshEnd?.data?.duration_ms === "number", "refresh.end omitted outcome or duration_ms");
  const materializerRun = entries.find((entry) => entry.event === "materializer.run" && entry.data?.outcome === "success");
  assert(typeof materializerRun?.data?.duration_ms === "number", "materializer.run omitted duration_ms");
  const serialized = JSON.stringify(entries);
  assert(!serialized.includes(privateRoot), "structured logs leaked an absolute project path");
  assert(!serialized.includes(secret), "structured logs leaked the admin token");
}

function assertPersistedState(databasePath: string): void {
  const db = createXtrmDatabase(databasePath);
  try {
    const issue = db.query("SELECT title, state FROM substrate_issues WHERE repo_slug = ? AND issue_id = ?")
      .get("phase4-healthy", "phase4-healthy.1") as { title: string; state: string } | null;
    assert(issue?.title === "Console lifecycle smoke" && issue.state === "open", "materialized issue was not persisted");
    const state = db.query("SELECT cursor, last_status, last_success_at FROM materialization_state WHERE source_key = ?")
      .get("beads:phase4-healthy") as { cursor: string | null; last_status: string; last_success_at: string | null } | null;
    assert(Boolean(state?.cursor) && state?.last_status === "success" && Boolean(state.last_success_at), "materialization cursor/state was not committed");
  } finally {
    db.close();
  }
}

async function reportFailure(host: RunningHost, error: unknown): Promise<void> {
  console.error(error);
  await stopHost(host);
  const [stdout, stderr] = await Promise.all([host.stdout, host.stderr]);
  console.error(`\n[console stdout]\n${stdout.slice(-8_000)}`);
  console.error(`\n[console stderr]\n${stderr.slice(-8_000)}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
