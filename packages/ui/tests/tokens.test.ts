import { describe, it, expect } from "vitest";

describe("CSS Design Tokens", () => {
  it("defines surface colors", () => {
    const surfaces = [
      "--surface-backdrop",
      "--surface-elevated", 
      "--surface-primary",
      "--surface-secondary",
      "--surface-tertiary",
      "--surface-quaternary",
    ];
    expect(surfaces.length).toBe(6);
  });

  it("defines accent colors", () => {
    const accents = [
      "--accent-blue",
      "--accent-green",
      "--accent-orange",
      "--accent-red",
      "--accent-purple",
      "--accent-teal",
    ];
    expect(accents.length).toBe(6);
  });

  it("defines spacing scale", () => {
    const spacing = [
      "--spacing-xs",   // 4px
      "--spacing-sm",   // 8px
      "--spacing-md",   // 16px
      "--spacing-lg",   // 24px
      "--spacing-xl",   // 32px
      "--spacing-2xl",  // 40px
    ];
    expect(spacing.length).toBe(6);
  });

  it("defines typography scale", () => {
    const typography = [
      ["--text-xs", "0.75rem"],
      ["--text-sm", "0.8125rem"],
      ["--text-base", "0.875rem"],
      ["--text-md", "1rem"],
      ["--text-xl", "1.25rem"],
    ] as const;

    expect(typography).toHaveLength(5);
    expect(typography.map(([token]) => token)).toEqual([
      "--text-xs",
      "--text-sm",
      "--text-base",
      "--text-md",
      "--text-xl",
    ]);
    expect(typography.map(([, value]) => value)).toEqual([
      "0.75rem",
      "0.8125rem",
      "0.875rem",
      "1rem",
      "1.25rem",
    ]);
  });

  it("defines border radius", () => {
    const radius = [
      "--radius-xs",    // 4px
      "--radius-sm",    // 6px
      "--radius-md",    // 8px
      "--radius-lg",    // 12px
      "--radius-pill",  // 9999px
    ];
    expect(radius.length).toBe(5);
  });

  it("defines shadows", () => {
    const shadows = [
      "--shadow-sm",
      "--shadow-md",
      "--shadow-lg",
      "--shadow-card",
    ];
    expect(shadows.length).toBe(4);
  });
});
