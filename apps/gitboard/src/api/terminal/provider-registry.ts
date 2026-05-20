import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { TerminalCapability, TerminalProviderKind } from "../../../../../packages/core/src/terminal/protocol.ts";
import { getShellProviderStatus, type ShellProviderPolicy, type ShellProviderStatus } from "../../core/shell-provider-policy.ts";

export interface TerminalProviderSession {
  onOutput(listener: (data: string) => void): () => void;
  onExit(listener: (code: number | null, signal: string | null) => void): () => void;
  input(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  dispose(reason: string): Promise<void>;
}

export interface TerminalProvider {
  kind: TerminalProviderKind;
  enabled: boolean;
  reason?: string;
  openSession(args: { sessionId: string; capabilities: TerminalCapability[]; jobId?: string }): Promise<TerminalProviderSession>;
}

export interface TerminalProviderRegistry {
  list(context?: { isVerifiedAdmin?: boolean }): Array<Pick<TerminalProvider, "kind" | "enabled" | "reason">>;
  get(kind: TerminalProviderKind, context?: { isVerifiedAdmin?: boolean }): TerminalProvider | undefined;
}

type HelperMessage =
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null; signal: string | null }
  | { type: "error"; message: string };

const SPECIALIST_JOB_ID_RE = /^[A-Za-z0-9._:-]{3,128}$/;

export function createTerminalProviderRegistry(env: NodeJS.ProcessEnv = process.env): TerminalProviderRegistry {
  const repoRoot = process.cwd().endsWith("/apps/gitboard") ? join(process.cwd(), "../..") : process.cwd();
  const createProviders = (context: { isVerifiedAdmin?: boolean } = {}): TerminalProvider[] => {
    const shellStatus = getShellProviderStatus(env, { isVerifiedAdmin: context.isVerifiedAdmin === true });
    return [
      createSpecialistFeedTerminalProvider(env),
      createNodePtyTerminalProvider(shellStatus, repoRoot, env),
      { kind: "tmux", enabled: false, reason: "provider disabled", openSession: async () => { throw new Error("provider disabled"); } },
      { kind: "ssh", enabled: false, reason: "provider disabled", openSession: async () => { throw new Error("provider disabled"); } },
      { kind: "command", enabled: false, reason: "provider disabled", openSession: async () => { throw new Error("provider disabled"); } },
    ];
  };
  return {
    list: (context) => createProviders(context).map(({ kind, enabled, reason }) => ({ kind, enabled, reason })),
    get: (kind, context) => createProviders(context).find((provider) => provider.kind === kind),
  };
}

function createSpecialistFeedTerminalProvider(env: NodeJS.ProcessEnv): TerminalProvider {
  const command = env.GITBOARD_SPECIALISTS_BIN || "specialists";
  return {
    kind: "specialist-feed",
    enabled: true,
    reason: "readonly specialist feed",
    openSession: async ({ jobId }) => {
      if (!jobId || !SPECIALIST_JOB_ID_RE.test(jobId)) throw new Error("invalid specialist job id");
      const child = spawn(command, ["feed", jobId, "--follow"], {
        env: buildSpecialistFeedEnv(env),
        stdio: "pipe",
      });
      return new ChildProcessTerminalSession(child, { allowInput: false, allowResize: false });
    },
  };
}

function createNodePtyTerminalProvider(status: ShellProviderStatus, repoRoot: string, env: NodeJS.ProcessEnv): TerminalProvider {
  const helperPath = join(repoRoot, "apps/gitboard/src/api/terminal/node-pty-helper.cjs");
  const nodeBinary = env.GITBOARD_TERMINAL_NODE_BINARY || "node";
  const available = status.enabled && existsSync(helperPath);

  return {
    kind: "pty",
    enabled: available,
    reason: status.enabled ? (available ? "node-pty helper" : "node-pty helper unavailable") : status.disabledReason,
    openSession: async () => {
      const policy = status.policy;
      const cwd = resolveAllowedCwd(policy, repoRoot);
      const shell = resolveShell(policy);
      const args = ["-i"];
      const config = Buffer.from(JSON.stringify({
        shell,
        args,
        cwd,
        cols: 80,
        rows: 24,
        env: buildSpawnEnv(policy, cwd, shell),
      }), "utf8").toString("base64url");
      const child = spawn(nodeBinary, [helperPath], {
        cwd,
        env: { GITBOARD_TERMINAL_PTY_CONFIG: config, PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stdio: "pipe",
      });
      return new NodePtyHelperSession(child);
    },
  };
}

class ChildProcessTerminalSession implements TerminalProviderSession {
  private readonly events = new EventEmitter();
  private disposed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: { allowInput: boolean; allowResize: boolean },
  ) {
    this.child.stdout.on("data", (data) => this.emitOutput(data.toString("utf8")));
    this.child.stderr.on("data", (data) => this.emitOutput(data.toString("utf8")));
    this.child.on("exit", (code, signal) => {
      this.disposed = true;
      this.events.emit("exit", code, signal);
    });
    this.child.on("error", (error) => {
      this.emitOutput(`terminal process error: ${error.message}\r\n`);
      this.events.emit("exit", 1, null);
    });
  }

  onOutput(listener: (data: string) => void): () => void {
    this.events.on("output", listener);
    return () => this.events.off("output", listener);
  }

  onExit(listener: (code: number | null, signal: string | null) => void): () => void {
    this.events.on("exit", listener);
    return () => this.events.off("exit", listener);
  }

  async input(data: string): Promise<void> {
    if (this.disposed || !this.options.allowInput) return;
    this.child.stdin.write(data);
  }

  async resize(_cols: number, _rows: number): Promise<void> {
    // Readonly specialist-feed streams are not resizable.
  }

  async dispose(_reason: string): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.child.kill("SIGTERM");
  }

  private emitOutput(data: string): void {
    if (!this.disposed) this.events.emit("output", data);
  }
}

class NodePtyHelperSession implements TerminalProviderSession {
  private readonly events = new EventEmitter();
  private buffer = "";
  private disposed = false;
  private sawExit = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.child.stdout.on("data", (data) => this.consumeStdout(data.toString("utf8")));
    this.child.stderr.on("data", (data) => this.emitOutput(data.toString("utf8")));
    this.child.on("exit", (code, signal) => {
      this.disposed = true;
      if (!this.sawExit) this.events.emit("exit", code, signal);
    });
    this.child.on("error", (error) => this.emitOutput(`terminal helper error: ${error.message}\r\n`));
  }

  onOutput(listener: (data: string) => void): () => void {
    this.events.on("output", listener);
    return () => this.events.off("output", listener);
  }

  onExit(listener: (code: number | null, signal: string | null) => void): () => void {
    this.events.on("exit", listener);
    return () => this.events.off("exit", listener);
  }

  async input(data: string): Promise<void> {
    this.send({ type: "input", data: Buffer.from(data, "utf8").toString("base64") });
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.send({ type: "resize", cols, rows });
  }

  async dispose(_reason: string): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.send({ type: "dispose" });
    setTimeout(() => {
      if (!this.child.killed) this.child.kill("SIGTERM");
    }, 250);
  }

  private send(message: unknown): void {
    if (!this.disposed && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consumeStdout(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeHelperLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private consumeHelperLine(line: string): void {
    let message: HelperMessage;
    try {
      message = JSON.parse(line) as HelperMessage;
    } catch {
      this.emitOutput(`${line}\r\n`);
      return;
    }

    if (message.type === "output") {
      this.emitOutput(Buffer.from(message.data, "base64").toString("utf8"));
      return;
    }
    if (message.type === "exit") {
      this.sawExit = true;
      this.disposed = true;
      this.events.emit("exit", message.code, message.signal);
      return;
    }
    if (message.type === "error") {
      this.emitOutput(`terminal helper error: ${message.message}\r\n`);
    }
  }

  private emitOutput(data: string): void {
    if (!this.disposed) this.events.emit("output", data);
  }
}

function resolveAllowedCwd(policy: ShellProviderPolicy, repoRoot: string): string {
  const candidate = realpathSync(resolve(repoRoot));
  const allowed = policy.cwdAllowlist.some((allowedRoot) => {
    const root = realpathSync(resolve(allowedRoot));
    return candidate === root || candidate.startsWith(root + sep);
  });
  if (!allowed) throw new Error(`cwd outside allowlist: ${candidate}`);
  return candidate;
}

function resolveShell(policy: ShellProviderPolicy): string {
  const candidate = process.env.SHELL || "/bin/bash";
  if (policy.shellAllowlist.includes(candidate)) return candidate;
  const fallback = policy.shellAllowlist[0];
  if (!fallback) throw new Error(`shell outside allowlist: ${basename(candidate)}`);
  return fallback;
}

function buildSpecialistFeedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    HOME: env.HOME,
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    USER: env.USER,
    LOGNAME: env.LOGNAME,
    LANG: env.LANG,
    LC_ALL: env.LC_ALL,
    LC_CTYPE: env.LC_CTYPE,
    TERM: "xterm-256color",
  };
}

function buildSpawnEnv(policy: ShellProviderPolicy, cwd: string, shell: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const inheritedKeys = [
    "HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "COLORTERM",
    "TMPDIR",
    "ZDOTDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "NVM_DIR",
    "BUN_INSTALL",
  ];
  for (const key of inheritedKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const key of policy.envScrub) delete env[key];
  env.PATH = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  env.HOME = process.env.HOME;
  env.PWD = cwd;
  env.SHELL = shell;
  env.TERM = "xterm-256color";
  return env;
}
