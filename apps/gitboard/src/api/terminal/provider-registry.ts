import type { TerminalProviderKind } from "../../../../packages/core/src/terminal/protocol.ts";
import { getShellProviderStatus } from "../../core/shell-provider-policy.ts";

export interface TerminalProviderDescriptor {
  kind: TerminalProviderKind;
  enabled: boolean;
  reason?: string;
}

export interface TerminalProviderRegistry {
  list(): TerminalProviderDescriptor[];
  get(kind: TerminalProviderKind): TerminalProviderDescriptor | undefined;
}

export function createTerminalProviderRegistry(env: NodeJS.ProcessEnv = process.env): TerminalProviderRegistry {
  const shellStatus = getShellProviderStatus(env);

  const providers: TerminalProviderDescriptor[] = [
    { kind: "specialist-feed", enabled: true },
    { kind: "pty", enabled: false, reason: shellStatus.enabled ? "node-pty unavailable" : shellStatus.disabledReason },
    { kind: "tmux", enabled: false, reason: "provider disabled" },
    { kind: "ssh", enabled: false, reason: "provider disabled" },
    { kind: "command", enabled: false, reason: "provider disabled" },
  ];

  return {
    list: () => providers,
    get: (kind) => providers.find((provider) => provider.kind === kind),
  };
}
