type ClientLogData = Record<string, unknown>;

export function logClientEvent(event: string, data: ClientLogData = {}): void {
  if (typeof window === "undefined" || typeof navigator === "undefined") return;

  const payload = JSON.stringify({ event, data });
  const url = "/api/internal/logs/client";

  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon(url, blob)) return;
    }
  } catch {
    // Fall through to fetch. Client-side telemetry must never affect UX.
  }

  if (typeof fetch === "undefined") return;

  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => undefined);
}
