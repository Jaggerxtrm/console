import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { VitestReporter } from "tdd-guard-vitest";
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "bun:sqlite": fileURLToPath(new URL("tests/__mocks__/bun-sqlite.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: true,
    exclude: ["**/node_modules/**", "**/dist/**", "**/.worktrees/**", "tests/e2e/specialists-live-dependencies.spec.cjs"],
    reporters: [
      "default",
      new VitestReporter("/home/dawid/dev/console"),
    ],
    coverage: {
      provider: "v8",
    },
    environmentMatchGlobs: [
      ["tests/dashboard/**", "happy-dom"],
    ],
    setupFiles: ["tests/dashboard/setup.ts"],
    server: {
      deps: {
        external: [/^node:/],
      },
    },
  },
});
