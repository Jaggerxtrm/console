import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createXtrmDatabase } from "../../../../packages/core/src/state/database.ts";
import { insertEvent, upsertRepo } from "../../../../packages/core/src/github/index.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const ADMIN_TOKEN = "host-parity-secret";

type RunningHost = {
  name: string;
  baseUrl: string;
  process: Bun.Subprocess;
  stdout: Promise<string>;
  stderr: Promise<string>;
};

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "console-api-host-parity-"));
  const oldData = join(root, "gitboard-data");
  const newData = join(root, "console-data");
  const emptyProjects = join(root, "empty-projects");
  const emptyObservability = join(root, "empty-observability");
  await Promise.all([
    mkdir(oldData, { recursive: true }),
    mkdir(newData, { recursive: true }),
    mkdir(emptyProjects, { recursive: true }),
    mkdir(emptyObservability, { recursive: true }),
  ]);
  seedDatabase(join(oldData, "xtrm.sqlite"));
  seedDatabase(join(newData, "xtrm.sqlite"));

  const [oldPort, newPort] = await Promise.all([reservePort(), reservePort()]);
  const commonEnv = {
    ...process.env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_PROJECTS_DIR: emptyProjects,
    OBSERVABILITY_ROOTS: emptyObservability,
    LOG_DIR: join(root, "logs"),
    SKIP_GITHUB_POLLER: "1",
    GITBOARD_ENABLE_PARITY: "0",
    GITBOARD_STARTUP_MATERIALIZE: "0",
    CONSOLE_WRITE_ADMIN_TOKEN: ADMIN_TOKEN,
  };
  const oldHost = spawnHost("gitboard", oldPort, ["bun", "src/index.ts"], join(REPO_ROOT, "apps/gitboard"), {
    ...commonEnv,
    GITBOARD_DATA_DIR: oldData,
  });
  const newHost = spawnHost("console", newPort, ["bun", "src/server/index.ts"], join(REPO_ROOT, "apps/console"), {
    ...commonEnv,
    XTRM_DATA_DIR: newData,
  });
  const hosts = [oldHost, newHost];

  try {
    await Promise.all(hosts.map((host) => waitForHealth(host)));
    await assertHealth(hosts);

    const paths = [
      "/api/github/repos",
      "/api/github/events?limit=1&offset=1",
      "/api/specialists/jobs?bead_id=bead-1",
      "/api/specialists/jobs/in-flight?repo_slug=repo-a&limit=5",
      "/api/console/observability/summary?range=30d",
      "/api/console/explore/agentops?range=30d&repo_slug=repo-a&status=error",
    ];
    for (const path of paths) await assertSameJson(hosts, path, 200);

    const scannerNoise = await assertSeedProjectContract(hosts);

    const page = await requestJson(newHost, "/api/github/events?limit=1&offset=1");
    assert(isRecord(page.body), "GitHub nonzero-offset page is not an object");
    assert(page.body.limit === 1 && page.body.offset === 1, "GitHub pagination envelope changed");
    assert(Array.isArray(page.body.data) && page.body.data.length === 1, "GitHub pagination cardinality changed");
    assert(isRecord(page.body.data[0]) && page.body.data[0].id === "event-1", "GitHub nonzero offset returned the wrong event");

    const writeInit: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json", "x-console-write-token": ADMIN_TOKEN },
      body: JSON.stringify({ full_name: "owner/new-repo", display_name: "New repo" }),
    };
    const [oldWrite, newWrite] = await Promise.all(hosts.map((host) => requestJson(host, "/api/github/repos", writeInit)));
    assert(oldWrite.status === 201 && newWrite.status === 201, `GitHub write status mismatch: ${oldWrite.status}/${newWrite.status}`);
    expectValue(newWrite.body, oldWrite.body, "GitHub write response");
    await assertSameJson(hosts, "/api/github/repos", 200);

    const validVerify = "/api/internal/verify-runtime?since=2026-07-23T11:00:00.000Z&until=2026-07-23T12:00:00.000Z";
    const invalidVerify = "/api/internal/verify-runtime?since=2026-07-01T00:00:00.000Z&until=2026-07-23T12:00:00.000Z";
    for (const host of hosts) {
      assert((await requestJson(host, validVerify)).status === 200, `${host.name} bounded verifier failed`);
      assert((await requestJson(host, invalidVerify)).status === 400, `${host.name} accepted oversized verifier interval`);
    }

    console.log(JSON.stringify({
      smoke: "api-host-parity",
      result: "PASS",
      ports: { gitboard: oldPort, console: newPort },
      paths,
      scannerDiscoveryNoise: scannerNoise,
    }, null, 2));
  } catch (error) {
    await reportFailure(hosts, error);
    throw error;
  } finally {
    await Promise.all(hosts.map(stopHost));
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
  db.query("INSERT INTO substrate_issues (repo_slug, issue_id, title, state, priority, issue_type, created_at, updated_at) VALUES ('repo-a', 'bead-1', 'Parity issue', 'open', 1, 'task', ?, ?)").run(
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

function spawnHost(name: string, port: number, command: string[], cwd: string, env: Record<string, string | undefined>): RunningHost {
  const process = Bun.spawn(command, { cwd, env: { ...env, PORT: String(port) }, stdout: "pipe", stderr: "pipe" });
  return {
    name,
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
    if (host.process.exitCode !== null) throw new Error(`${host.name} exited before health (code ${host.process.exitCode})`);
    try {
      const response = await fetch(`${host.baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Retry until the bounded deadline.
    }
    await Bun.sleep(100);
  }
  throw new Error(`${host.name} health timed out`);
}

async function assertHealth(hosts: RunningHost[]): Promise<void> {
  for (const host of hosts) {
    const response = await requestJson(host, "/health");
    assert(response.status === 200, `${host.name} health returned ${response.status}`);
    assert(isRecord(response.body) && response.body.status === "ok", `${host.name} health shape changed`);
  }
}

async function assertSameJson(hosts: RunningHost[], path: string, expectedStatus: number): Promise<void> {
  const [oldResponse, newResponse] = await Promise.all(hosts.map((host) => requestJson(host, path)));
  assert(oldResponse.status === expectedStatus, `gitboard ${path} returned ${oldResponse.status}`);
  assert(newResponse.status === expectedStatus, `console ${path} returned ${newResponse.status}`);
  expectValue(normalizeParityValue(newResponse.body), normalizeParityValue(oldResponse.body), path);
}

async function assertSeedProjectContract(hosts: RunningHost[]): Promise<{ gitboardExtraProjects: number; consoleExtraProjects: number }> {
  const responses = await Promise.all(hosts.map((host) => requestJson(host, "/api/substrate/projects")));
  const projects = responses.map((response, index) => {
    assert(response.status === 200, `${hosts[index].name} /api/substrate/projects returned ${response.status}`);
    assert(isRecord(response.body) && Array.isArray(response.body.projects), `${hosts[index].name} projects shape changed`);
    return response.body.projects as Array<Record<string, unknown>>;
  });
  const seeded = projects.map((rows, index) => {
    const row = rows.find((item) => item.id === "repo-a");
    assert(row, `${hosts[index].name} omitted seeded repo-a project`);
    return {
      id: row.id,
      name: row.name,
      source: row.source,
      sourcePriority: row.sourcePriority,
      status: row.status,
      issueCount: row.issueCount,
      sourceHealth: row.sourceHealth,
    };
  });
  expectValue(seeded[1], seeded[0], "seeded substrate project contract");
  return {
    gitboardExtraProjects: Math.max(0, projects[0].length - 1),
    consoleExtraProjects: Math.max(0, projects[1].length - 1),
  };
}

async function requestJson(host: RunningHost, path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${host.baseUrl}${path}`, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${host.name} ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
  return { status: response.status, body };
}

function expectValue(actual: unknown, expected: unknown, label: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  assert(left === right, `${label} mismatch\nexpected ${right}\nreceived ${left}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeParityValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeParityValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === "checked_at" || key === "generated_at" ? "<generated>" : normalizeParityValue(item),
  ]));
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

async function reportFailure(hosts: RunningHost[], error: unknown): Promise<void> {
  console.error(error);
  await Promise.all(hosts.map(stopHost));
  for (const host of hosts) {
    const [stdout, stderr] = await Promise.all([host.stdout, host.stderr]);
    console.error(`\n[${host.name} stdout]\n${stdout.slice(-8_000)}`);
    console.error(`\n[${host.name} stderr]\n${stderr.slice(-8_000)}`);
  }
}

await main();
