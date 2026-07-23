import { fileURLToPath } from "node:url";
import { createTerminalProviderRegistry as createCoreTerminalProviderRegistry } from "../../../../../packages/core/src/terminal/provider-registry.ts";

export function createTerminalProviderRegistry(env: NodeJS.ProcessEnv = process.env) {
  return createCoreTerminalProviderRegistry(env, {
    ptyHelperPath: fileURLToPath(new URL("./node-pty-helper.cjs", import.meta.url)),
  });
}

export type {
  TerminalProvider,
  TerminalProviderRegistry,
  TerminalProviderSession,
} from "../../../../../packages/core/src/terminal/provider-registry.ts";
