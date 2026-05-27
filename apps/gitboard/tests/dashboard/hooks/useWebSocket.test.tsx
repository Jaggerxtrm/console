/** @vitest-environment happy-dom */

import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Cleanup = () => void;
type EffectEntry = { deps?: readonly unknown[]; cleanup?: Cleanup };
type ComponentFn = () => null;

type RootState = {
  refs: Array<{ current: unknown }>;
  effects: EffectEntry[];
  effectCursor: number;
  refCursor: number;
  pendingEffects: Array<() => Cleanup | void>;
};

let activeRoot: RootState | null = null;

function sameDeps(left?: readonly unknown[], right?: readonly unknown[]): boolean {
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
}

vi.mock("react", () => ({
  useRef: <T,>(initial: T) => {
    if (!activeRoot) throw new Error("no active root");
    const slot = activeRoot.refCursor++;
    if (!activeRoot.refs[slot]) activeRoot.refs[slot] = { current: initial };
    return activeRoot.refs[slot] as { current: T };
  },
  useEffect: (effect: () => void | Cleanup, deps?: readonly unknown[]) => {
    if (!activeRoot) throw new Error("no active root");
    const slot = activeRoot.effectCursor++;
    const root = activeRoot;
    const entry = root.effects[slot];
    if (entry && sameDeps(entry.deps, deps)) return;
    if (entry?.cleanup) entry.cleanup();
    root.pendingEffects.push(() => {
      const cleanup = effect();
      root.effects[slot] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
      return cleanup;
    });
  },
}));

vi.mock("react-dom/client", () => ({
  createRoot: () => {
    const state: RootState = { refs: [], effects: [], effectCursor: 0, refCursor: 0, pendingEffects: [] };
    return {
      render: (next: null | ComponentFn) => {
        if (!next) {
          for (const entry of state.effects) entry.cleanup?.();
          state.effects = [];
          state.refs = [];
          return;
        }

        state.effectCursor = 0;
        state.refCursor = 0;
        state.pendingEffects = [];
        activeRoot = state;
        next();
        activeRoot = null;
        for (const runEffect of state.pendingEffects) runEffect();
      },
      unmount: () => {
        for (const entry of state.effects) entry.cleanup?.();
        state.effects = [];
        state.refs = [];
      },
    };
  },
}));

import { createRoot } from "react-dom/client";
import { _resetSharedClient, useWebSocket } from "../../../src/dashboard/hooks/useWebSocket.ts";
import { UNSUBSCRIBE_GRACE_MS } from "../../../src/dashboard/lib/ws.ts";

class MockWs {
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  triggerOpen(): void { this.readyState = 1; this.onopen?.(); }
  triggerMessage(data: object): void { this.onmessage?.({ data: JSON.stringify(data) }); }
}

let mockWs: MockWs;
let wsFactory: ReturnType<typeof vi.fn>;
let originalWindow: typeof globalThis.window | undefined;
let originalDocument: Document | undefined;
let windowStub: Window;
type TestRoot = {
  render: (next: null | ComponentFn) => void;
  unmount: () => void;
};
let firstRoot: TestRoot;
let secondRoot: TestRoot;
let firstContainer: HTMLDivElement;
let secondContainer: HTMLDivElement;
const OriginalWebSocket = globalThis.WebSocket;

function Probe({ handler }: { handler: (msg: { type?: string; channel?: string; event?: string; data?: unknown }) => void }): null {
  useWebSocket("github:activity", handler);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetSharedClient();
  originalWindow = globalThis.window;
  originalDocument = globalThis.document;
  windowStub = new Window({ url: "http://localhost/" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = windowStub as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).document = windowStub.document as any;

  mockWs = new MockWs();
  wsFactory = vi.fn(() => mockWs);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = wsFactory;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket.OPEN = 1;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket.CLOSED = 3;

  firstContainer = document.createElement("div");
  secondContainer = document.createElement("div");
  document.body.append(firstContainer, secondContainer);
  firstRoot = createRoot(firstContainer) as unknown as TestRoot;
  secondRoot = createRoot(secondContainer) as unknown as TestRoot;
});

afterEach(() => {
  firstRoot.unmount();
  secondRoot.unmount();
  firstContainer.remove();
  secondContainer.remove();
  _resetSharedClient();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = OriginalWebSocket;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = originalWindow;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).document = originalDocument;
  vi.useRealTimers();
});

describe("useWebSocket", () => {
  it("keeps shared subscription alive until last local consumer unmounts", () => {
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();

    firstRoot.render(() => Probe({ handler: firstHandler }));
    secondRoot.render(() => Probe({ handler: secondHandler }));

    mockWs.triggerOpen();
    expect(mockWs.sent.map((entry) => JSON.parse(entry)).filter((msg) => msg.action === "subscribe")).toHaveLength(1);

    firstRoot.render(null);
    expect(mockWs.sent.map((entry) => JSON.parse(entry)).some((msg) => msg.action === "unsubscribe")).toBe(false);

    mockWs.triggerMessage({ type: "event", channel: "github:activity", event: "new_event", data: { id: "e1" } });
    expect(firstHandler).toHaveBeenCalledTimes(0);
    expect(secondHandler).toHaveBeenCalledTimes(1);

    secondRoot.render(null);
    expect(mockWs.sent.map((entry) => JSON.parse(entry)).some((msg) => msg.action === "unsubscribe")).toBe(false);
    vi.advanceTimersByTime(UNSUBSCRIBE_GRACE_MS);
    expect(mockWs.sent.map((entry) => JSON.parse(entry)).filter((msg) => msg.action === "unsubscribe")).toEqual([
      { action: "unsubscribe", channel: "github:activity" },
    ]);
  });

  it("does not churn server subscription during rapid remount navigation", () => {
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();

    firstRoot.render(() => Probe({ handler: firstHandler }));
    mockWs.triggerOpen();
    firstRoot.render(null);
    secondRoot.render(() => Probe({ handler: secondHandler }));
    vi.advanceTimersByTime(UNSUBSCRIBE_GRACE_MS);

    const messages = mockWs.sent.map((entry) => JSON.parse(entry));
    expect(messages.filter((msg) => msg.action === "subscribe")).toHaveLength(1);
    expect(messages.some((msg) => msg.action === "unsubscribe")).toBe(false);

    mockWs.triggerMessage({ type: "event", channel: "github:activity", event: "new_event", data: { id: "nav" } });
    expect(firstHandler).toHaveBeenCalledTimes(0);
    expect(secondHandler).toHaveBeenCalledTimes(1);
  });
});
