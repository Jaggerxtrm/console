import type { ShellProviderStatus } from "../../../core/shell-provider-policy.ts";

export function getShellProviderNoticeMessage(status: ShellProviderStatus): string {
  return status.enabled ? "Enabled with safety gates." : status.disabledReason;
}

export function getShellProviderNoticeHint(status: ShellProviderStatus): string {
  return status.enabled
    ? "Repo cwd, shell allowlist, scrub, TTL, and byte caps active."
    : "Disabled state enforced server-side.";
}
