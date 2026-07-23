import { describe, expect, it, vi } from "vitest";
import { createGithubRuntime } from "../../src/server/github/runtime.ts";
import { createHostLogger } from "../../src/server/log.ts";

function fixture(env: NodeJS.ProcessEnv = {}) {
  const events: string[] = [];
  const poller = {
    start: vi.fn(() => { events.push("poller.start"); }),
    stop: vi.fn(() => { events.push("poller.stop"); }),
    backfill: vi.fn(async () => { events.push("poller.backfill"); }),
  };
  const logger = createHostLogger({ sink: (line) => events.push(JSON.parse(line).event), diskEnabled: false });
  const runtime = createGithubRuntime({
    db: {} as never,
    env,
    logger,
    getToken: () => "secret-token",
    getUsername: async () => { events.push("github.authenticated"); return "alice"; },
    discover: async () => { events.push("github.discovered"); return { discovered: 1, inserted: 1 } as never; },
    createPoller: () => poller,
  });
  return { runtime, poller, events };
}

describe("Console GitHub background runtime", () => {
  it("starts discovery and polling once, then stops idempotently", async () => {
    const { runtime, poller, events } = fixture();

    await runtime.start();
    await runtime.start();
    await runtime.stop();
    await runtime.stop();

    expect(events).toEqual(expect.arrayContaining([
      "github.authenticated",
      "github.discovered",
      "poller.start",
      "github.poller_started",
      "poller.stop",
      "github.poller_stopped",
    ]));
    expect(poller.start).toHaveBeenCalledTimes(1);
    expect(poller.stop).toHaveBeenCalledTimes(1);
  });

  it("runs the optional startup backfill before polling", async () => {
    const { runtime, events } = fixture({ GITBOARD_STARTUP_BACKFILL: "1" });
    await runtime.start();

    expect(events).toEqual(expect.arrayContaining(["poller.backfill", "poller.start"]));
  });

  it("honors the poller disable gate without touching credentials", async () => {
    const getToken = vi.fn(() => "secret-token");
    const logger = createHostLogger({ sink: () => {}, diskEnabled: false });
    const runtime = createGithubRuntime({ db: {} as never, env: { SKIP_GITHUB_POLLER: "1" }, logger, getToken });

    await runtime.start();

    expect(getToken).not.toHaveBeenCalled();
    expect(runtime.status()).toEqual({ state: "disabled", reason: "configured_off" });
  });

  it("keeps the host readable when authentication fails and redacts credentials", async () => {
    const lines: string[] = [];
    const logger = createHostLogger({ sink: (line) => lines.push(line), diskEnabled: false });
    const runtime = createGithubRuntime({
      db: {} as never,
      env: {},
      logger,
      getToken: () => "must-not-appear",
      getUsername: async () => { throw new Error("authentication unavailable"); },
    });

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(runtime.status()).toEqual({ state: "degraded", reason: "authentication unavailable" });
    expect(lines.join("\n")).not.toContain("must-not-appear");
  });

  it("does not start a poller after shutdown wins an authentication race", async () => {
    let resolveUsername!: (value: string) => void;
    const username = new Promise<string>((resolve) => { resolveUsername = resolve; });
    const createPoller = vi.fn();
    const runtime = createGithubRuntime({
      db: {} as never,
      env: {},
      logger: createHostLogger({ sink: () => {}, diskEnabled: false }),
      getToken: () => "token",
      getUsername: () => username,
      discover: vi.fn(async () => []),
      createPoller,
    });

    const starting = runtime.start();
    await runtime.stop();
    resolveUsername("alice");
    await starting;

    expect(createPoller).not.toHaveBeenCalled();
  });
});
