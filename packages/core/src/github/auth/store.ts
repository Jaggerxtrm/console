/**
 * Token storage for the signed-in GitHub App user token.
 *
 * Backends (first available wins):
 *  - keychain: host Secret Service via libsecret, driven through the `secret-tool` CLI
 *  - file: JSON record at <baseDir>/github-user-token.json, mode 0600 in a 0700 dir
 *
 * The record contains the access token, refresh token, expiry metadata and the
 * cached user identity. Only ever the secret store sees these values: they are
 * never written to SQLite, logs, or HTTP responses.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export type TokenStoreKind = "keychain" | "file";

export interface StoredUserToken {
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null; // ISO; null when the app disabled token expiration
  refresh_expires_at: string | null;
  obtained_at: string;
  user: { login: string; name: string | null; avatar_url: string | null } | null;
}

export interface TokenStore {
  readonly kind: TokenStoreKind;
  get(): Promise<StoredUserToken | null>;
  set(record: StoredUserToken): Promise<void>;
  delete(): Promise<void>;
}

export function createFileTokenStore(baseDir = join(homedir(), ".xtrm", "secrets")): TokenStore {
  const file = join(baseDir, "github-user-token.json");
  return {
    kind: "file",
    async get() {
      try {
        const raw = await readFile(file, "utf8");
        const parsed = JSON.parse(raw) as StoredUserToken;
        return typeof parsed.access_token === "string" ? parsed : null;
      } catch {
        return null;
      }
    },
    async set(record) {
      await mkdir(baseDir, { recursive: true, mode: 0o700 });
      await writeFile(file, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    },
    async delete() {
      await rm(file, { force: true });
    },
  };
}

const SECRET_TOOL_ATTRIBUTES = ["service", "xtrm-console", "account", "github-user"];

/** Run secret-tool asynchronously; never blocks the event loop. */
function runSecretTool(args: string[], stdin?: string): Promise<{ exitCode: number; stdout: string } | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = Bun.spawn(["secret-tool", ...args], {
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
        stdout: "pipe",
        stderr: "ignore",
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      resolve(null);
    }, 2000);
    void child.exited.then(async (exitCode) => {
      clearTimeout(timer);
      if (exitCode !== 0) {
        resolve({ exitCode, stdout: "" });
        return;
      }
      const output = new Response(child.stdout).text();
      resolve({ exitCode, stdout: await output });
    }).catch(() => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** Host Secret Service (libsecret/D-Bus) via the `secret-tool` CLI. */
export function createSecretToolStore(): TokenStore {
  const args = (verb: "lookup" | "store" | "clear") =>
    verb === "store"
      ? ["store", "--label=xtrm-console github user token", ...SECRET_TOOL_ATTRIBUTES]
      : [verb, ...SECRET_TOOL_ATTRIBUTES];
  return {
    kind: "keychain",
    async get() {
      const result = await runSecretTool(args("lookup"));
      if (!result || result.stdout.length === 0) return null;
      try {
        const parsed = JSON.parse(result.stdout) as StoredUserToken;
        return typeof parsed.access_token === "string" ? parsed : null;
      } catch {
        return null;
      }
    },
    async set(record) {
      const result = await runSecretTool(args("store"), JSON.stringify(record));
      if (!result || result.exitCode !== 0) throw new Error("secret-tool store failed");
    },
    async delete() {
      await runSecretTool(args("clear"));
    },
  };
}

let secretToolAvailable: Promise<boolean> | null = null;

/** `secret-tool` responds to --version only when libsecret + D-Bus are usable. */
export function isSecretToolAvailable(): Promise<boolean> {
  if (!secretToolAvailable) {
    secretToolAvailable = runSecretTool(["--version"]).then((result) => result !== null);
  }
  return secretToolAvailable;
}

let resolvedDefaultStore: TokenStore | null = null;

/**
 * Resolve the default store: XTRM_GITHUB_TOKEN_STORE=file forces the file
 * backend; otherwise the Secret Service is used when available. The decision
 * is made lazily and at most once per process (per forced-file base dir).
 */
export async function resolveTokenStore(env: NodeJS.ProcessEnv, baseDir?: string): Promise<TokenStore> {
  if (env.XTRM_GITHUB_TOKEN_STORE === "file") return createFileTokenStore(baseDir);
  if (!resolvedDefaultStore) {
    resolvedDefaultStore = (await isSecretToolAvailable()) ? createSecretToolStore() : createFileTokenStore(baseDir);
  }
  return resolvedDefaultStore;
}
