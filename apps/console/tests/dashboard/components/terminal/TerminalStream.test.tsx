/** @vitest-environment happy-dom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { TerminalStream } from "../../../../src/dashboard/components/terminal/TerminalStream.tsx";

// Focused coverage for the xterm-backed TerminalStream leaf. The BeadActivityPane
// suite stubs this component (see tests/dashboard/components/specialists/BeadActivityPane.test.tsx)
// to stay deterministic under parallel load; this file exercises the real xterm
// construction, output-writing, and attach/detach lifecycle that the stub skips.
// Kept isolated and assertion-light so it stays fast and non-flaky.

function renderStream(props: Partial<React.ComponentProps<typeof TerminalStream>> = {}) {
  return render(React.createElement(TerminalStream, { output: [], ...props }));
}

describe("Console TerminalStream", () => {
  afterEach(() => {
    cleanup();
  });

  it("mounts a real xterm terminal inside the stream surface", () => {
    const onAttach = vi.fn();
    const { container } = renderStream({
      className: "bead-activity-terminal",
      status: "STATUSNODE",
      onAttach,
    });

    const section = container.querySelector("section");
    expect(section?.className).toBe("terminal-stream bead-activity-terminal");
    expect(section?.getAttribute("aria-label")).toBe("terminal stream");
    expect(container.querySelectorAll(".terminal-stream-surface")).toHaveLength(1);
    // Real xterm renderer mounted into the surface host (the heavy path the pane stub skips).
    expect(container.querySelector(".terminal-stream-surface .xterm")).not.toBeNull();
    expect(container.querySelector(".terminal-stream-status")?.textContent).toBe("STATUSNODE");
    expect(onAttach).toHaveBeenCalledTimes(1);
  });

  it("writes string and Uint8Array output chunks into the terminal", async () => {
    const bytes = new TextEncoder().encode("byte-chunk");
    const { container } = renderStream({ output: ["string-chunk", bytes] });

    await waitFor(() => expect(container.textContent).toContain("string-chunk"));
    await waitFor(() => expect(container.textContent).toContain("byte-chunk"));
  });

  it("appends new chunks without dropping previously written content", async () => {
    const { container, rerender } = renderStream({ output: ["first-chunk"] });
    await waitFor(() => expect(container.textContent).toContain("first-chunk"));

    rerender(React.createElement(TerminalStream, { output: ["first-chunk", "second-chunk"] }));
    await waitFor(() => expect(container.textContent).toContain("second-chunk"));
    expect(container.textContent).toContain("first-chunk");
  });

  it("fires onDetach when unmounted", () => {
    const onDetach = vi.fn();
    const { unmount } = renderStream({ onDetach });
    expect(onDetach).not.toHaveBeenCalled();
    unmount();
    expect(onDetach).toHaveBeenCalledTimes(1);
  });
});
