import { Hono } from "hono";
import { createTerminalProviderRegistry } from "../terminal/provider-registry.ts";

export function createTerminalRouter() {
  const app = new Hono();
  const providers = createTerminalProviderRegistry(process.env);

  app.get("/status", (c) => c.json({ providers: providers.list() }));

  return app;
}
