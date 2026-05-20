import { describe, expect, it } from "vitest";
import { getShellProviderNoticeHint, getShellProviderNoticeMessage } from "../../../../src/dashboard/components/console/shell-provider-notice.ts";

describe("shell provider notice helpers", () => {
  it("renders disabled text", () => {
    const status = { enabled: false, disabledReason: "admin-only shell access requires verified admin", policy: {} } as never;
    expect(getShellProviderNoticeMessage(status)).toBe("admin-only shell access requires verified admin");
    expect(getShellProviderNoticeHint(status)).toBe("Disabled state enforced server-side.");
  });
});
