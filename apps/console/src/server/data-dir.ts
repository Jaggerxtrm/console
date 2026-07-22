import { homedir } from "node:os";
import { join } from "node:path";

export type DataDirSource = "XTRM_DATA_DIR" | "GITBOARD_DATA_DIR" | "default";

export interface DataDirResolution {
  readonly dataDir: string;
  readonly source: DataDirSource;
  readonly storeDbPath: string;
  readonly legacyFoldDbPath: string;
}

export type ResolveDataDirEnv = Readonly<Record<string, string | undefined>>;

/**
 * Host-neutral data-directory bootstrap seam. Prefers XTRM_DATA_DIR and falls
 * back to the legacy GITBOARD_DATA_DIR so the console host can share the
 * existing on-disk dataset during migration. When neither variable is set the
 * current production default `HOME/.agent-forge` is preserved so production
 * state is never relocated. No database is opened here; later phases consume
 * `storeDbPath` (xtrm.sqlite) and `legacyFoldDbPath` (gitboard.sqlite fold
 * input) when API/materializer wiring moves.
 */
export function resolveDataDir(env: ResolveDataDirEnv = process.env, home: string = homedir()): DataDirResolution {
  const xtrmDir = env.XTRM_DATA_DIR?.trim();
  const legacyDir = env.GITBOARD_DATA_DIR?.trim();

  let dataDir: string;
  let source: DataDirSource;
  if (xtrmDir) {
    dataDir = xtrmDir;
    source = "XTRM_DATA_DIR";
  } else if (legacyDir) {
    dataDir = legacyDir;
    source = "GITBOARD_DATA_DIR";
  } else {
    dataDir = join(home, ".agent-forge");
    source = "default";
  }

  return {
    dataDir,
    source,
    storeDbPath: join(dataDir, "xtrm.sqlite"),
    legacyFoldDbPath: join(dataDir, "gitboard.sqlite"),
  };
}

/**
 * Replaces a leading home-directory segment with `~` so structured logs never
 * carry the raw account-specific path. Paths outside the home dir are returned
 * unchanged.
 */
export function redactHomePath(path: string, home: string = homedir()): string {
  if (home && path === home) return "~";
  if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}
