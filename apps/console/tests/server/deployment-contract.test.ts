import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("Console production deployment contract", () => {
  it("starts the Console host from the checked-in systemd unit", () => {
    const unit = readFileSync(join(ROOT, "deploy/systemd/console.service"), "utf8");
    expect(unit).toContain("ExecStart=%h/.bun/bin/bun %h/dev/console/apps/console/src/server/index.ts");
    expect(unit).not.toContain("Environment=XTRM_DATA_DIR=");
    expect(unit).toContain("EnvironmentFile=-%h/.config/xtrm/console.env");
    expect(unit).not.toContain("apps/gitboard");
  });

  it("uses the Console host in package and container entrypoints", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
    const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");

    expect(manifest.scripts["start:console"]).toBe("bun run apps/console/src/server/index.ts");
    expect(dockerfile).toContain('CMD ["bun", "apps/console/src/server/index.ts"]');
    expect(dockerfile).toContain("RUN bun install --frozen-lockfile");
    expect(dockerfile).toContain("COPY --from=builder /app/node_modules /app/node_modules");
    expect(compose).toContain("XTRM_DATA_DIR: /data");
    expect(compose).toContain("- gitboard-state:/data");
    expect(`${dockerfile}\n${compose}`).not.toContain("apps/gitboard");
  });
});
