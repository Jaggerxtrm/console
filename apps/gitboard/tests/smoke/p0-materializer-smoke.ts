import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChannelRegistry } from "../../src/api/ws/channels.ts";
import { createXtrmDatabase } from "../../src/core/xtrm-store.ts";
import { Materializer } from "../../src/core/materializer/index.ts";
import { COALESCE_MS } from "../../src/core/materializer/queue.ts";
import { EchoAdapter } from "../core/materializer/fixtures/echo-adapter.ts";

const tmpDir = join(process.cwd(), ".tmp-materializer-smoke");
const dbPath = join(tmpDir, "xtrm.sqlite");
const logPath = join(process.cwd(), "tests/smoke/p0-materializer-smoke.log");

function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function main(): Promise<void> {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(join(process.cwd(), "tests/smoke"), { recursive: true });
  const db = createXtrmDatabase(dbPath);
  const registry = new ChannelRegistry();
  const hints: unknown[] = [];
  registry.subscribe("system", { id: "smoke", send: (msg) => hints.push(msg) });
  const materializer = new Materializer(db, registry);
  const adapter = new EchoAdapter();
  materializer.register("echo:test", adapter);

  const rng = seededRng(1583);
  const keys = Array.from({ length: 100 }, (_, index) => `k-${index}-${Math.floor(rng() * 10_000)}`);
  for (const key of keys) adapter.upsert({ repo_slug: "repo/echo", issue_id: key, key, title: key, state: "open" });

  for (const key of keys) materializer.trigger("echo:test");
  await sleep(COALESCE_MS + 400);
  await waitFor(() => (db.query("SELECT count(*) AS count FROM substrate_issues").get() as { count: number }).count === 100, 5000);

  const rowCount = (db.query("SELECT count(*) AS count FROM substrate_issues").get() as { count: number }).count;
  const cursorAdvances = (db.query("SELECT count(*) AS count FROM materialization_state WHERE source_key = 'echo:test' AND cursor IS NOT NULL").get() as { count: number }).count;
  const hintCount = hints.length;

  const crashAdapter = new EchoAdapter();
  for (const key of keys) crashAdapter.upsert({ repo_slug: "repo/echo", issue_id: key, key, title: `${key}-v2`, state: "open" });
  const crashMaterializer = new Materializer(db, registry, {
    afterWritesBeforeCursorAdvance: () => {
      throw new Error("simulated crash");
    },
  });
  crashMaterializer.register("echo:test", crashAdapter);
  const beforeCursor = (db.query("SELECT cursor FROM materialization_state WHERE source_key = 'echo:test'").get() as { cursor: string }).cursor;
  try {
    await crashMaterializer.runOnce("echo:test");
    throw new Error("expected crash");
  } catch {
    // expected
  }
  const afterCrashCursor = (db.query("SELECT cursor FROM materialization_state WHERE source_key = 'echo:test'").get() as { cursor: string }).cursor;
  if (afterCrashCursor !== beforeCursor) throw new Error("cursor advanced during crash");

  const recoveryMaterializer = new Materializer(db, registry);
  recoveryMaterializer.register("echo:test", crashAdapter);
  await recoveryMaterializer.runOnce("echo:test");
  const doubled = (db.query("SELECT count(*) AS count FROM substrate_issues WHERE repo_slug = 'repo/echo' AND deleted_at IS NULL").get() as { count: number }).count;
  if (doubled !== 100) throw new Error("double-application detected");

  const summary = `${new Date().toISOString()} rowCount=${rowCount} cursorAdvances=${cursorAdvances} hints=${hintCount} coalesceMs=${COALESCE_MS}`;
  writeFileSync(logPath, `${summary}\n`);
  db.close();
  console.log(summary);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
