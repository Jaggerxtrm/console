import "@testing-library/jest-dom";
import { vi } from "vitest";

const testVi = vi as unknown as { stubGlobal?: (name: PropertyKey, value: unknown) => unknown };

if (!testVi.stubGlobal) {
  testVi.stubGlobal = (name: PropertyKey, value: unknown) => {
    Object.defineProperty(globalThis, String(name), {
      configurable: true,
      writable: true,
      value,
    });
    return vi;
  };
}

if (typeof window !== "undefined" && !window.SyntaxError) {
  Object.defineProperty(window, "SyntaxError", {
    configurable: true,
    writable: true,
    value: globalThis.SyntaxError,
  });
}
