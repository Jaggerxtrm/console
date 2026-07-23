import { describe, expect, test } from "bun:test";
import { parseConfig, evaluate, probe, parseProcStatus, MAX_PROBE_BODY_BYTES, type GateConfig, type Snapshot } from "./cgroup-health-gate";

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
    service: "console.service",
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
    expect(cfg.service).toBe("console.service");
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

describe("evaluate — malformed/non-finite memory.stat & memory.events fail closed", () => {
  // A NaN/Infinity counter compared with `>` is always false; without an explicit
  // finite guard the gate fails OPEN and a saturated/garbled host would PASS.
  test("NaN memory.stat anon fails closed (not false-PASS)", () => {
    const r = evaluate(baseCfg(), baseSnap({ stat: { anon: NaN } }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/anon unproven/);
  });

  test("Infinity memory.stat anon fails closed", () => {
    const r = evaluate(baseCfg(), baseSnap({ stat: { anon: Infinity } }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/anon unproven/);
  });

  test("NaN memory.events oom fails closed (not false-PASS)", () => {
    const r = evaluate(baseCfg(), baseSnap({ events: { oom: NaN, oom_kill: 0 } }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/memory.events malformed/);
  });

  test("NaN memory.events oom_kill fails closed", () => {
    const r = evaluate(baseCfg(), baseSnap({ events: { oom: 0, oom_kill: NaN } }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/memory.events malformed/);
  });

  test("a real oom still reports the counter, not the malformed branch", () => {
    const r = evaluate(baseCfg(), baseSnap({ events: { oom: 3, oom_kill: 1 } }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/oom=3 oom_kill=1/);
    expect(r.failures.join(" ")).not.toMatch(/malformed/);
  });
});

describe("evaluate — missing stat/events keys fail closed unless proven", () => {
  test("missing oom key cannot prove no-OOM -> FAIL (not default 0)", () => {
    const r = evaluate(baseCfg(), baseSnap({ events: { max: 5 } }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/memory.events missing key/);
  });

  test("missing oom_kill key alone -> FAIL", () => {
    const r = evaluate(baseCfg(), baseSnap({ events: { oom: 0, max: 5 } }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/memory.events missing key/);
  });

  test("missing anon falls back to RssAnon ONLY when procReadable (PASS)", () => {
    // stat has no `anon`; procReadable true, rssAnonKb=100MiB < 512 ceiling.
    const r = evaluate(baseCfg(), baseSnap({ stat: { file: 1 }, procReadable: true, rssAnonKb: 100 * 1024 }));
    expect(r.verdict).toBe("PASS");
  });

  test("missing anon + proc NOT readable -> cannot prove ceiling -> FAIL", () => {
    // No stat.anon and no parsed RssAnon: must fail closed, never default to 0.
    const r = evaluate(baseCfg(), baseSnap({ stat: {}, procReadable: false, rssAnonKb: 0, pid: 99 }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/anon unproven/);
  });

  test("missing anon fallback is real: RssAnon over ceiling -> FAIL", () => {
    // Proves the fallback path is exercised (not a silent 0): 900MiB > 512.
    const r = evaluate(baseCfg(), baseSnap({ stat: {}, procReadable: true, rssAnonKb: 900 * 1024 }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/anon=/);
  });
});

describe("evaluate — systemctl spawn failure shapes fail closed", () => {
  // When `systemctl show` fails/returns empty, sh() yields "" for the states.
  test("empty ActiveState (systemctl failure) fails as unknown", () => {
    const r = evaluate(baseCfg(), baseSnap({ activeState: "" }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/ActiveState=unknown/);
  });

  test("empty SubState (systemctl failure) fails as unknown", () => {
    const r = evaluate(baseCfg(), baseSnap({ subState: "" }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/SubState=unknown/);
  });

  test("empty MainPID raw -> pid null -> MainPID missing failure", () => {
    // mainPid() maps empty/0 to null; evaluate must then fail closed.
    const r = evaluate(baseCfg(), baseSnap({ pid: null, procReadable: false }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures).toContain("MainPID missing");
  });
});

describe("evaluate — optional baseline absence vs mismatch", () => {
  test("absence: no baseline set -> restarts/pid NOT checked, null values PASS", () => {
    const cfg = baseCfg({ expectRestarts: null, expectPid: null });
    const r = evaluate(cfg, baseSnap({ nRestarts: null }));
    expect(r.verdict).toBe("PASS");
    const joined = r.checked.join("|");
    expect(joined).not.toMatch(/NRestarts ==/);
    expect(joined).not.toMatch(/MainPID ==/);
  });

  test("mismatch: expectPid set but MainPID null fails closed", () => {
    const r = evaluate(baseCfg({ expectPid: 4242 }), baseSnap({ pid: null, procReadable: false }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/MainPID=null != expected 4242/);
  });

  test("mismatch: expectRestarts set but unreadable (null) fails closed", () => {
    const r = evaluate(baseCfg({ expectRestarts: 0 }), baseSnap({ nRestarts: null }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/NRestarts unreadable/);
  });

  test("baseline 0 is a real check, not absence", () => {
    const cfg = baseCfg({ expectRestarts: 0 });
    expect(evaluate(cfg, baseSnap({ nRestarts: 0 })).verdict).toBe("PASS");
    expect(evaluate(cfg, baseSnap({ nRestarts: 1 })).verdict).toBe("FAIL");
  });
});

describe("evaluate — endpoint unreachable + latency boundary", () => {
  test("health unreachable (null result) fails when probing", () => {
    const r = evaluate(baseCfg({ probeEndpoints: true }), baseSnap({ endpoints: { health: null } }));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/health != 200 \(got unreachable\)/);
  });

  test("feed unreachable (null) fails when feed configured + probing", () => {
    const cfg = baseCfg({ probeEndpoints: true, feedUrl: "http://x/feed" });
    const snap = baseSnap({ endpoints: { health: { status: 200, seconds: 0.1 }, feed: null } });
    const r = evaluate(cfg, snap);
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/feed != 200 \(got unreachable\)/);
  });

  test("latency exactly at ceiling PASSes (criterion is strictly greater-than)", () => {
    const cfg = baseCfg({ probeEndpoints: true, latencyCeilingS: 1 });
    const snap = baseSnap({ endpoints: { health: { status: 200, seconds: 1 } } });
    expect(evaluate(cfg, snap).verdict).toBe("PASS");
  });

  test("latency just over ceiling FAILs", () => {
    const cfg = baseCfg({ probeEndpoints: true, latencyCeilingS: 1 });
    const snap = baseSnap({ endpoints: { health: { status: 200, seconds: 1.01 } } });
    const r = evaluate(cfg, snap);
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/latency/);
  });

  test("one slow endpoint among several still fails the gate", () => {
    const cfg = baseCfg({ probeEndpoints: true, latencyCeilingS: 1, feedUrl: "http://x/feed" });
    const snap = baseSnap({
      endpoints: { health: { status: 200, seconds: 0.1 }, feed: { status: 200, seconds: 4 } },
    });
    const r = evaluate(cfg, snap);
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/feed latency/);
  });
});

describe("parseProcStatus — missing/malformed required fields yield null, never 0", () => {
  // Red/green seam for the procAnonKb fallback: a readable status file whose
  // RssAnon line is absent or malformed must NOT supply a finite 0 anon fallback.
  const STATUS_OK = [
    "Name:\tbun",
    "Pid:\t4242",
    "VmRSS:\t  204800 kB",
    "RssAnon:\t  102400 kB",
    "RssFile:\t  102400 kB",
  ].join("\n");

  test("present finite RssAnon/VmRSS are parsed", () => {
    const r = parseProcStatus(STATUS_OK);
    expect(r.rssAnonKb).toBe(102400);
    expect(r.vmRssKb).toBe(204800);
  });

  test("absent RssAnon -> null (not default 0)", () => {
    const noAnon = STATUS_OK.split("\n").filter((l) => !l.startsWith("RssAnon:")).join("\n");
    const r = parseProcStatus(noAnon);
    expect(r.rssAnonKb).toBeNull();
    expect(r.vmRssKb).toBe(204800); // sibling field still parses
  });

  test("malformed RssAnon (no kB / garbage) -> null", () => {
    expect(parseProcStatus("RssAnon:\tNaN kB").rssAnonKb).toBeNull();
    expect(parseProcStatus("RssAnon:\t12345").rssAnonKb).toBeNull(); // missing ' kB'
    expect(parseProcStatus("RssAnon: garbage").rssAnonKb).toBeNull();
  });

  test("absent VmRSS -> null", () => {
    const noVm = STATUS_OK.split("\n").filter((l) => !l.startsWith("VmRSS:")).join("\n");
    expect(parseProcStatus(noVm).vmRssKb).toBeNull();
  });

  test("empty status text -> both null", () => {
    const r = parseProcStatus("");
    expect(r.rssAnonKb).toBeNull();
    expect(r.vmRssKb).toBeNull();
  });
});

describe("evaluate — anon fallback requires a genuinely parsed RssAnon (red/green)", () => {
  // Before the fix, procAnonKb returned rssAnonKb=0 + readable=true whenever the
  // status file was read, so a missing RssAnon still produced a finite 0 fallback
  // and the gate false-PASSed. Now rssAnonKb=null -> anon unproven -> FAIL.
  test("readable status but RssAnon absent (null) + no stat.anon -> FAIL, not false-PASS", () => {
    const snap = baseSnap({ stat: { file: 1 }, procReadable: true, rssAnonKb: null, pid: 4242 });
    const r = evaluate(baseCfg(), snap);
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/anon unproven/);
  });

  test("readable status with malformed RssAnon (null) cannot prove ceiling -> FAIL", () => {
    const snap = baseSnap({ stat: {}, procReadable: true, rssAnonKb: null, vmRssKb: null, pid: 4242 });
    const r = evaluate(baseCfg(), snap);
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/anon unproven/);
  });

  test("readable status with genuine finite RssAnon + no stat.anon -> fallback PASS", () => {
    const snap = baseSnap({ stat: { file: 1 }, procReadable: true, rssAnonKb: 100 * 1024 });
    expect(evaluate(baseCfg(), snap).verdict).toBe("PASS");
  });

  test("stat.anon present + finite wins even when RssAnon null", () => {
    const snap = baseSnap({ stat: { anon: 100 * 1024 * 1024 }, procReadable: true, rssAnonKb: null });
    expect(evaluate(baseCfg(), snap).verdict).toBe("PASS");
  });
});

describe("probe — response-body bound + cancellation (hermetic, injected fetch)", () => {
  function countingStream(totalBytes: number, chunk = 65536) {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= totalBytes) {
          controller.close();
          return;
        }
        const n = Math.min(chunk, totalBytes - pulled);
        pulled += n;
        controller.enqueue(new Uint8Array(n));
      },
    });
    return { stream, getPulled: () => pulled };
  }

  test("huge body is drained only up to the bound, never fully buffered", async () => {
    const total = 8 * 1024 * 1024; // 8 MiB body, far over the 1 MiB cap
    const { stream, getPulled } = countingStream(total);
    const fetchImpl = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    const r = await probe("http://stub/big", { fetchImpl });
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
    // Bounded: stopped at/just past the cap, did NOT pull the whole 8 MiB.
    expect(getPulled()).toBeLessThanOrEqual(MAX_PROBE_BODY_BYTES + 65536);
    expect(getPulled()).toBeLessThan(total);
  });

  test("oversized body: reader.cancel() is invoked after the cap (stream released, not left open)", async () => {
    // Red/green for the `await reader.cancel()` on the bounded-drain path: without
    // it the oversized upstream stream is never released (resource/socket leak)
    // even though probe() stops reading at the cap. Deleting that line leaves
    // every other probe test green, so assert the cancel callback directly.
    let cancelCalled = false;
    let pulled = 0;
    const total = 4 * 1024 * 1024; // 4 MiB, over the 1 MiB cap
    const chunk = 65536;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= total) {
          controller.close();
          return;
        }
        const n = Math.min(chunk, total - pulled);
        pulled += n;
        controller.enqueue(new Uint8Array(n));
      },
      cancel() {
        cancelCalled = true;
      },
    });
    const fetchImpl = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    const r = await probe("http://stub/big", { fetchImpl });
    expect(r!.status).toBe(200);
    expect(pulled).toBeLessThan(total); // bounded drain, not fully buffered
    expect(cancelCalled).toBe(true); // stream cancelled after the cap
  });

  test("small body fully drained; status + latency captured", async () => {
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const r = await probe("http://stub/health", { fetchImpl });
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
    expect(r!.seconds).toBeGreaterThanOrEqual(0);
  });

  test("non-200 status is reported, not thrown", async () => {
    const fetchImpl = (async () => new Response("err", { status: 503 })) as unknown as typeof fetch;
    const r = await probe("http://stub/health", { fetchImpl });
    expect(r!.status).toBe(503);
  });

  test("hung endpoint is cancelled by the timeout -> null, returns promptly", async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason ?? new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(signal?.reason ?? new Error("aborted")));
        // otherwise never resolves: simulates a hung upstream
      });
    }) as unknown as typeof fetch;
    const t0 = performance.now();
    const r = await probe("http://stub/hang", { timeoutMs: 50, fetchImpl });
    const elapsed = performance.now() - t0;
    expect(r).toBeNull();
    expect(elapsed).toBeLessThan(5000); // aborted by timeout, not left hanging
  });

  test("fetch rejection -> null (unreachable)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await probe("http://stub/down", { fetchImpl });
    expect(r).toBeNull();
  });
});
