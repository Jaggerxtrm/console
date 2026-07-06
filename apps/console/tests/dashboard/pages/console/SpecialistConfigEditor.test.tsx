/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ logClientEvent: vi.fn() }));
import { SpecialistConfigEditor } from "../../../../src/dashboard/pages/console/specialists/SpecialistConfigEditor.tsx";

vi.mock("../../../../src/dashboard/lib/client-log.ts", () => ({ logClientEvent: mocks.logClientEvent }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.logClientEvent.mockReset();
});

describe("SpecialistConfigEditor", () => {
  it("renders standalone from props in minimal harness", async () => {
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: vi.fn(() => true) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        host: { label: "Host-wide config", scope: "global" },
        specialists: [{ name: "debugger" }],
        userConfig: {
          path: "~/.config/specialists/user.json",
          displayPath: "~/.config/specialists/user.json",
          content: { debugger: { execution: { model: "gpt-5" } } },
          validationErrors: [],
          leafPaths: ["execution.model"],
        },
        consoleConfig: {
          path: "~/.config/specialists/console.json",
          displayPath: "~/.config/specialists/console.json",
          content: { base_dirs: ["~/dev"], repos: [{ name: "console", path: "/work/console" }] },
        },
      }),
    }));

    render(<SpecialistConfigEditor hostLabel="Host-wide specialist config" apiBasePath="/api/specialists/config" />);

    expect(screen.getByTestId("specialist-config-editor")).toBeTruthy();
    expect(screen.getByText("Host-wide specialist config")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Console repo registry")).toBeTruthy());
    expect(screen.getByText("execution.model")).toBeTruthy();
    expect(screen.getByDisplayValue("console")).toBeTruthy();
    expect(screen.getByDisplayValue("/work/console")).toBeTruthy();
  });
});
