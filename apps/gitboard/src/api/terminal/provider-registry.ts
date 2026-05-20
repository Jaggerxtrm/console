import type { TerminalCapability, TerminalProviderKind } from "../../../../../packages/core/src/terminal/protocol.ts";
import { getShellProviderStatus } from "../../core/shell-provider-policy.ts";

export interface TerminalProviderSession {
  onOutput(listener: (data: string) => void): () => void;
  onExit(listener: (code: number | null, signal: string | null) => void): () => void;
  input(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  dispose(reason: string): Promise<void>;
}

export interface TerminalProvider {
  kind: TerminalProviderKind;
  enabled: boolean;
  reason?: string;
  openSession(args: { sessionId: string; capabilities: TerminalCapability[] }): Promise<TerminalProviderSession>;
}

export interface TerminalProviderRegistry {
  list(): Array<Pick<TerminalProvider, "kind" | "enabled" | "reason">>;
  get(kind: TerminalProviderKind): TerminalProvider | undefined;
}

export function createTerminalProviderRegistry(env: NodeJS.ProcessEnv = process.env): TerminalProviderRegistry {
  const shellStatus = getShellProviderStatus(env);
  const providers: TerminalProvider[] = [
    {
      kind: "specialist-feed",
      enabled: true,
      openSession: async () => {
        throw new Error("specialist-feed session unsupported");
      },
    },
    {
      kind: "pty",
      enabled: false,
      reason: shellStatus.enabled ? "node-pty unavailable" : shellStatus.disabledReason,
      openSession: async () => {
        throw new Error(shellStatus.enabled ? "node-pty unavailable" : shellStatus.disabledReason);
      },
    },
    { kind: "tmux", enabled: false, reason: "provider disabled", openSession: async () => { throw new Error("provider disabled"); } },
    { kind: "ssh", enabled: false, reason: "provider disabled", openSession: async () => { throw new Error("provider disabled"); } },
    { kind: "command", enabled: false, reason: "provider disabled", openSession: async () => { throw new Error("provider disabled"); } },
  ];
  return {
    list: () => providers.map(({ kind, enabled, reason }) => ({ kind, enabled, reason })),
    get: (kind) => providers.find((provider) => provider.kind === kind),
  };
}
