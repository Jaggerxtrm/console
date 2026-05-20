import type { ShellProviderStatus } from "../../../core/shell-provider-policy.ts";
import { getShellProviderNoticeHint, getShellProviderNoticeMessage } from "./shell-provider-notice.ts";

export function ShellProviderNotice({ status }: { status: ShellProviderStatus }) {
  return (
    <section className={status.enabled ? "shell-provider-notice is-enabled" : "shell-provider-notice is-disabled"} role="status">
      <strong>Shell provider</strong>
      <p>{getShellProviderNoticeMessage(status)}</p>
      <small>{getShellProviderNoticeHint(status)}</small>
    </section>
  );
}
