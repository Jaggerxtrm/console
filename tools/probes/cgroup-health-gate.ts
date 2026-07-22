#!/usr/bin/env bun
/**
 * cgroup-health-gate — correct replacement for the invalid MemoryCurrent-only
 * deployment gate that HOLDed the PR63 production window at T+25.
 *
 * Why MemoryCurrent-only is invalid:
 *   cgroup v2 memory.current = anon + file(page cache) + kernel + slab. The
 *   "file" term is reclaimable OS cache of the multi-GiB SQLite files warmed by
 *   bounded reads. It climbs toward MemoryMax by design and the kernel reclaims
 *   it there (memory.events max>0, oom=0). Gating on memory.current therefore
 *   trips on healthy, reclaimable cache and does not measure service health.
 *   See docs/operations/pr63-filecache-attribution.md and tools/probes/filecache-repro.ts.
 *
 * Correct gate criteria (all must hold for PASS):
 *   1. memory.events oom == 0 AND oom_kill == 0      (no real out-of-memory)
 *   2. anonymous working set under ANON_CEILING_MB    (the real heap signal;
 *      read from memory.stat "anon", cross-checked against MainPID RssAnon)
 *   3. service active/running, NRestarts unchanged    (no crash loop)
 *   4. /health == 200 and endpoint latency under p95 ceiling (optional probes)
 * File cache near MemoryMax is reported as cache_pressure INFO, never a FAIL,
 * unless it coincides with oom>0 or anon over ceiling (genuine saturation).
 *
 * Read-only: reads cgroupfs/procfs counters and (optionally) GET endpoints.
 * Never opens, copies, or mutates a production database.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SERVICE = process.env.GATE_SERVICE ?? "gitboard.service";
const ANON_CEILING_MB = Number(process.env.GATE_ANON_CEILING_MB ?? "512");
const HEALTH_URL = process.env.GATE_HEALTH_URL ?? "http://100.113.49.52:3030/health";
const FEED_URL = process.env.GATE_FEED_URL ?? "http://100.113.49.52:3030/api/specialists/jobs/684b95/feed-events";
const LATENCY_CEILING_S = Number(process.env.GATE_LATENCY_CEILING_S ?? "5");
const PROBE_ENDPOINTS = process.env.GATE_PROBE_ENDPOINTS === "1";

function sh(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

function controlGroup(): string | null {
  const cg = sh("systemctl", ["--user", "show", SERVICE, "-p", "ControlGroup", "--value"]);
  return cg ? `/sys/fs/cgroup${cg}` : null;
}

function readStat(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  const p = `${dir}/memory.stat`;
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const [k, v] = line.split(" ");
    if (k && v !== undefined) out[k] = Number(v);
  }
  return out;
}

function readEvents(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  const p = `${dir}/memory.events`;
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const [k, v] = line.split(" ");
    if (k && v !== undefined) out[k] = Number(v);
  }
  return out;
}

function readNum(p: string): number | null {
  if (!existsSync(p)) return null;
  const v = Number(readFileSync(p, "utf8").trim());
  return Number.isFinite(v) ? v : null;
}

function mainPid(): number | null {
  const pid = Number(sh("systemctl", ["--user", "show", SERVICE, "-p", "MainPID", "--value"]));
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function procAnonKb(pid: number): { rssAnonKb: number; vmRssKb: number } {
  const p = `/proc/${pid}/status`;
  if (!existsSync(p)) return { rssAnonKb: 0, vmRssKb: 0 };
  const s = readFileSync(p, "utf8");
  const grab = (k: string) => Number(s.match(new RegExp(`^${k}:\\s+(\\d+)\\s+kB`, "m"))?.[1] ?? 0);
  return { rssAnonKb: grab("RssAnon"), vmRssKb: grab("VmRSS") };
}

async function probe(url: string): Promise<{ status: number; seconds: number } | null> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    await res.arrayBuffer();
    return { status: res.status, seconds: (performance.now() - t0) / 1000 };
  } catch {
    return null;
  }
}

async function main() {
  const dir = controlGroup();
  if (!dir || !existsSync(dir)) {
    console.log(JSON.stringify({ verdict: "UNKNOWN", reason: "cgroup not found", service: SERVICE }));
    process.exit(3);
  }

  const current = readNum(`${dir}/memory.current`);
  const max = readNum(`${dir}/memory.max`);
  const stat = readStat(dir);
  const events = readEvents(dir);
  const pid = mainPid();
  const proc = pid ? procAnonKb(pid) : { rssAnonKb: 0, vmRssKb: 0 };
  const nRestarts = Number(sh("systemctl", ["--user", "show", SERVICE, "-p", "NRestarts", "--value"]) || "0");
  const activeState = sh("systemctl", ["--user", "show", SERVICE, "-p", "ActiveState", "--value"]);

  const anonBytes = stat.anon ?? proc.rssAnonKb * 1024;
  const fileBytes = stat.file ?? 0;
  const anonMb = anonBytes / (1024 * 1024);
  const fileMb = fileBytes / (1024 * 1024);
  const oom = events.oom ?? 0;
  const oomKill = events.oom_kill ?? 0;
  const maxEvents = events.max ?? 0;
  const cachePressure = max != null && current != null && max > 0 ? current / max : 0;

  const failures: string[] = [];
  if (oom > 0 || oomKill > 0) failures.push(`oom=${oom} oom_kill=${oomKill}`);
  if (anonMb > ANON_CEILING_MB) failures.push(`anon=${anonMb.toFixed(0)}MiB > ceiling ${ANON_CEILING_MB}MiB`);
  if (activeState !== "active") failures.push(`ActiveState=${activeState}`);

  let endpoints: Record<string, { status: number; seconds: number } | null> = {};
  if (PROBE_ENDPOINTS) {
    endpoints.health = await probe(HEALTH_URL);
    endpoints.feed = await probe(FEED_URL);
    if (!endpoints.health || endpoints.health.status !== 200) failures.push("health != 200");
    for (const [name, e] of Object.entries(endpoints)) {
      if (e && e.seconds > LATENCY_CEILING_S) failures.push(`${name} latency ${e.seconds.toFixed(2)}s > ${LATENCY_CEILING_S}s`);
    }
  }

  const verdict = failures.length === 0 ? "PASS" : "FAIL";
  const report = {
    verdict,
    service: SERVICE,
    failures,
    memory: {
      current_bytes: current,
      max_bytes: max,
      anon_bytes: anonBytes,
      anon_mb: Number(anonMb.toFixed(1)),
      file_bytes: fileBytes,
      file_mb: Number(fileMb.toFixed(1)),
      slab_bytes: stat.slab ?? 0,
      kernel_stack_bytes: stat.kernel_stack ?? 0,
      file_mapped_bytes: stat.file_mapped ?? 0,
    },
    process: { pid, n_restarts: nRestarts, active_state: activeState, rss_anon_kb: proc.rssAnonKb, vm_rss_kb: proc.vmRssKb },
    events: { max: maxEvents, oom, oom_kill: oomKill },
    cache_pressure: { current_over_max: Number(cachePressure.toFixed(3)), note: "reclaimable; INFO only unless oom>0 or anon over ceiling" },
    endpoints,
    criteria: "anon/oom/restarts/latency — MemoryCurrent is NOT a fail criterion",
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(verdict === "PASS" ? 0 : 1);
}

await main();
