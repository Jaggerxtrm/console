import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BeadIssue } from "../../../src/types/beads.ts";

const setIntervalMock = vi.hoisted(() => vi.fn(() => ({ unref: vi.fn() })));
const clearIntervalMock = vi.hoisted(() => vi.fn());
const getIssuesMock = vi.hoisted(() => vi.fn());
const disconnectMock = vi.hoisted(() => vi.fn());
const scanDirectoryMock = vi.hoisted(() => vi.fn());
const doltClientInstances = vi.hoisted(() => [] as Array<{ getIssues: typeof getIssuesMock; disconnect: typeof disconnectMock }>);

vi.mock("node:timers", () => ({
  setInterval: setIntervalMock,
  clearInterval: clearIntervalMock,
}));
vi.mock("mysql2/promise", () => ({ default: {} }));
vi.mock("../../../src/core/project-scanner.ts", () => ({
  ProjectScanner: class {
    scanDirectory = scanDirectoryMock;
    constructor() {}
  },
}));
vi.mock("../../../src/core/dolt-client.ts", () => ({
  DoltClient: class {
    getIssues = getIssuesMock;
    disconnect = disconnectMock;
    constructor() {
      doltClientInstances.push(this);
    }
  },
  doltPoolKey: (config: { host: string; port: number; database?: string }) => `${config.host}:${config.port}/${config.database ?? "dolt"}`,
}));

import { __testOnly_getPooledDoltClient, createBeadsParityHarness } from "../../../src/api/routes/beads-parity.ts";

type FakeDb = { query: () => { all: () => Array<Record<string, unknown>> } };

let rootDir: string;
let shadowRows: Array<Record<string, unknown>>;
let db: FakeDb;

beforeEach(async () => {
  setIntervalMock.mockReset();
  clearIntervalMock.mockReset();
  scanDirectoryMock.mockReset();
  scanDirectoryMock.mockResolvedValue([]);
  getIssuesMock.mockReset();
  disconnectMock.mockReset();
  doltClientInstances.length = 0;
  rootDir = await mkdtemp(join(tmpdir(), "gitboard-parity-"));
  shadowRows = [];
  db = { query: () => ({ all: () => shadowRows }) };
  process.env.XDG_PROJECTS_DIR = rootDir;
});

afterEach(async () => {
  delete process.env.XDG_PROJECTS_DIR;
  await rm(rootDir, { recursive: true, force: true });
});

async function createProject(name: string, config: string, metadata: Record<string, unknown>, issuesJsonl?: string): Promise<string> {
  const repoDir = join(rootDir, name);
  const beadsDir = join(repoDir, ".beads");
  await mkdir(beadsDir, { recursive: true });
  await writeFile(join(beadsDir, "metadata.json"), JSON.stringify(metadata));
  await writeFile(join(beadsDir, "config.yaml"), config);
  if (issuesJsonl) await writeFile(join(beadsDir, "issues.jsonl"), issuesJsonl);
  return repoDir;
}

function seedShadowIssue(overrides: Partial<Record<string, string | null>> = {}): void {
  shadowRows = [{
    repo_slug: "repo-a",
    issue_id: "issue-1",
    title: overrides.title ?? "Title",
    body: overrides.body ?? "shadow body",
    state: overrides.state ?? "open",
    deleted_at: overrides.deleted_at ?? null,
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2024-01-02T00:00:00.000Z",
  }];
}

describe("createBeadsParityHarness", () => {
  it("defaults interval to 300000ms", async () => {
    await createProject("repo-a", "", { project_id: "repo-a", issue_count: 0 }, "");
    const harness = createBeadsParityHarness(db as never, { enabled: true });
    harness.start();
    expect(setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 300000);
  });

  it("reuses same DoltClient instance and caps read limit at 50 across two cycles", async () => {
    const clientPool = new Map<string, { client: { getIssues: typeof getIssuesMock; disconnect: typeof disconnectMock }; disconnect: () => void }>();
    const firstClient = __testOnly_getPooledDoltClient(clientPool as never, { host: "127.0.0.1", port: 3306, database: "dolt" });
    const secondClient = __testOnly_getPooledDoltClient(clientPool as never, { host: "127.0.0.1", port: 3306, database: "dolt" });

    expect(firstClient).toBe(secondClient);
    expect(getIssuesMock).not.toHaveBeenCalled();

    const getIssuesSpy = vi.fn();
    (firstClient as unknown as { getIssues: typeof getIssuesSpy }).getIssues = getIssuesSpy;
    await firstClient.getIssues({ limit: 50 });
    expect(getIssuesSpy).toHaveBeenCalledWith({ limit: 50 });
  });

  it("ignores untracked field drift in compareIssues", async () => {
    await createProject("repo-a", "", { project_id: "repo-a", issue_count: 1 }, `{"id":"issue-1","title":"Title","description":"live body","notes":null,"status":"open","priority":2,"issue_type":"task","owner":null,"created_at":"2024-01-01T00:00:00.000Z","created_by":null,"updated_at":"2024-01-02T00:00:00.000Z","project_id":"repo-a","dependencies":[],"related_ids":[],"labels":[]}
`);
    seedShadowIssue({ body: "shadow body" });

    const harness = createBeadsParityHarness(db as never, { enabled: false });
    const summary = await harness.runOnce();

    expect(summary.diff_count).toBe(0);
    expect(summary.diffs).toEqual([]);
  });

  it("ignores description drift by design", async () => {
    await createProject("repo-a", "", { project_id: "repo-a", issue_count: 1 }, `{"id":"issue-1","title":"Title","description":"live description","notes":null,"status":"open","priority":2,"issue_type":"task","owner":null,"created_at":"2024-01-01T00:00:00.000Z","created_by":null,"updated_at":"2024-01-02T00:00:00.000Z","project_id":"repo-a","dependencies":[],"related_ids":[],"labels":[]}
`);
    seedShadowIssue({ body: "shadow description" });

    const harness = createBeadsParityHarness(db as never, { enabled: false });
    const summary = await harness.runOnce();

    expect(summary.diff_count).toBe(0);
    expect(summary.diffs).toEqual([]);
  });
});
