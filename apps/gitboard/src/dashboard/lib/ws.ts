import { REALTIME_PROTOCOL_VERSION } from "../../types/realtime.ts";

export type WsMessage = {
  type: string;
  channel?: string;
  event?: string;
  data?: unknown;
  id?: string;
  seq?: number;
  version?: string;
  boot_id?: string;
};

export type WsHandler = (msg: WsMessage) => void;

export const UNSUBSCRIBE_GRACE_MS = 2000;

function isWsDebugEnabled(): boolean {
  try {
    if (typeof window === "undefined") return false;
    if ((window as typeof window & { __GITBOARD_DEBUG__?: boolean }).__GITBOARD_DEBUG__ === true) return true;
    return localStorage.getItem("gitboard:ws-debug") === "1";
  } catch {
    return false;
  }
}

function wsDebugLog(event: string, data: Record<string, unknown>): void {
  if (!isWsDebugEnabled()) return;
  console.info(`[ws] ${event}`, data);
}

export class WsClient {
  private ws: WebSocket | null = null;
  private subscriptions = new Map<string, number>();
  private handlers: WsHandler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconnectDelay = 1000;
  private closed = false;
  private lastSeqByChannel = new Map<string, number>();
  private bootId: string | null = null;
  private connectStartedAt = 0;

  constructor(private url: string) {}

  connect(): void {
    if (this.ws) return;
    this.closed = false;
    this.connectStartedAt = performance.now();
    this._open();
  }

  private _open(): void {
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this._scheduleReconnect("open_error");
      return;
    }

    this.ws.onopen = () => {
      const connectMs = Math.round(performance.now() - this.connectStartedAt);
      this.reconnectDelay = 1000;
      wsDebugLog("connected", { connectMs, subscriptions: this.subscriptions.size });
      for (const [channel, count] of this.subscriptions) {
        if (count === 0) continue;
        const since_seq = this.lastSeqByChannel.get(channel) ?? 0;
        if (since_seq > 0 && this.bootId) {
          wsDebugLog("resume", { channel, since_seq, boot_id: this.bootId });
          this._send({ action: "resume", channel, since_seq, boot_id: this.bootId, version: String(REALTIME_PROTOCOL_VERSION) });
        }
        this._send({ action: "subscribe", channel, version: String(REALTIME_PROTOCOL_VERSION) });
      }
    };

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data as string) as WsMessage;
        if (msg.type === "event" && msg.channel && typeof msg.seq === "number") {
          const lastSeq = this.lastSeqByChannel.get(msg.channel) ?? 0;
          if (msg.seq > lastSeq + 1) wsDebugLog("seq_gap", { channel: msg.channel, lastSeq, seq: msg.seq, gap: msg.seq - lastSeq - 1 });
          this.lastSeqByChannel.set(msg.channel, msg.seq);
          if (msg.boot_id) this.bootId = msg.boot_id;
        }
        for (const h of this.handlers) h(msg);
      } catch {
        // ignore parse errors
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (!this.closed) this._scheduleReconnect("close");
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private _scheduleReconnect(reason: string): void {
    if (this.closed) return;
    wsDebugLog("reconnect_scheduled", { reason, delayMs: this.reconnectDelay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this._open();
    }, this.reconnectDelay);
  }

  private _send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  subscribe(channel: string): void {
    const pendingUnsubscribe = this.unsubscribeTimers.get(channel);
    if (pendingUnsubscribe) {
      clearTimeout(pendingUnsubscribe);
      this.unsubscribeTimers.delete(channel);
      wsDebugLog("unsubscribe_canceled", { channel });
    }

    const currentCount = this.subscriptions.get(channel);
    const nextCount = (currentCount ?? 0) + 1;
    this.subscriptions.set(channel, nextCount);
    if (currentCount !== undefined) return;

    this._send({ action: "subscribe", channel, version: String(REALTIME_PROTOCOL_VERSION) });
  }

  unsubscribe(channel: string): void {
    const currentCount = this.subscriptions.get(channel);
    if (!currentCount) return;

    if (currentCount > 1) {
      this.subscriptions.set(channel, currentCount - 1);
      return;
    }

    this.subscriptions.set(channel, 0);
    wsDebugLog("unsubscribe_scheduled", { channel, delayMs: UNSUBSCRIBE_GRACE_MS });
    const timer = setTimeout(() => {
      this.unsubscribeTimers.delete(channel);
      if (this.subscriptions.get(channel) !== 0) return;
      this.subscriptions.delete(channel);
      this._send({ action: "unsubscribe", channel });
      wsDebugLog("unsubscribe_sent", { channel });
    }, UNSUBSCRIBE_GRACE_MS);
    this.unsubscribeTimers.set(channel, timer);
  }

  onMessage(handler: WsHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const [channel, timer] of this.unsubscribeTimers) {
      clearTimeout(timer);
      if (this.subscriptions.get(channel) === 0) this.subscriptions.delete(channel);
    }
    this.unsubscribeTimers.clear();
    this.ws?.close();
    this.ws = null;
  }

  get readyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }
}

export function buildWsUrl(baseUrl = ""): string {
  const base = baseUrl || window.location.origin;
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.toString();
}
