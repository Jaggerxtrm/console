export const TERMINAL_STREAM_PROTOCOL_VERSION = "1.0.0" as const;

export type TerminalProviderKind =
  | "pty"
  | "tmux"
  | "ssh"
  | "command"
  | "specialist-feed";

export type TerminalCapability =
  | "readonly"
  | "interactive"
  | "resizable"
  | "snapshot"
  | "persistent";

export type TerminalLifecycleState =
  | "opening"
  | "open"
  | "attached"
  | "detached"
  | "idle"
  | "exiting"
  | "exited"
  | "error";

export type TerminalEnvelopeKind =
  | "open"
  | "attach"
  | "detach"
  | "input"
  | "output"
  | "resize"
  | "exit"
  | "error"
  | "status"
  | "heartbeat";

export interface TerminalStreamEnvelope<TKind extends TerminalEnvelopeKind = TerminalEnvelopeKind, TPayload = unknown> {
  version: string;
  kind: TKind;
  streamId: string;
  sessionId: string;
  timestamp: string;
  payload: TPayload;
}

export interface TerminalStreamOpenPayload {
  providerKind: TerminalProviderKind;
  capabilities: TerminalCapability[];
  cwd?: string;
  command?: string;
  title?: string;
}

export interface TerminalStreamAttachPayload {
  resume: boolean;
  token?: string;
  lastSequence?: number;
}

export interface TerminalStreamDetachPayload {
  reason?: string;
}

export interface TerminalStreamInputPayload {
  data: string;
  encoding: "utf8" | "base64";
  sequence?: number;
}

export interface TerminalStreamOutputPayload {
  data: string;
  encoding: "utf8" | "base64";
  sequence: number;
  bytes: number;
}

export interface TerminalStreamResizePayload {
  cols: number;
  rows: number;
}

export interface TerminalStreamExitPayload {
  code: number | null;
  signal: string | null;
}

export interface TerminalStreamErrorPayload {
  code: string;
  message: string;
  recoverable: boolean;
  details?: unknown;
}

export interface TerminalStreamStatusPayload {
  state: TerminalLifecycleState;
  attached: boolean;
  paused: boolean;
  bytesIn: number;
  bytesOut: number;
  backlogBytes: number;
  note?: string;
}

export interface TerminalStreamHeartbeatPayload {
  ack?: number;
}

export type TerminalStreamMessage =
  | TerminalStreamEnvelope<"open", TerminalStreamOpenPayload>
  | TerminalStreamEnvelope<"attach", TerminalStreamAttachPayload>
  | TerminalStreamEnvelope<"detach", TerminalStreamDetachPayload>
  | TerminalStreamEnvelope<"input", TerminalStreamInputPayload>
  | TerminalStreamEnvelope<"output", TerminalStreamOutputPayload>
  | TerminalStreamEnvelope<"resize", TerminalStreamResizePayload>
  | TerminalStreamEnvelope<"exit", TerminalStreamExitPayload>
  | TerminalStreamEnvelope<"error", TerminalStreamErrorPayload>
  | TerminalStreamEnvelope<"status", TerminalStreamStatusPayload>
  | TerminalStreamEnvelope<"heartbeat", TerminalStreamHeartbeatPayload>;

export interface TerminalStreamSessionState {
  state: TerminalLifecycleState;
  attached: boolean;
  supportsInput: boolean;
  supportsResize: boolean;
  isSnapshotting: boolean;
  exited: boolean;
}

export const TERMINAL_SESSION_TRANSITIONS: Record<TerminalLifecycleState, readonly TerminalLifecycleState[]> = {
  opening: ["open", "error", "exiting", "exited"],
  open: ["attached", "detached", "idle", "exiting", "exited", "error"],
  attached: ["detached", "idle", "exiting", "exited", "error"],
  detached: ["attached", "idle", "exiting", "exited", "error"],
  idle: ["attached", "detached", "exiting", "exited", "error"],
  exiting: ["exited", "error"],
  exited: [],
  error: ["opening", "open", "attached", "detached", "idle", "exiting", "exited"],
};

export function isTerminalLifecycleTransitionAllowed(
  from: TerminalLifecycleState,
  to: TerminalLifecycleState,
): boolean {
  return TERMINAL_SESSION_TRANSITIONS[from].includes(to);
}

export function createTerminalStreamEnvelope<TKind extends TerminalEnvelopeKind, TPayload>(
  kind: TKind,
  streamId: string,
  sessionId: string,
  payload: TPayload,
  version: string = TERMINAL_STREAM_PROTOCOL_VERSION,
  timestamp: string = new Date().toISOString(),
): TerminalStreamEnvelope<TKind, TPayload> {
  return { version, kind, streamId, sessionId, timestamp, payload };
}

export function estimateTerminalOutputBackpressure(bytesOut: number, backlogBytes: number): string {
  if (backlogBytes === 0) return "flowing";
  if (backlogBytes < 64 * 1024) return "buffered";
  if (backlogBytes < 1024 * 1024) return "throttled";
  return bytesOut > 0 ? "paused" : "backpressured";
}

export function isTerminalProviderKind(value: unknown): value is TerminalProviderKind {
  return value === "pty" || value === "tmux" || value === "ssh" || value === "command" || value === "specialist-feed";
}

export function isTerminalCapability(value: unknown): value is TerminalCapability {
  return value === "readonly" || value === "interactive" || value === "resizable" || value === "snapshot" || value === "persistent";
}

export function isTerminalLifecycleState(value: unknown): value is TerminalLifecycleState {
  return (
    value === "opening" ||
    value === "open" ||
    value === "attached" ||
    value === "detached" ||
    value === "idle" ||
    value === "exiting" ||
    value === "exited" ||
    value === "error"
  );
}

export function isTerminalEnvelopeKind(value: unknown): value is TerminalEnvelopeKind {
  return (
    value === "open" ||
    value === "attach" ||
    value === "detach" ||
    value === "input" ||
    value === "output" ||
    value === "resize" ||
    value === "exit" ||
    value === "error" ||
    value === "status" ||
    value === "heartbeat"
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function validateTerminalStreamMessage(value: unknown): value is TerminalStreamMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.version !== "string") return false;
  if (!isTerminalEnvelopeKind(record.kind)) return false;
  if (typeof record.streamId !== "string" || typeof record.sessionId !== "string") return false;
  if (typeof record.timestamp !== "string") return false;
  if (typeof record.payload !== "object" || record.payload === null) return false;

  const payload = record.payload as Record<string, unknown>;

  switch (record.kind) {
    case "open":
      return isTerminalProviderKind(payload.providerKind)
        && Array.isArray(payload.capabilities)
        && payload.capabilities.every((capability) => isTerminalCapability(capability));
    case "attach":
      return typeof payload.resume === "boolean" && typeof payload.token === "string" && payload.token.length > 0;
    case "detach":
      return typeof payload.reason === "string" || !("reason" in payload);
    case "input":
      return typeof payload.data === "string" && (payload.encoding === "utf8" || payload.encoding === "base64");
    case "output":
      return typeof payload.data === "string"
        && (payload.encoding === "utf8" || payload.encoding === "base64")
        && typeof payload.sequence === "number"
        && typeof payload.bytes === "number";
    case "resize":
      return typeof payload.cols === "number" && typeof payload.rows === "number";
    case "exit":
      return (typeof payload.code === "number" || payload.code === null)
        && (typeof payload.signal === "string" || payload.signal === null);
    case "error":
      return typeof payload.code === "string"
        && typeof payload.message === "string"
        && typeof payload.recoverable === "boolean";
    case "status":
      return isTerminalLifecycleState(payload.state)
        && typeof payload.attached === "boolean"
        && typeof payload.paused === "boolean"
        && typeof payload.bytesIn === "number"
        && typeof payload.bytesOut === "number"
        && typeof payload.backlogBytes === "number";
    case "heartbeat":
      return typeof payload.ack === "number" || !("ack" in payload);
  }

  return false;
}

/**
 * Terminal stream protocol contract.
 *
 * Envelope rule: every message carries version, streamId, sessionId, timestamp, kind, payload.
 * Flow rule: output can outpace UI; backlogBytes exists so transport can pause or downgrade before memory grows unbounded.
 * State rule: lifecycle transitions are narrow and invalid jumps must reject.
 */
export const TERMINAL_STREAM_PROTOCOL_DOC = {
  version: TERMINAL_STREAM_PROTOCOL_VERSION,
  note: "Use generic envelope plus terminal payloads. Keep provider kinds narrow. Track backlogBytes for backpressure.",
} as const;
