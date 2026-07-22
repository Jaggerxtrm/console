import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type PackageManifest = {
  dependencies?: Record<string, string>;
};

const repoRoot = join(import.meta.dirname, "../../../../");
const readText = (path: string) => readFileSync(join(repoRoot, path), "utf8");
const readManifest = (path: string) => JSON.parse(readText(path)) as PackageManifest;
const lock = readText("bun.lock");

describe("security dependency resolutions", () => {
  it("keeps happy-dom transitive ws pinned at advisory-fixed version", () => {
    expect(lock).toContain('"ws": "8.21.0"');
    expect(lock).toContain('"ws": ["ws@8.21.0"');
    expect(lock).toContain('"happy-dom": ["happy-dom@20.8.4"');
    expect(lock).toContain('"ws": "^8.18.3"');
  });

  it("keeps both direct Hono consumers on advisory-fixed resolution", () => {
    expect(readManifest("apps/gitboard/package.json").dependencies?.hono).toBe("^4.12.27");
    expect(readManifest("packages/html-preview/package.json").dependencies?.hono).toBe("^4.12.27");
    expect(lock).toContain('"hono": "4.12.27"');
    expect(lock).toContain('"hono": ["hono@4.12.27"');
  });
});
