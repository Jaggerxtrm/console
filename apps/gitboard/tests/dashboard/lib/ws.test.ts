import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WsClient, buildWsUrl } from "../../../src/dashboard/lib/ws.ts";

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
    expect(msg).toEqual({ type: "subscribe", channel: "github:activity", version: "1" });
  });

  it("re-subscribes on reconnect", () => {
    const client = new WsClient("ws://localhost/ws");
    client.connect();
    client.subscribe("github:activity");
    mockWs.triggerOpen();
    expect(mockWs.sent.some((s) => s.includes("github:activity"))).toBe(true);
  });

  it("keeps last seen seq after unsubscribe so remount can resume", () => {
    const client = new WsClient("ws://localhost/ws");
    client.connect();
    client.subscribe("github:activity");
    mockWs.triggerOpen();
    mockWs.triggerMessage({ type: "event", channel: "github:activity", event: "new_event", seq: 7, data: {}, version: "1", boot_id: "boot-1" });

    client.unsubscribe("github:activity");
    client.subscribe("github:activity");

    vi.useFakeTimers();
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
