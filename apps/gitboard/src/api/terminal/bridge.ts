import {
  createTerminalStreamEnvelope,
  isTerminalProviderKind,
  validateTerminalStreamMessage,
  type TerminalStreamMessage,
} from "../../../../packages/core/src/terminal/protocol.ts";
import type { TerminalProviderRegistry } from "./provider-registry.ts";

export class TerminalBridge {
  constructor(private readonly providers: TerminalProviderRegistry) {}

  onMessage(raw: string): string {
    const parsed = JSON.parse(raw) as unknown;
    if (!validateTerminalStreamMessage(parsed)) {
      return JSON.stringify(createTerminalStreamEnvelope("error", "bridge", "invalid", { code: "invalid_message", message: "invalid protocol envelope", recoverable: true }));
    }
    const msg = parsed as TerminalStreamMessage;
    if (msg.kind !== "open") {
      return JSON.stringify(createTerminalStreamEnvelope("error", msg.streamId, msg.sessionId, { code: "unsupported", message: `unsupported message ${msg.kind}`, recoverable: true }));
    }
    if (!isTerminalProviderKind(msg.payload.providerKind)) {
      return JSON.stringify(createTerminalStreamEnvelope("error", msg.streamId, msg.sessionId, { code: "provider_invalid", message: "provider invalid", recoverable: true }));
    }
    const provider = this.providers.get(msg.payload.providerKind);
    if (!provider?.enabled) {
      return JSON.stringify(createTerminalStreamEnvelope("error", msg.streamId, msg.sessionId, { code: "provider_disabled", message: provider?.reason ?? "provider disabled", recoverable: true }));
    }
    return JSON.stringify(createTerminalStreamEnvelope("status", msg.streamId, msg.sessionId, { state: "open", attached: false, paused: false, bytesIn: 0, bytesOut: 0, backlogBytes: 0 }));
  }
}
