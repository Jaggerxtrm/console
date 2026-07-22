import { describe, expect, test } from "bun:test";
import { parseConfig, evaluate, type GateConfig, type Snapshot } from "./cgroup-health-gate";

function baseSnap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    current: 500_000_000,
    max: 2_000_000_000,
    stat: { anon: 100 * 1024 * 1024, file: 300 * 1024 * 1024 },
    events: { oom: 0, oom_kill: 0, max: 10 },
    pid: 4242,
    procReadable: true,
    rssAnonKb: 100 * 1024,
    vmRssKb: 200 * 1024,
    nRestarts: 0,
    activeState: "active",
    subState: "running",
    endpoints: {},
    ...over,
  };
}

function baseCfg(over: Partial<GateConfig> = {}): GateConfig {
  return {
    service: "gitboard.service",
    anonCeilingMb: 512,
    latencyCeilingS: 5,
    healthUrl: "http://localhost:3030/health",
    feedUrl: null,
    probeEndpoints: false,
    expectRestarts: null,
    expectPid: null,
    ...over,
  };
}

describe("parseConfig — fail closed on invalid numeric env", () => {
  test("defaults: localhost health, no hardcoded feed", () => {
    const cfg = parseConfig({});
    expect(cfg.healthUrl).toBe("http://localhost:3030/health");
    expect(cfg.feedUrl).toBeNull();
    expect(cfg.anonCeilingMb).toBe(512);
    expect(cfg.expectRestarts).toBeNull();
    expect(cfg.expectPid).toBeNull();
  });

  test("NaN / non-finite anon ceiling throws", () => {
    expect(() => parseConfig({ GATE_ANON_CEILING_MB: "abc" })).toThrow(/not a finite number/);
    expect(() => parseConfig({ GATE_ANON_CEILING_MB: "NaN" })).toThrow();
    expect(() => parseConfig({ GATE_ANON_CEILING_MB: "" })).toThrow();
  });

  test("non-positive ceiling throws", () => {
    expect(() => parseConfig({ GATE_ANON_CEILING_MB: "0" })).toThrow(/> 0/);
    expect(() => parseConfig({ GATE_LATENCY_CEILING_S: "-1" })).toThrow(/> 0/);
  });

  test("garbage baseline throws; valid baseline parses", () => {
    expect(() => parseConfig({ GATE_EXPECT_RESTARTS: "x" })).toThrow(/non-negative integer/);
    expect(() => parseConfig({ GATE_EXPECT_PID: "1.5" })).toThrow();
    const cfg = parseConfig({ GATE_EXPECT_RESTARTS: "0", GATE_EXPECT_PID: "4242" });
    expect(cfg.expectRestarts).toBe(0);
    expect(cfg.expectPid).toBe(4242);
  });

  test("blank feed url is treated as unset", () => {
    expect(parseConfig({ GATE_FEED_URL: "   " }).feedUrl).toBeNull();
    expect(parseConfig({ GATE_FEED_URL: "http://x/feed" }).feedUrl).toBe("http://x/feed");
  });
});

describe("evaluate — fail-closed criteria", () => {
  test("healthy snapshot PASSes", () => {
    const r = evaluate(baseCfg(), baseSnap());
    expect(r.verdict).toBe("PASS");
    expect(r.failures).toEqual([]);
  });

  test("OOM fails", () => {
    const r = evaluate(baseCfg(), baseSnap({ events: { oom: 1, oom_kill: 0 } }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/oom=1/);
  });

  test("anon over ceiling fails", () => {
    const r = evaluate(baseCfg({ anonCeilingMb: 64 }), baseSnap({ stat: { anon: 100 * 1024 * 1024 } }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/anon=/);
  });

  test("missing MainPID fails", () => {
    const r = evaluate(baseCfg(), baseSnap({ pid: null, procReadable: false }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures).toContain("MainPID missing");
  });

  test("unreadable /proc/<pid>/status fails", () => {
    const r = evaluate(baseCfg(), baseSnap({ pid: 99, procReadable: false }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/status unreadable/);
  });

  test("inactive ActiveState fails", () => {
    const r = evaluate(baseCfg(), baseSnap({ activeState: "inactive" }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/ActiveState=inactive/);
  });

  test("non-running SubState fails even when active", () => {
    const r = evaluate(baseCfg(), baseSnap({ activeState: "active", subState: "exited" }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/SubState=exited/);
  });

  test("restart baseline mismatch fails; match passes", () => {
    const cfg = baseCfg({ expectRestarts: 0 });
    expect(evaluate(cfg, baseSnap({ nRestarts: 2 })).verdict).toBe("FAIL");
    expect(evaluate(cfg, baseSnap({ nRestarts: 0 })).verdict).toBe("PASS");
    // Unreadable restarts with a baseline set fails closed.
    expect(evaluate(cfg, baseSnap({ nRestarts: null })).verdict).toBe("FAIL");
  });

  test("pid baseline mismatch fails; match passes", () => {
    const cfg = baseCfg({ expectPid: 4242 });
    expect(evaluate(cfg, baseSnap({ pid: 5150 })).verdict).toBe("FAIL");
    expect(evaluate(cfg, baseSnap({ pid: 4242 })).verdict).toBe("PASS");
  });

  test("feed non-200 fails only when feed configured + endpoints probed", () => {
    const probing = baseCfg({ probeEndpoints: true, feedUrl: "http://x/feed" });
    const feedDown = baseSnap({ endpoints: { health: { status: 200, seconds: 0.1 }, feed: { status: 500, seconds: 0.1 } } });
    expect(evaluate(probing, feedDown).verdict).toBe("FAIL");
    // No feed configured -> feed not checked, health 200 passes.
    const noFeed = baseCfg({ probeEndpoints: true, feedUrl: null });
    const healthOnly = baseSnap({ endpoints: { health: { status: 200, seconds: 0.1 } } });
    expect(evaluate(noFeed, healthOnly).verdict).toBe("PASS");
  });

  test("health != 200 fails when probing", () => {
    const cfg = baseCfg({ probeEndpoints: true });
    const snap = baseSnap({ endpoints: { health: { status: 503, seconds: 0.1 } } });
    expect(evaluate(cfg, snap).verdict).toBe("FAIL");
  });

  test("latency over ceiling fails when probing", () => {
    const cfg = baseCfg({ probeEndpoints: true, latencyCeilingS: 1 });
    const snap = baseSnap({ endpoints: { health: { status: 200, seconds: 3 } } });
    const r = evaluate(cfg, snap);
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/latency/);
  });

  test("checked list states exactly what was evaluated", () => {
    const cfg = baseCfg({ expectRestarts: 0, expectPid: 4242, probeEndpoints: true, feedUrl: "http://x/feed" });
    const r = evaluate(cfg, baseSnap({ endpoints: { health: { status: 200, seconds: 0.1 }, feed: { status: 200, seconds: 0.1 } } }));
    const joined = r.checked.join("|");
    expect(joined).toMatch(/oom==0/);
    expect(joined).toMatch(/anon <= 512MiB/);
    expect(joined).toMatch(/MainPID present/);
    expect(joined).toMatch(/SubState == "running"/);
    expect(joined).toMatch(/NRestarts == 0/);
    expect(joined).toMatch(/MainPID == 4242/);
    expect(joined).toMatch(/health == 200/);
    expect(joined).toMatch(/feed == 200/);
  });
});
