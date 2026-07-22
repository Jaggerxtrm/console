import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Runtime detection: only alias bun:sqlite → node:sqlite shim under Node.
// Under Bun (process.versions.bun defined), native bun:sqlite is available
// and must NOT be intercepted so regression tests exercise production semantics.
const isBun = typeof process.versions.bun === "string";

const alias: Record<string, string> = isBun
  ? {}
  : { "bun:sqlite": fileURLToPath(new URL("tests/__mocks__/bun-sqlite.ts", import.meta.url)) };

export default defineConfig({
  resolve: {
    alias,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    server: {
      deps: {
        external: [/^node:/],
      },
    },
  },
});
