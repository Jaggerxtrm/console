export type EventType =
  | `materializer.${string}`
  | `adapter.${string}`
  | `parity.${string}`
  | `ws.publish.${string}`
  | `api.request.${string}`
  | `scanner.${string}`
  | `app.${string}`
  | `system.${string}`
  | `ui.${string}`
  | (string & {});
