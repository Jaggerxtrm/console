import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WsClient, buildWsUrl, UNSUBSCRIBE_GRACE_MS } from "../../../src/dashboard/lib/ws.ts";

class MockWs {
  readyState = 1; // OPEN
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }

  triggerOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  triggerMessage(data: object): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

let mockWs: MockWs;
let wsFactory: ReturnType<typeof vi.fn>;
const OriginalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  mockWs = new MockWs();
  wsFactory = vi.fn(() => mockWs);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = wsFactory;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket.OPEN = 1;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket.CLOSED = 3;
});

afterEach(() => {
  vi.useRealTimers();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = OriginalWebSocket;
});

describe("WsClient.connect", () => {
  it("opens a WebSocket connection", () => {
    const client = new WsClient("ws://localhost/ws");
    client.connect();
    expect(globalThis.WebSocket).toHaveBeenCalledWith("ws://localhost/ws");
  });

  it("does not open twice if already connected", () => {
    const client = new WsClient("ws://localhost/ws");
    client.connect();
    client.connect();
    expect(globalThis.WebSocket).toHaveBeenCalledTimes(1);
  });
});

describe("WsClient.subscribe", () => {
  it("sends subscribe message when open", () => {
    const client = new WsClient("ws://localhost/ws");
    client.connect();
    mockWs.triggerOpen();
    client.subscribe("github:activity");
    const msg = JSON.parse(mockWs.sent[mockWs.sent.length - 1]);
    expect(msg).toEqual({ action: "subscribe", channel: "github:activity", version: "1" });
  });

  it("keeps one server subscription alive until last local handler unmounts", () => {
    vi.useFakeTimers();
    const client = new WsClient("ws://localhost/ws");
    client.connect();
    mockWs.triggerOpen();

    client.subscribe("github:activity");
    client.subscribe("github:activity");

    const firstReceived: unknown[] = [];
    const secondReceived: unknown[] = [];
    const unsubFirst = client.onMessage((msg) => {
      if (msg.channel === "github:activity") firstReceived.push(msg);
    });
    const unsubSecond = client.onMessage((msg) => {
      if (msg.channel === "github:activity") secondReceived.push(msg);
    });

    expect(mockWs.sent.map((entry) => JSON.parse(entry)).filter((msg) => msg.action === "subscribe")).toHaveLength(1);

    mockWs.triggerMessage({ type: "event", channel: "github:activity", event: "new_event", data: { id: "e1" } });
    expect(firstReceived).toHaveLength(1);
    expect(secondReceived).toHaveLength(1);

    unsubFirst();
    client.unsubscribe("github:activity");

    expect(mockWs.sent.map((entry) => JSON.parse(entry)).some((msg) => msg.action === "unsubscribe")).toBe(false);

    mockWs.triggerMessage({ type: "event", channel: "github:activity", event: "new_event", data: { id: "e2" } });
    expect(firstReceived).toHaveLength(1);
    expect(secondReceived).toHaveLength(2);

    unsubSecond();
    client.unsubscribe("github:activity");

    expect(mockWs.sent.map((entry) => JSON.parse(entry)).some((msg) => msg.action === "unsubscribe")).toBe(false);
    vi.advanceTimersByTime(UNSUBSCRIBE_GRACE_MS);
    expect(mockWs.sent.map((entry) => JSON.parse(entry)).filter((msg) => msg.action === "unsubscribe")).toEqual([
      { action: "unsubscribe", channel: "github:activity" },
    ]);
  });

  it("schedules unsubscribe after the grace timeout", () => {
    vi.useFakeTimers();
    const client = new WsClient("ws://localhost/ws");
    client.connect();
    mockWs.triggerOpen();

    client.subscribe("github:activity");
    client.unsubscribe("github:activity");

    expect(mockWs.sent.map((entry) => JSON.parse(entry)).some((msg) => msg.action === "unsubscribe")).toBe(false);
    vi.advanceTimersByTime(UNSUBSCRIBE_GRACE_MS - 1);
    expect(mockWs.sent.map((entry) => JSON.parse(entry)).some((msg) => msg.action === "unsubscribe")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(mockWs.sent.map((entry) => JSON.parse(entry)).filter((msg) => msg.action === "unsubscribe")).toEqual([
      { action: "unsubscribe", channel: "github:activity" },
    ]);
  });

  it("cancels pending unsubscribe on resubscribe within grace", () => {
    vi.useFakeTimers();
    const client = new WsClient("ws://localhost/ws");
    client.connect();
    mockWs.triggerOpen();

    client.subscribe("github:activity");
    client.unsubscribe("github:activity");
    client.subscribe("github:activity");
    vi.advanceTimersByTime(UNSUBSCRIBE_GRACE_MS);

    const actions = mockWs.sent.map((entry) => JSON.parse(entry)).filter((msg) => msg.channel === "github:activity");
    expect(actions.filter((msg) => msg.action === "subscribe")).toHaveLength(1);
    expect(actions.some((msg) => msg.action === "unsubscribe")).toBe(false);
  });

  it("does not replay zero-ref grace subscriptions on reconnect", () => {
    vi.useFakeTimers();
    const firstSocket = mockWs;
    const client = new WsClient("ws://localhost/ws");
    client.connect();
    client.subscribe("github:activity");
    firstSocket.triggerOpen();

    client.unsubscribe("github:activity");
    const secondSocket = new MockWs();
    wsFactory.mockImplementation(() => secondSocket);
    firstSocket.close();
    vi.advanceTimersByTime(1000);
    secondSocket.triggerOpen();

    expect(secondSocket.sent.map((entry) => JSON.parse(entry)).some((msg) => msg.channel === "github:activity")).toBe(false);
    vi.advanceTimersByTime(UNSUBSCRIBE_GRACE_MS);
    expect(secondSocket.sent.map((entry) => JSON.parse(entry))).toEqual([
      { action: "unsubscribe", channel: "github:activity" },
    ]);
  });

  it("re-subscribes on reconnect", () => {
    const client = new WsClient("ws://localhost/ws");
    client.connect();
    client.subscribe("github:activity");
    mockWs.triggerOpen();
    expect(mockWs.sent.some((s) => s.includes("github:activity"))).toBe(true);
  });

  it("keeps last seen seq after unsubscribe so remount can resume", () => {
    vi.useFakeTimers();
    const client = new WsClient("ws://localhost/ws");
    client.connect();
    client.subscribe("github:activity");
    mockWs.triggerOpen();
    mockWs.triggerMessage({ type: "event", channel: "github:activity", event: "new_event", seq: 7, data: {}, version: "1", boot_id: "boot-1" });

    client.unsubscribe("github:activity");
    client.subscribe("github:activity");

    const nextSocket = new MockWs();
    wsFactory.mockImplementation(() => nextSocket);
    mockWs.close();
    vi.runAllTimers();
    nextSocket.triggerOpen();

    const resumeMsg = nextSocket.sent.map((entry) => JSON.parse(entry)).find((msg) => msg.action === "resume");
    expect(resumeMsg).toEqual({ action: "resume", channel: "github:activity", since_seq: 7, boot_id: "boot-1", version: "1" });
    vi.useRealTimers();
  });

  it("reconnect sends resume payload with last seen since_seq + boot_id", () => {
    vi.useFakeTimers();
    const firstSocket = mockWs;
    const client = new WsClient("ws://localhost/ws");
    client.connect();
    client.subscribe("github:activity");
    firstSocket.triggerOpen();
    firstSocket.triggerMessage({ type: "event", channel: "github:activity", event: "new_event", seq: 7, data: {}, version: "1", boot_id: "boot-1" });

    const secondSocket = new MockWs();
    wsFactory.mockImplementation(() => secondSocket);
    firstSocket.close();
    vi.runAllTimers();
    secondSocket.triggerOpen();

    const resumeMsg = secondSocket.sent.map((entry) => JSON.parse(entry)).find((msg) => msg.action === "resume");
    expect(resumeMsg).toEqual({ action: "resume", channel: "github:activity", since_seq: 7, boot_id: "boot-1", version: "1" });
    vi.useRealTimers();
  });
});

describe("WsClient.onMessage", () => {
  it("calls handler when message arrives", () => {
    const client = new WsClient("ws://localhost/ws");
    client.connect();

    const received: unknown[] = [];
    client.onMessage((msg) => received.push(msg));

    mockWs.triggerMessage({ type: "event", channel: "github:activity", event: "new_event", seq: 1, data: {}, version: "1", boot_id: "boot-1" });
    expect(received).toHaveLength(1);
  });

  it("returns unsubscribe function that removes handler", () => {
    const client = new WsClient("ws://localhost/ws");
    client.connect();

    const received: unknown[] = [];
    const unsub = client.onMessage((msg) => received.push(msg));
    unsub();

    mockWs.triggerMessage({ type: "event", channel: "test", data: {} });
    expect(received).toHaveLength(0);
  });
});

describe("WsClient.disconnect", () => {
  it("closes the connection", () => {
    const client = new WsClient("ws://localhost/ws");
    client.connect();
    client.disconnect();
    expect(mockWs.readyState).toBe(3);
  });
});

describe("buildWsUrl", () => {
  it("converts http to ws", () => {
    const url = buildWsUrl("http://localhost:3000");
    expect(url).toBe("ws://localhost:3000/ws");
  });

  it("converts https to wss", () => {
    const url = buildWsUrl("https://example.com");
    expect(url).toBe("wss://example.com/ws");
  });
});
