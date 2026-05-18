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

export class WsClient {
  private ws: WebSocket | null = null;
  private subscriptions = new Set<string>();
  private handlers: WsHandler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private closed = false;
  private lastSeqByChannel = new Map<string, number>();
  private bootId: string | null = null;

  constructor(private url: string) {}

  connect(): void {
    if (this.ws) return;
    this.closed = false;
    this._open();
  }

  private _open(): void {
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      for (const channel of this.subscriptions) {
        const since_seq = this.lastSeqByChannel.get(channel) ?? 0;
        if (since_seq > 0 && this.bootId) {
          this._send({ action: "resume", channel, since_seq, boot_id: this.bootId, version: String(REALTIME_PROTOCOL_VERSION) });
        }
        this._send({ type: "subscribe", channel, version: String(REALTIME_PROTOCOL_VERSION) });
      }
    };

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data as string) as WsMessage;
        if (msg.type === "event" && msg.channel && typeof msg.seq === "number") {
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
      if (!this.closed) this._scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private _scheduleReconnect(): void {
    if (this.closed) return;
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
    this.subscriptions.add(channel);
    this._send({ type: "subscribe", channel, version: String(REALTIME_PROTOCOL_VERSION) });
  }

  unsubscribe(channel: string): void {
    this.subscriptions.delete(channel);
    this.lastSeqByChannel.delete(channel);
    this._send({ type: "unsubscribe", channel });
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
