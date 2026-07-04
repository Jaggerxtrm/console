import { afterAll, expect, mock, test } from "bun:test";
import { existsSync, utimesSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RealtimeChannelRegistry, RealtimeConnectionHandler } from "../../../../packages/core/src/runtime/index.ts";

type RouteHandler = (context: {
  req: {
    url: string;
    header(name: string): string | undefined;
    query(name: string): string | undefined;
    json(): Promise<unknown>;
    path: string;
  };
  json(body: unknown, status?: number): Response;
}) => Response | Promise<Response>;

class FakeHono {
  routes: Array<{ method: string; path: string; handler: RouteHandler }> = [];

  get(path: string, handler: RouteHandler): this {
    this.routes.push({ method: "GET", path, handler });
    return this;
  }

  post(path: string, handler: RouteHandler): this {
    this.routes.push({ method: "POST", path, handler });
    return this;
  }

  route(prefix: string, child: FakeHono): this {
    for (const route of child.routes) {
      this.routes.push({
        method: route.method,
        path: `${prefix}${route.path}`.replace(/\/+/g, "/"),
        handler: route.handler,
      });
    }
    return this;
  }

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const request = new Request(url, init);
    const pathname = new URL(url).pathname;
    const route = this.routes.find((candidate) => candidate.method === request.method.toUpperCase() && candidate.path === pathname);
    if (!route) return new Response("not found", { status: 404 });

    return await route.handler({
      req: {
        url: request.url,
        header: (name: string) => request.headers.get(name) ?? undefined,
        query: (name: string) => new URL(request.url).searchParams.get(name) ?? undefined,
        json: async () => await request.json(),
        path: pathname,
      },
      json: (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    });
  }
}

mock.module("hono", () => ({ Hono: FakeHono }));

const tmpRoot = join(process.cwd(), "apps/gitboard/tests/smoke/.tmp-ws-logs-parity");

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

test("apps/gitboard websocket and internal log wrappers keep daemon/core parity", async () => {
  const home = join(tmpRoot, "home");
  const logDir = join(home, ".xtrm", "logs");
  const oldFile = join(logDir, "2026-05-01.jsonl");
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(logDir, { recursive: true });
  await writeFile(oldFile, "{}\n");
  utimesSync(oldFile, new Date("2026-05-01T00:00:00.000Z"), new Date("2026-05-01T00:00:00.000Z"));

  process.env.HOME = home;
  process.env.LOG_DIR = "";
  process.env.GITBOARD_LOG_DIR = "";
  process.env.LOG_RETENTION_DAYS = "7";

  const [{ ChannelRegistry }, { WsHandler, REALTIME_PROTOCOL_VERSION }, logger, routes] = await Promise.all([
    import("../../src/api/ws/channels.ts"),
    import("../../src/api/ws/handler.ts"),
    import("../../src/core/logger.ts"),
    import("../../src/api/routes/internal-logs.ts"),
  ]);

  const registry = new ChannelRegistry();
  const handler = new WsHandler(registry);
  expect(registry).toBeInstanceOf(RealtimeChannelRegistry);
  expect(handler).toBeInstanceOf(RealtimeConnectionHandler);

  logger.setRealtimePublisher(registry);
  logger.setDiskEnabled(true);
  logger.setLogLevel("info");

  const raw = {
    sent: [] as string[],
    send(data: string) {
      this.sent.push(data);
    },
    close(code?: number) {
      throw new Error(`unexpected close ${code ?? ""}`.trim());
    },
  };

  const connectionId = handler.connect(raw);
  handler.handleMessage(connectionId, JSON.stringify({ action: "subscribe", channel: "system", version: String(REALTIME_PROTOCOL_VERSION) }));
  logger.emit({ ts: "2026-05-19T00:00:00.000Z", level: "info", component: "system", event: "smoke.direct" });

  expect(raw.sent).toHaveLength(1);
  expect(JSON.parse(raw.sent[0])).toMatchObject({
    channel: "system",
    event: "system:log",
    version: "2026-05-19T00:00:00.000Z",
    data: { event: "smoke.direct" },
  });

  handler.handleMessage(connectionId, JSON.stringify({ action: "unsubscribe", channel: "system" }));
  logger.emit({ ts: "2026-05-19T00:00:01.000Z", level: "info", component: "system", event: "smoke.after-unsub" });
  expect(raw.sent).toHaveLength(1);

  handler.handleMessage(connectionId, JSON.stringify({ action: "subscribe", channel: "system", version: String(REALTIME_PROTOCOL_VERSION) }));
  const app = new FakeHono().route("/api/internal", routes.createInternalLogsRouter() as unknown as FakeHono);

  const post = await app.request("http://localhost:3000/api/internal/logs/client", {
    method: "POST",
    headers: {
      host: "localhost:3000",
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify({ event: "ui.smoke", data: { pane: "logs" } }),
  });

  expect(post.status).toBe(200);
  expect(raw.sent).toHaveLength(2);
  expect(JSON.parse(raw.sent[1])).toMatchObject({
    channel: "system",
    event: "system:log",
    data: {
      component: "drawer",
      event: "ui.smoke",
      data: { pane: "logs", source: "dashboard-client" },
    },
  });

  const logs = await app.request("http://localhost:3000/api/internal/logs?component=drawer&event=ui.smoke&limit=1", {
    headers: { host: "localhost:3000" },
  });

  expect(logs.status).toBe(200);
  await expect(logs.json()).resolves.toEqual([
    expect.objectContaining({
      component: "drawer",
      event: "ui.smoke",
      data: expect.objectContaining({ source: "dashboard-client" }),
    }),
  ]);

  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(existsSync(join(logDir, "2026-05-19.jsonl"))).toBe(true);
  expect(existsSync(oldFile)).toBe(false);

  handler.disconnect(connectionId);
  expect(handler.connectionCount()).toBe(0);
  expect(registry.subscriberCount("system")).toBe(0);
});
