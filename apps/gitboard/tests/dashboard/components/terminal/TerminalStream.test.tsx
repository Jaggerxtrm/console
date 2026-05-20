import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TerminalStream } from "../../../../src/dashboard/components/terminal/TerminalStream.tsx";

const terminalState = {
  write: vi.fn(),
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

  it("fits and reports resize on mount", () => {
    const onResize = vi.fn();
    render(<TerminalStream onResize={onResize} />);

    expect(fitState.fit).toHaveBeenCalled();
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
