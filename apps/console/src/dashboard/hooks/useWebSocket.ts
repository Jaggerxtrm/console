import { useEffect, useRef } from "react";
import { WsClient, buildWsUrl } from "../lib/ws.ts";
import type { WsHandler } from "../lib/ws.ts";

let sharedClient: WsClient | null = null;

function getSharedClient(): WsClient {
  if (!sharedClient) {
    sharedClient = new WsClient(buildWsUrl());
    sharedClient.connect();
  }
  return sharedClient;
}

export function useWebSocket(channel: string, handler: WsHandler): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const client = getSharedClient();
    performance.mark(`ws:${channel}:subscribe_start`);
    client.subscribe(channel);

    const unsubHandler = client.onMessage((msg) => {
      if (msg.channel === channel) {
        if (msg.type === "event") performance.mark(`ws:${channel}:first_event`);
        handlerRef.current(msg);
      }
    });

    return () => {
      unsubHandler();
      client.unsubscribe(channel);
    };
  }, [channel]);
}

/** For testing: reset the shared client (so tests can inject mocks) */
export function _resetSharedClient(): void {
  sharedClient?.disconnect();
  sharedClient = null;
}
