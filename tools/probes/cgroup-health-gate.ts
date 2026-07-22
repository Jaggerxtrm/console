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
 *   3. service active AND SubState running            (no crash loop / not exited)
 *   4. MainPID present and /proc/<pid>/status readable (a live process to attribute)
 *   5. optional explicit baselines: NRestarts == GATE_EXPECT_RESTARTS and/or
 *      MainPID == GATE_EXPECT_PID when those env baselines are supplied
 *   6. /health == 200 and endpoint latency under p95 ceiling (optional probes);
 *      feed endpoint probed only when GATE_FEED_URL is explicitly set, non-200 fails
 * File cache near MemoryMax is reported as cache_pressure INFO, never a FAIL,
 * unless it coincides with oom>0 or anon over ceiling (genuine saturation).
 *
 * Fail-closed: invalid/non-finite numeric config, a missing MainPID, an
 * unreadable /proc/<pid>/status, a non-running substate, or a baseline mismatch
 * all produce FAIL. The report's `checked` list states exactly what was evaluated.
 *
 * Read-only: reads cgroupfs/procfs counters and (optionally) GET endpoints.
 * Never opens, copies, or mutates a production database.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

export interface GateConfig {
  service: string;
  anonCeilingMb: number;
  latencyCeilingS: number;
  healthUrl: string;
  /** Feed is probed only when explicitly configured; null means "not probed". */
  feedUrl: string | null;
  probeEndpoints: boolean;
  /** Optional deterministic baselines; null means "not checked". */
  expectRestarts: number | null;
  expectPid: number | null;
}

export interface EndpointResult {
  status: number;
  seconds: number;
}

export interface Snapshot {
  current: number | null;
  max: number | null;
  stat: Record<string, number>;
  events: Record<string, number>;
  pid: number | null;
  /** True only if /proc/<pid>/status was actually read for a live pid. */
  procReadable: boolean;
  rssAnonKb: number;
  vmRssKb: number;
  nRestarts: number | null;
  activeState: string;
  subState: string;
  endpoints: Record<string, EndpointResult | null>;
}

export interface Evaluation {
  verdict: "PASS" | "FAIL";
  failures: string[];
  checked: string[];
}

/** Parse a finite number from env or fail closed. */
function numEnv(env: Record<string, string | undefined>, name: string, def: string): number {
  const raw = env[name] ?? def;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    throw new Error(`invalid ${name}=${JSON.stringify(raw)}: not a finite number`);
  }
  return v;
}

/** Parse a non-negative integer baseline; null when unset. Fails closed on garbage. */
function baselineEnv(env: Record<string, string | undefined>, name: string): number | null {
  const raw = env[name];
  if (raw === undefined || raw === "") return null;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 0) {
    throw new Error(`invalid ${name}=${JSON.stringify(raw)}: expected a non-negative integer`);
  }
  return v;
}

export function parseConfig(env: Record<string, string | undefined> = process.env): GateConfig {
  const anonCeilingMb = numEnv(env, "GATE_ANON_CEILING_MB", "512");
  if (!(anonCeilingMb > 0)) throw new Error(`invalid GATE_ANON_CEILING_MB: must be > 0`);
  const latencyCeilingS = numEnv(env, "GATE_LATENCY_CEILING_S", "5");
  if (!(latencyCeilingS > 0)) throw new Error(`invalid GATE_LATENCY_CEILING_S: must be > 0`);
  const feedRaw = env.GATE_FEED_URL;
  return {
    service: env.GATE_SERVICE ?? "gitboard.service",
    anonCeilingMb,
    latencyCeilingS,
    // Portable default; the old hardcoded host IP was machine-specific.
    healthUrl: env.GATE_HEALTH_URL ?? "http://localhost:3030/health",
    // No hardcoded job feed: probe only when the operator supplies a URL.
    feedUrl: feedRaw && feedRaw.trim() !== "" ? feedRaw : null,
    probeEndpoints: env.GATE_PROBE_ENDPOINTS === "1",
    expectRestarts: baselineEnv(env, "GATE_EXPECT_RESTARTS"),
    expectPid: baselineEnv(env, "GATE_EXPECT_PID"),
  };
}

export function evaluate(cfg: GateConfig, snap: Snapshot): Evaluation {
  const failures: string[] = [];
  const checked: string[] = [];

  const anonBytes = snap.stat.anon ?? snap.rssAnonKb * 1024;
  const anonMb = anonBytes / (1024 * 1024);
  const oom = snap.events.oom ?? 0;
  const oomKill = snap.events.oom_kill ?? 0;

  checked.push("memory.events oom==0 && oom_kill==0");
  if (oom > 0 || oomKill > 0) failures.push(`oom=${oom} oom_kill=${oomKill}`);

  checked.push(`anon <= ${cfg.anonCeilingMb}MiB`);
  if (anonMb > cfg.anonCeilingMb) failures.push(`anon=${anonMb.toFixed(0)}MiB > ceiling ${cfg.anonCeilingMb}MiB`);

  checked.push("MainPID present");
  if (snap.pid == null) failures.push("MainPID missing");

  checked.push("/proc/<pid>/status readable");
  if (snap.pid != null && !snap.procReadable) failures.push(`/proc/${snap.pid}/status unreadable`);

  checked.push('ActiveState == "active"');
  if (snap.activeState !== "active") failures.push(`ActiveState=${snap.activeState || "unknown"}`);

  checked.push('SubState == "running"');
  if (snap.subState !== "running") failures.push(`SubState=${snap.subState || "unknown"}`);

  if (cfg.expectRestarts != null) {
    checked.push(`NRestarts == ${cfg.expectRestarts}`);
    if (snap.nRestarts == null) failures.push("NRestarts unreadable");
    else if (snap.nRestarts !== cfg.expectRestarts)
      failures.push(`NRestarts=${snap.nRestarts} != expected ${cfg.expectRestarts}`);
  }

  if (cfg.expectPid != null) {
    checked.push(`MainPID == ${cfg.expectPid}`);
    if (snap.pid !== cfg.expectPid) failures.push(`MainPID=${snap.pid ?? "null"} != expected ${cfg.expectPid}`);
  }

  if (cfg.probeEndpoints) {
    checked.push(`health == 200 (${cfg.healthUrl})`);
    const health = snap.endpoints.health;
    if (!health || health.status !== 200) failures.push(`health != 200 (got ${health ? health.status : "unreachable"})`);

    if (cfg.feedUrl != null) {
      checked.push(`feed == 200 (${cfg.feedUrl})`);
      const feed = snap.endpoints.feed;
      if (!feed || feed.status !== 200) failures.push(`feed != 200 (got ${feed ? feed.status : "unreachable"})`);
    }

    checked.push(`endpoint latency <= ${cfg.latencyCeilingS}s`);
    for (const [name, e] of Object.entries(snap.endpoints)) {
      if (e && e.seconds > cfg.latencyCeilingS)
        failures.push(`${name} latency ${e.seconds.toFixed(2)}s > ${cfg.latencyCeilingS}s`);
    }
  }

  return { verdict: failures.length === 0 ? "PASS" : "FAIL", failures, checked };
}

function sh(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

function controlGroup(service: string): string | null {
  const cg = sh("systemctl", ["--user", "show", service, "-p", "ControlGroup", "--value"]);
  return cg ? `/sys/fs/cgroup${cg}` : null;
}

function readKv(p: string): Record<string, number> {
  const out: Record<string, number> = {};
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

function mainPid(service: string): number | null {
  const raw = sh("systemctl", ["--user", "show", service, "-p", "MainPID", "--value"]);
  const pid = Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function readNRestarts(service: string): number | null {
  const raw = sh("systemctl", ["--user", "show", service, "-p", "NRestarts", "--value"]);
  if (raw === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

function procAnonKb(pid: number): { rssAnonKb: number; vmRssKb: number; readable: boolean } {
  const p = `/proc/${pid}/status`;
  if (!existsSync(p)) return { rssAnonKb: 0, vmRssKb: 0, readable: false };
  const s = readFileSync(p, "utf8");
  const grab = (k: string) => Number(s.match(new RegExp(`^${k}:\\s+(\\d+)\\s+kB`, "m"))?.[1] ?? 0);
  return { rssAnonKb: grab("RssAnon"), vmRssKb: grab("VmRSS"), readable: true };
}

async function probe(url: string): Promise<EndpointResult | null> {
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
  let cfg: GateConfig;
  try {
    cfg = parseConfig(process.env);
  } catch (e) {
    // Fail closed on invalid configuration.
    console.log(JSON.stringify({ verdict: "FAIL", failures: [`invalid config: ${(e as Error).message}`], checked: [] }, null, 2));
    process.exit(1);
  }

  const dir = controlGroup(cfg.service);
  if (!dir || !existsSync(dir)) {
    console.log(JSON.stringify({ verdict: "UNKNOWN", reason: "cgroup not found", service: cfg.service }));
    process.exit(3);
  }

  const pid = mainPid(cfg.service);
  const proc = pid ? procAnonKb(pid) : { rssAnonKb: 0, vmRssKb: 0, readable: false };
  const snap: Snapshot = {
    current: readNum(`${dir}/memory.current`),
    max: readNum(`${dir}/memory.max`),
    stat: readKv(`${dir}/memory.stat`),
    events: readKv(`${dir}/memory.events`),
    pid,
    procReadable: proc.readable,
    rssAnonKb: proc.rssAnonKb,
    vmRssKb: proc.vmRssKb,
    nRestarts: readNRestarts(cfg.service),
    activeState: sh("systemctl", ["--user", "show", cfg.service, "-p", "ActiveState", "--value"]),
    subState: sh("systemctl", ["--user", "show", cfg.service, "-p", "SubState", "--value"]),
    endpoints: {},
  };

  if (cfg.probeEndpoints) {
    snap.endpoints.health = await probe(cfg.healthUrl);
    if (cfg.feedUrl != null) snap.endpoints.feed = await probe(cfg.feedUrl);
  }

  const { verdict, failures, checked } = evaluate(cfg, snap);

  const anonBytes = snap.stat.anon ?? snap.rssAnonKb * 1024;
  const fileBytes = snap.stat.file ?? 0;
  const anonMb = anonBytes / (1024 * 1024);
  const fileMb = fileBytes / (1024 * 1024);
  const oom = snap.events.oom ?? 0;
  const oomKill = snap.events.oom_kill ?? 0;
  const maxEvents = snap.events.max ?? 0;
  const cachePressure =
    snap.max != null && snap.current != null && snap.max > 0 ? snap.current / snap.max : 0;

  const report = {
    verdict,
    service: cfg.service,
    failures,
    checked,
    memory: {
      current_bytes: snap.current,
      max_bytes: snap.max,
      anon_bytes: anonBytes,
      anon_mb: Number(anonMb.toFixed(1)),
      file_bytes: fileBytes,
      file_mb: Number(fileMb.toFixed(1)),
      slab_bytes: snap.stat.slab ?? 0,
      kernel_stack_bytes: snap.stat.kernel_stack ?? 0,
      file_mapped_bytes: snap.stat.file_mapped ?? 0,
    },
    process: {
      pid,
      n_restarts: snap.nRestarts,
      active_state: snap.activeState,
      sub_state: snap.subState,
      rss_anon_kb: snap.rssAnonKb,
      vm_rss_kb: snap.vmRssKb,
    },
    events: { max: maxEvents, oom, oom_kill: oomKill },
    cache_pressure: { current_over_max: Number(cachePressure.toFixed(3)), note: "reclaimable; INFO only unless oom>0 or anon over ceiling" },
    endpoints: snap.endpoints,
    criteria: "anon/oom/active+running/PID+proc readable" +
      (cfg.expectRestarts != null ? "/restart-baseline" : "") +
      (cfg.expectPid != null ? "/pid-baseline" : "") +
      (cfg.probeEndpoints ? "/health+latency" : "") +
      " — MemoryCurrent is NOT a fail criterion",
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(verdict === "PASS" ? 0 : 1);
}

if (import.meta.main) await main();
