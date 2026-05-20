import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTerminalProviderRegistry } from "../../../src/api/terminal/provider-registry.ts";

function createFeedScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "specialist-feed-"));
  const script = join(dir, "fake-specialists.js");
  writeFileSync(script, `#!/usr/bin/env node
process.stdout.write("feed:" + process.argv.slice(2).join(" ") + "\\n");
setTimeout(() => process.exit(0), 10);
`);
  chmodSync(script, 0o755);
  return script;
}

describe("specialist-feed terminal provider", () => {
  it("is readonly, validates job id, streams feed output, and exits", async () => {
    const registry = createTerminalProviderRegistry({
      GITBOARD_SPECIALISTS_BIN: createFeedScript(),
    } as NodeJS.ProcessEnv);
    const provider = registry.get("specialist-feed");

    expect(provider?.enabled).toBe(true);
    await expect(provider?.openSession({ sessionId: "s", capabilities: ["readonly"], jobId: "bad id" })).rejects.toThrow(/invalid specialist job id/);

    const session = await provider?.openSession({ sessionId: "s", capabilities: ["readonly"], jobId: "abc123" });
    expect(session).toBeDefined();
    const output = await new Promise<string>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error("feed timed out")), 1000);
      session?.onOutput((data) => { text += data; });
      session?.onExit(() => { clearTimeout(timer); resolve(text); });
    });

    await session?.input("ignored");
    await session?.resize(120, 40);
    expect(output).toContain("feed:feed abc123 --follow");
  });

  it("does not require shell provider enablement", () => {
    const registry = createTerminalProviderRegistry({ GITBOARD_SHELL_PROVIDER_ENABLED: "0" } as NodeJS.ProcessEnv);

    expect(registry.get("specialist-feed")?.enabled).toBe(true);
    expect(registry.get("pty")?.enabled).toBe(false);
  });
});
