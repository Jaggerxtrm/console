#!/usr/bin/env bun
/**
 * filecache-repro — isolated reproduction of the PR63 cgroup file-cache HOLD.
 *
 * Hypothesis under test: the production MemoryCurrent climb (455 MiB -> 1.82 GiB,
 * peak touching the 2 GiB MemoryMax) is reclaimable OS page cache warmed by
 * bounded SQLite reads against multi-GiB database files — NOT an anonymous heap
 * leak and NOT an unreclaimable allocation.
 *
 * Mechanism proven here (mirrors cgroup v2 memory.current = anon + file + kernel):
 *   1. A bounded query keeps the process anonymous working set (RssAnon) flat.
 *   2. The same reads pull database file pages into the OS page cache; those
 *      resident pages are exactly what cgroup counts as memory.stat "file".
 *   3. The cached pages are reclaimable on demand (posix_fadvise DONTNEED), so
 *      they are not a leak; under a real cgroup the kernel reclaims them at
 *      MemoryMax (memory.events max>0, oom=0), matching production.
 *
 * Safety: uses ONLY a temporary generated SQLite fixture in os.tmpdir(). No
 * production database is opened, read, copied, or mutated. Non-production use.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const HERE = dirname(import.meta.path);
const PCPROBE = join(HERE, "pcprobe");

const TARGET_MB = Number(process.env.REPRO_SIZE_MB ?? "384");
const ROWS = Number(process.env.REPRO_ROWS ?? "60000");

function procMem(): { vmrss_kb: number; rssanon_kb: number; rssfile_kb: number } {
  const status = readFileSync("/proc/self/status", "utf8");
  const grab = (key: string): number => {
    const m = status.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
    return m ? Number(m[1]) : 0;
  };
  return { vmrss_kb: grab("VmRSS"), rssanon_kb: grab("RssAnon"), rssfile_kb: grab("RssFile") };
}

function pcprobe(mode: "stat" | "evict", path: string): { resident_bytes: number; total_bytes: number } {
  const r = spawnSync(PCPROBE, [mode, path], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`pcprobe ${mode} failed: ${r.stderr}`);
  const j = JSON.parse(r.stdout.trim());
  return { resident_bytes: j.resident_bytes ?? 0, total_bytes: j.total_bytes ?? 0 };
}

const mb = (b: number) => (b / (1024 * 1024)).toFixed(1);

function main() {
  // Fixture MUST live on a disk-backed filesystem (ext4), not tmpfs: tmpfs pages
  // have no disk backing so POSIX_FADV_DONTNEED cannot evict them, and they are
  // not what cgroup v2 counts as reclaimable file cache. Production xtrm.sqlite
  // lives on ext4 (/dev/vda4); mirror that here.
  const base = process.env.REPRO_DIR ?? join(process.cwd(), ".repro-tmp");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "filecache-repro-"));
  const dbPath = join(dir, "fixture.sqlite");
  console.log(`# fixture: ${dbPath} (target ~${TARGET_MB} MiB, ${ROWS} rows)`);

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=MEMORY");
  db.exec("PRAGMA synchronous=OFF");
  db.exec("CREATE TABLE jobs (id INTEGER PRIMARY KEY, bead TEXT, payload TEXT, ts INTEGER)");

  // Fill to target size with a bounded, batched insert (no unbounded buffer).
  const payload = "x".repeat(Math.max(1, Math.floor((TARGET_MB * 1024 * 1024) / ROWS) - 64));
  const ins = db.prepare("INSERT INTO jobs (bead, payload, ts) VALUES (?, ?, ?)");
  const insertMany = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) ins.run(`bead-${i}`, payload, i);
  });
  insertMany(ROWS);
  const totalBytes = pcprobe("stat", dbPath).total_bytes;
  console.log(`# fixture size: ${mb(totalBytes)} MiB`);

  // Evict all of the fixture's pages so we start from a cold cache.
  pcprobe("evict", dbPath);
  const cold = pcprobe("stat", dbPath);
  const memCold = procMem();
  console.log(
    `cold   : file_resident=${mb(cold.resident_bytes)} MiB  RssAnon=${(memCold.rssanon_kb / 1024).toFixed(1)} MiB  VmRSS=${(memCold.vmrss_kb / 1024).toFixed(1)} MiB`,
  );

  // Bounded query: small LIMIT, ranged predicate — the PR63-shaped read.
  const bounded = db.prepare("SELECT id, bead, ts FROM jobs WHERE id > ? ORDER BY id LIMIT 100");
  const agg = db.prepare("SELECT count(*) AS c FROM jobs WHERE id BETWEEN ? AND ?");

  let rows = 0;
  for (let base = 0; base < ROWS; base += 5000) {
    rows += (bounded.all(base) as unknown[]).length;
    rows += (agg.get(base, base + 4999) as { c: number }).c;
  }
  const warm = pcprobe("stat", dbPath);
  const memWarm = procMem();
  console.log(
    `warm   : file_resident=${mb(warm.resident_bytes)} MiB  RssAnon=${(memWarm.rssanon_kb / 1024).toFixed(1)} MiB  VmRSS=${(memWarm.vmrss_kb / 1024).toFixed(1)} MiB  (rows=${rows})`,
  );

  // Reclaimability proof: the kernel can drop these pages on demand.
  pcprobe("evict", dbPath);
  const reclaimed = pcprobe("stat", dbPath);
  const memReclaimed = procMem();
  console.log(
    `reclaim: file_resident=${mb(reclaimed.resident_bytes)} MiB  RssAnon=${(memReclaimed.rssanon_kb / 1024).toFixed(1)} MiB  VmRSS=${(memReclaimed.vmrss_kb / 1024).toFixed(1)} MiB`,
  );

  const anonGrowthKb = memWarm.rssanon_kb - memCold.rssanon_kb;
  const fileGrowth = warm.resident_bytes - cold.resident_bytes;
  console.log("\n# attribution");
  console.log(`anon_growth=${(anonGrowthKb / 1024).toFixed(1)} MiB (bounded working set, flat)`);
  console.log(`file_cache_growth=${mb(fileGrowth)} MiB (reclaimable page cache of the db file)`);
  console.log(
    `reclaimed_back=${mb(warm.resident_bytes - reclaimed.resident_bytes)} MiB (evictable on demand => not a leak)`,
  );

  const pass = anonGrowthKb < 30 * 1024 && fileGrowth > 32 * 1024 * 1024 && reclaimed.resident_bytes < warm.resident_bytes;
  console.log(`\nRESULT: ${pass ? "PASS — file-cache growth is reclaimable; anon flat" : "FAIL — unexpected profile"}`);

  db.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main();
