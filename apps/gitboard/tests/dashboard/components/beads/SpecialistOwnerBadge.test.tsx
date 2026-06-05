// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SpecialistOwnerBadge } from "../../../../src/dashboard/components/beads/SpecialistOwnerBadge.tsx";
import type { SpecialistOwnershipJob } from "../../../../src/dashboard/hooks/useSpecialistOwnership.ts";

const job: SpecialistOwnershipJob = {
  jobId: "job-abcdef123456",
  role: "executor",
  state: "running",
  repoSlug: "repo-a",
};

afterEach(() => {
  cleanup();
});

describe("SpecialistOwnerBadge", () => {
  it("calls onClick from pointer and keyboard, exposes button semantics when clickable", () => {
    const onClick = vi.fn();
    const parentKeyDown = vi.fn();

    render(
      <div onKeyDown={parentKeyDown}>
        <SpecialistOwnerBadge job={job} onClick={onClick} />
      </div>,
    );

    const badge = screen.getByRole("button", { name: /executor:job-ab·running/i });
    expect(badge.getAttribute("tabindex")).toBe("0");

    fireEvent.click(badge);
    fireEvent.keyDown(badge, { key: "Enter" });
    fireEvent.keyDown(badge, { key: " " });

    expect(onClick).toHaveBeenCalledTimes(3);
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it("stays inert when no onClick given", () => {
    render(<SpecialistOwnerBadge job={job} />);

    const badge = screen.getByText(/executor:job-ab·running/i, { selector: "span:not([role='button'])" });
    expect(badge.getAttribute("role")).not.toBe("button");
    expect(badge.getAttribute("tabindex")).toBeNull();
  });

});
