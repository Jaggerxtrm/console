import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShellProviderNotice } from "../../../../src/dashboard/components/console/ShellProviderNotice.tsx";

describe("ShellProviderNotice", () => {
  it("renders disabled message safely", () => {
    const html = renderToStaticMarkup(
      createElement(ShellProviderNotice, {
        status: {
          enabled: false,
          disabledReason: "disabled by default",
          policy: {
            enabled: false,
            allowRemote: false,
            allowAdminOnly: true,
            devGateRequired: true,
            cwdAllowlist: ["/repo"],
            shellAllowlist: ["/bin/bash"],
            envScrub: ["HOME"],
            maxSessions: 1,
            idleTimeoutMs: 1,
            hardTtlMs: 2,
            maxInputBytesPerSecond: 3,
            maxOutputBytesPerSecond: 4,
            auditEnabled: true,
            orphanCleanupEnabled: true,
          },
        },
      }),
    );
    expect(html).toContain("disabled by default");
    expect(html).toContain("Disabled state enforced server-side.");
  });
});
