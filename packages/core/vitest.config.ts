import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "bun:sqlite": fileURLToPath(new URL("tests/__mocks__/bun-sqlite.ts", import.meta.url)),
    },
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
