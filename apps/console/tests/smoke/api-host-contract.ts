import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createXtrmDatabase } from "../../../../packages/core/src/state/database.ts";
import { insertEvent, upsertRepo } from "../../../../packages/core/src/github/index.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const ADMIN_TOKEN = "host-contract-secret";

type RunningHost = {
  baseUrl: string;
  process: Bun.Subprocess;
  stdout: Promise<string>;
  stderr: Promise<string>;
};

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "console-api-host-contract-"));
  const dataDir = join(root, "console-data");
  const emptyProjects = join(root, "empty-projects");
  const emptyObservability = join(root, "empty-observability");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(emptyProjects, { recursive: true }),
    mkdir(emptyObservability, { recursive: true }),
  ]);
  seedDatabase(join(dataDir, "xtrm.sqlite"));

  const port = await reservePort();
  const host = spawnHost(port, {
    ...process.env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_PROJECTS_DIR: emptyProjects,
    OBSERVABILITY_ROOTS: emptyObservability,
    XTRM_DATA_DIR: dataDir,
    LOG_DIR: join(root, "logs"),
    SKIP_GITHUB_POLLER: "1",
    XTRM_ENABLE_PARITY: "0",
    XTRM_STARTUP_MATERIALIZE: "0",
    CONSOLE_WRITE_ADMIN_TOKEN: ADMIN_TOKEN,
  });

  try {
    await waitForHealth(host);
    const health = await requestJson(host, "/health");
    assert(health.status === 200, `health returned ${health.status}`);
    assert(isRecord(health.body) && health.body.status === "ok", "health shape changed");

    const paths = [
      "/api/github/repos",
      "/api/github/events?limit=1&offset=1",
      "/api/specialists/jobs?bead_id=bead-1",
      "/api/specialists/jobs/in-flight?repo_slug=repo-a&limit=5",
      "/api/console/observability/summary?range=30d",
      "/api/console/explore/agentops?range=30d&repo_slug=repo-a&status=error",
    ];
    for (const path of paths) {
      const response = await requestJson(host, path);
      assert(response.status === 200, `${path} returned ${response.status}`);
    }

    const scannerNoise = await assertSeedProjectContract(host);
    const page = await requestJson(host, "/api/github/events?limit=1&offset=1");
    assert(isRecord(page.body), "GitHub nonzero-offset page is not an object");
    assert(page.body.limit === 1 && page.body.offset === 1, "GitHub pagination envelope changed");
    assert(Array.isArray(page.body.data) && page.body.data.length === 1, "GitHub pagination cardinality changed");
    assert(isRecord(page.body.data[0]) && page.body.data[0].id === "event-1", "GitHub nonzero offset returned the wrong event");

    const write = await requestJson(host, "/api/github/repos", {
      method: "POST",
      headers: { "content-type": "application/json", "x-console-write-token": ADMIN_TOKEN },
      body: JSON.stringify({ full_name: "owner/new-repo", display_name: "New repo" }),
    });
    assert(write.status === 201, `GitHub write returned ${write.status}`);
    assert(isRecord(write.body) && write.body.full_name === "owner/new-repo", "GitHub write response changed");

    const repos = await requestJson(host, "/api/github/repos");
    assert(repos.status === 200 && isRecord(repos.body) && Array.isArray(repos.body.data), "GitHub repo list shape changed");
    assert(repos.body.data.some((repo) => isRecord(repo) && repo.full_name === "owner/new-repo"), "GitHub write was not persisted");

    const validVerify = "/api/internal/verify-runtime?since=2026-07-23T11:00:00.000Z&until=2026-07-23T12:00:00.000Z";
    const invalidVerify = "/api/internal/verify-runtime?since=2026-07-01T00:00:00.000Z&until=2026-07-23T12:00:00.000Z";
    assert((await requestJson(host, validVerify)).status === 200, "bounded verifier failed");
    assert((await requestJson(host, invalidVerify)).status === 400, "verifier accepted oversized interval");

    console.log(JSON.stringify({
      smoke: "api-host-contract",
      result: "PASS",
      port,
      paths,
      scannerDiscoveryNoise: scannerNoise,
    }, null, 2));
  } catch (error) {
    await reportFailure(host, error);
    throw error;
  } finally {
    await stopHost(host);
    await rm(root, { recursive: true, force: true });
  }
}

function seedDatabase(path: string): void {
  const db = createXtrmDatabase(path);
  upsertRepo(db, { full_name: "owner/repo", display_name: "Repo", tracked: true, group_name: null, last_polled_at: null, color: null });
  insertEvent(db, githubEvent("event-1", "2026-07-22T10:00:00Z"));
  insertEvent(db, githubEvent("event-2", "2026-07-22T11:00:00Z"));
  db.query("INSERT INTO sources (source_key, kind, path, origin, status, discovered_at, last_seen_at) VALUES (?, 'beads', ?, 'manual', 'active', ?, ?)").run(
    "beads:repo-a", join(path, "..", "repo-a", ".beads"), "2026-07-22T00:00:00.000Z", "2026-07-22T00:00:00.000Z",
  );
  db.query("INSERT INTO materialization_state (source_key, last_success_at, last_status) VALUES ('beads:repo-a', ?, 'success')").run("2026-07-22T00:00:00.000Z");
  db.query("INSERT INTO materialization_state (source_key, last_success_at, last_status) VALUES ('obs:repo-a', ?, 'success')").run("2026-07-22T00:00:00.000Z");
  db.query("INSERT INTO substrate_issues (repo_slug, issue_id, title, state, priority, issue_type, created_at, updated_at) VALUES ('repo-a', 'bead-1', 'Contract issue', 'open', 1, 'task', ?, ?)").run(
    "2026-07-22T00:00:00.000Z", "2026-07-22T00:00:00.000Z",
  );
  db.query(`
    INSERT INTO specialist_jobs (
      repo_slug, job_id, bead_id, specialist, status, chain_id, chain_kind, model,
      turns, tools, token_input, token_output, created_at, updated_at, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "repo-a", "job-1", "bead-1", "executor", "error", "chain-1", "executor", "test-model",
    2, 3, 4, 5, "2026-07-23T11:00:00.000Z", "2026-07-23T11:30:00.000Z", Date.parse("2026-07-23T11:30:00.000Z"),
  );
  db.close();
}

function githubEvent(id: string, createdAt: string) {
  return {
    id, type: "PushEvent", repo: "owner/repo", branch: "main", actor: "alice", action: null,
    title: id, body: null, url: `https://github.com/owner/repo/events/${id}`,
    additions: null, deletions: null, changed_files: null, commit_count: 1, created_at: createdAt,
  };
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
      // Retry until the bounded deadline.
    }
    await Bun.sleep(100);
  }
  throw new Error("Console health timed out");
}

async function assertSeedProjectContract(host: RunningHost): Promise<{ extraProjects: number }> {
  const response = await requestJson(host, "/api/substrate/projects");
  assert(response.status === 200, `/api/substrate/projects returned ${response.status}`);
  assert(isRecord(response.body) && Array.isArray(response.body.projects), "projects shape changed");
  const row = response.body.projects.find((item) => isRecord(item) && item.id === "repo-a");
  assert(isRecord(row), "seeded repo-a project was omitted");
  assert(row.issueCount === 1 && row.status === "idle", "seeded project contract changed");
  return { extraProjects: Math.max(0, response.body.projects.length - 1) };
}

async function requestJson(host: RunningHost, path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${host.baseUrl}${path}`, init);
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    throw new Error(`${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

async function stopHost(host: RunningHost): Promise<void> {
  if (host.process.exitCode === null) host.process.kill("SIGINT");
  const exited = await Promise.race([
    host.process.exited.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (!exited && host.process.exitCode === null) {
    host.process.kill("SIGKILL");
    await host.process.exited;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

await main();
