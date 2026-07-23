import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ObservabilityConfig {
  roots: string[];
}

const DEFAULT_SETTINGS_PATH = join(homedir(), ".config/gitboard/observability.json");
export const DEFAULT_ROOTS = ["~/dev/*", "~/projects/*"];

export function getObservabilityConfig(): ObservabilityConfig {
  const envRoots = parseRoots(process.env.OBSERVABILITY_ROOTS);
  if (envRoots.length > 0) return { roots: expandRoots(envRoots) };

  const fileRoots = readSettingsRoots();
  if (fileRoots.length > 0) return { roots: expandRoots(fileRoots) };

  return { roots: expandRoots(DEFAULT_ROOTS) };
}

function parseRoots(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(expandHome);
}

function readSettingsRoots(): string[] {
  if (!existsSync(DEFAULT_SETTINGS_PATH)) return [];

  try {
    const parsed = JSON.parse(readFileSync(DEFAULT_SETTINGS_PATH, "utf-8")) as { roots?: unknown };
    if (!Array.isArray(parsed.roots)) return [];
    return parsed.roots
      .filter((root): root is string => typeof root === "string")
      .map((root) => root.trim())
      .filter(Boolean)
      .map(expandHome);
  } catch {
    return [];
  }
}

function expandRoots(roots: string[]): string[] {
  return roots.flatMap(expandRoot);
}

function expandRoot(root: string): string[] {
  const expanded = expandHome(root);
  if (!expanded.endsWith("/*")) return [expanded];

  const parent = expanded.slice(0, -2);
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name));
  } catch {
    return [];
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (!path.startsWith("~/")) return resolve(path);
  return resolve(join(homedir(), path.slice(2)));
}
