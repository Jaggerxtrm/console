import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Terminal } from "xterm";
import { TerminalStream } from "../../../../src/dashboard/components/terminal/TerminalStream.tsx";

const terminalState = {
  write: vi.fn(),
  reset: vi.fn(),
  open: vi.fn(),
  loadAddon: vi.fn(),
  dispose: vi.fn(),
  onData: vi.fn(),
  cols: 80,
  rows: 24,
};
const fitState = { fit: vi.fn(), dispose: vi.fn() };
const resizeObserve = vi.fn();
const resizeDisconnect = vi.fn();
const resizeObserver = { observe: resizeObserve, disconnect: resizeDisconnect };

vi.mock("xterm", () => ({
  Terminal: vi.fn().mockImplementation(() => terminalState),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => fitState),
}));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", vi.fn().mockImplementation(() => resizeObserver));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(240);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TerminalStream", () => {
  it("renders status and ANSI output", () => {
    render(<TerminalStream status="ready" output={["\u001b[31mred\u001b[0m"]} />);

    expect(screen.getByLabelText("terminal stream")).toBeTruthy();
    expect(screen.getByText("ready")).toBeTruthy();
    expect(terminalState.write).toHaveBeenCalledWith("\u001b[31mred\u001b[0m");
  });

  it("rewrites snapshot output when content changes without growing", () => {
    const { rerender } = render(<TerminalStream output={["first snapshot"]} />);
    expect(terminalState.write).toHaveBeenCalledWith("first snapshot");

    rerender(<TerminalStream output={["second snapshot"]} />);

    expect(terminalState.reset).toHaveBeenCalled();
    expect(terminalState.write).toHaveBeenLastCalledWith("second snapshot");
  });

  it("blocks keyboard input in readonly mode", () => {
    const onInput = vi.fn();
    render(<TerminalStream readonly onInput={onInput} />);

    const onData = terminalState.onData.mock.calls[0][0] as (data: string) => void;
    onData("x");

    expect(onInput).not.toHaveBeenCalled();
  });

  it("emits keyboard input in interactive mode", () => {
    const onInput = vi.fn();
    render(<TerminalStream onInput={onInput} />);

    const onData = terminalState.onData.mock.calls[0][0] as (data: string) => void;
    onData("ls\n");

    expect(onInput).toHaveBeenCalledWith("ls\n");
  });

  it("uses concrete mono font metrics without browser fallback spacing", () => {
    render(<TerminalStream />);

    expect(Terminal).toHaveBeenCalledWith(expect.objectContaining({
      fontFamily: expect.stringContaining("JetBrainsMono Nerd Font Mono"),
      letterSpacing: 0,
      lineHeight: 1.15,
    }));
  });

  it("fits and reports resize on mount", async () => {
    const onResize = vi.fn();
    render(<TerminalStream onResize={onResize} />);

    await vi.waitFor(() => expect(fitState.fit).toHaveBeenCalled());
    expect(onResize).toHaveBeenCalledWith({ cols: 80, rows: 24 });
    expect(resizeObserve).toHaveBeenCalled();
  });

  it("cleans up terminal and fit addon on unmount", () => {
    const { unmount } = render(<TerminalStream />);

    unmount();

    expect(resizeDisconnect).toHaveBeenCalled();
    expect(fitState.dispose).toHaveBeenCalled();
    expect(terminalState.dispose).toHaveBeenCalled();
  });
});
