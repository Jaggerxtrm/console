import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import type { TerminalCapability, TerminalProviderKind } from "./protocol.ts";
import { getShellProviderStatus, type ShellProviderPolicy, type ShellProviderStatus } from "./policy.ts";

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
  openSession(args: { sessionId: string; capabilities: TerminalCapability[]; jobId?: string; cwd?: string }): Promise<TerminalProviderSession>;
}

export interface TerminalProviderRegistry {
  list(context?: { isVerifiedAdmin?: boolean }): Array<Pick<TerminalProvider, "kind" | "enabled" | "reason">>;
  get(kind: TerminalProviderKind, context?: { isVerifiedAdmin?: boolean }): TerminalProvider | undefined;
}

export interface TerminalProviderRegistryOptions {
  readonly repoRoot?: string;
  readonly ptyHelperPath?: string;
}

type HelperMessage =
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null; signal: string | null }
  | { type: "error"; message: string };

const SPECIALIST_JOB_ID_RE = /^[A-Za-z0-9._:-]{3,128}$/;

export function createTerminalProviderRegistry(
  env: NodeJS.ProcessEnv = process.env,
  options: TerminalProviderRegistryOptions = {},
): TerminalProviderRegistry {
  const repoRoot = options.repoRoot ?? inferRepoRoot(process.cwd());
  const helperPath = options.ptyHelperPath ?? env.XTRM_TERMINAL_PTY_HELPER_PATH?.trim() ?? "";
  const ptySessions = new Set<NodePtyHelperSession>();
  const createProviders = (context: { isVerifiedAdmin?: boolean } = {}): TerminalProvider[] => {
    const shellStatus = getShellProviderStatus(env, { isVerifiedAdmin: context.isVerifiedAdmin === true });
    return [
      createSpecialistFeedTerminalProvider(env, context),
      createNodePtyTerminalProvider(shellStatus, repoRoot, helperPath, env, ptySessions),
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

function createSpecialistFeedTerminalProvider(env: NodeJS.ProcessEnv, context: { isVerifiedAdmin?: boolean } = {}): TerminalProvider {
  const command = env.GITBOARD_SPECIALISTS_BIN || "specialists";
  const isVerifiedAdmin = context.isVerifiedAdmin === true;
  return {
    kind: "specialist-feed",
    enabled: isVerifiedAdmin,
    reason: isVerifiedAdmin ? "readonly specialist feed" : "verified admin required for specialist feed",
    openSession: async ({ jobId }) => {
      if (!isVerifiedAdmin) throw new Error("verified admin required for specialist feed");
      if (!jobId || !SPECIALIST_JOB_ID_RE.test(jobId)) throw new Error("invalid specialist job id");
      const child = spawn(command, ["feed", jobId, "--follow"], {
        env: buildSpecialistFeedEnv(env),
        stdio: "pipe",
      });
      return new ChildProcessTerminalSession(child, { allowInput: false, allowResize: false });
    },
  };
}

function createNodePtyTerminalProvider(
  status: ShellProviderStatus,
  repoRoot: string,
  helperPath: string,
  env: NodeJS.ProcessEnv,
  sessions: Set<NodePtyHelperSession>,
): TerminalProvider {
  const nodeBinary = env.GITBOARD_TERMINAL_NODE_BINARY || "node";
  const available = status.enabled && helperPath.length > 0 && existsSync(helperPath);

  return {
    kind: "pty",
    enabled: available,
    reason: status.enabled ? (available ? "node-pty helper" : "node-pty helper unavailable") : status.disabledReason,
    openSession: async ({ cwd: requestedCwd }) => {
      const policy = status.policy;
      if (sessions.size >= policy.maxSessions) throw new Error("shell session cap reached");
      const cwd = resolveAllowedCwd(policy, repoRoot, requestedCwd);
      const shell = resolveShell(policy, env);
      const args = ["-i"];
      const config = Buffer.from(JSON.stringify({
        shell,
        args,
        cwd,
        cols: 80,
        rows: 24,
        env: buildSpawnEnv(policy, cwd, shell, env),
      }), "utf8").toString("base64url");
      const child = spawn(nodeBinary, [helperPath], {
        cwd,
        env: { GITBOARD_TERMINAL_PTY_CONFIG: config, PATH: env.PATH ?? "/usr/bin:/bin" },
        stdio: "pipe",
      });
      const session = new NodePtyHelperSession(child, policy, () => sessions.delete(session));
      sessions.add(session);
      return session;
    },
  };
}

class ChildProcessTerminalSession implements TerminalProviderSession {
  private readonly events = new EventEmitter();
  private disposed = false;
  private finished = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly terminated: Promise<void>;
  private resolveTerminated!: () => void;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: { allowInput: boolean; allowResize: boolean },
  ) {
    this.terminated = new Promise((resolve) => { this.resolveTerminated = resolve; });
    this.child.stdout.on("data", (data) => this.emitOutput(data.toString("utf8")));
    this.child.stderr.on("data", (data) => this.emitOutput(data.toString("utf8")));
    this.child.on("exit", (code, signal) => this.finish(code, signal));
    this.child.on("error", () => {
      this.emitOutput("terminal process failed\r\n");
      this.finish(1, null);
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
    if (!this.disposed) {
      this.disposed = true;
      this.child.kill("SIGTERM");
      this.killTimer = setTimeout(() => {
        if (!this.finished) this.child.kill("SIGKILL");
      }, 500);
      this.killTimer.unref?.();
    }
    await this.terminated;
  }

  private emitOutput(data: string): void {
    if (!this.disposed) this.events.emit("output", data);
  }

  private finish(code: number | null, signal: string | null): void {
    if (this.finished) return;
    this.finished = true;
    this.disposed = true;
    if (this.killTimer) clearTimeout(this.killTimer);
    this.events.emit("exit", code, signal);
    this.resolveTerminated();
  }
}

class NodePtyHelperSession implements TerminalProviderSession {
  private readonly events = new EventEmitter();
  private buffer = "";
  private disposed = false;
  private sawExit = false;
  private reportedExit: { code: number | null; signal: string | null } | null = null;
  private released = false;
  private inputBytes = 0;
  private outputBytes = 0;
  private windowStartedAt = Date.now();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private hardTimer: ReturnType<typeof setTimeout> | null = null;
  private terminateTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly terminated: Promise<void>;
  private resolveTerminated!: () => void;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly policy: ShellProviderPolicy,
    private readonly onRelease: () => void,
  ) {
    this.terminated = new Promise((resolve) => { this.resolveTerminated = resolve; });
    this.child.stdout.on("data", (data) => this.consumeStdout(data.toString("utf8")));
    this.child.stderr.once("data", () => this.failHelper());
    this.child.on("close", (code, signal) => this.finishProcess(code, signal));
    this.child.on("error", () => this.failHelper());
    this.scheduleTimers();
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
    if (this.disposed) return;
    this.consumeBudget("input", Buffer.byteLength(data));
    this.send({ type: "input", data: Buffer.from(data, "utf8").toString("base64") });
    this.touch();
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (this.disposed) return;
    this.send({ type: "resize", cols: clamp(cols, 2, 500), rows: clamp(rows, 1, 200) });
    this.touch();
  }

  async dispose(_reason: string): Promise<void> {
    if (!this.disposed) {
      this.send({ type: "dispose" });
      this.disposed = true;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (this.hardTimer) clearTimeout(this.hardTimer);
      this.terminateTimer = setTimeout(() => this.killChild("SIGTERM"), 250);
      this.killTimer = setTimeout(() => this.killChild("SIGKILL"), 1_000);
      this.terminateTimer.unref?.();
      this.killTimer.unref?.();
    }
    await this.terminated;
  }

  private send(message: unknown): void {
    if (!this.disposed && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consumeStdout(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > this.policy.maxOutputBytesPerSecond * 2 + 4096) {
      this.buffer = "";
      this.failHelper();
      return;
    }
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
      this.failHelper();
      return;
    }

    if (message.type === "output" && typeof message.data === "string") {
      const output = Buffer.from(message.data, "base64").toString("utf8");
      try {
        this.consumeBudget("output", Buffer.byteLength(output));
      } catch {
        void this.dispose("output_rate_limit");
        return;
      }
      this.emitOutput(output);
      this.touch();
      return;
    }
    if (message.type === "exit" && (typeof message.code === "number" || message.code === null) && (typeof message.signal === "string" || message.signal === null)) {
      this.reportedExit = { code: message.code, signal: message.signal };
      void this.dispose("pty_exit");
      return;
    }
    if (message.type === "error") {
      this.failHelper();
      return;
    }
    this.failHelper();
  }

  private emitOutput(data: string): void {
    if (!this.disposed) this.events.emit("output", data);
  }

  private failHelper(): void {
    if (this.disposed) return;
    this.emitOutput("terminal helper failed\r\n");
    this.reportedExit = { code: 1, signal: null };
    void this.dispose("helper_error");
  }

  private scheduleTimers(): void {
    this.idleTimer = setTimeout(() => void this.dispose("idle_timeout"), this.policy.idleTimeoutMs);
    this.hardTimer = setTimeout(() => void this.dispose("hard_ttl"), this.policy.hardTtlMs);
    this.idleTimer.unref?.();
    this.hardTimer.unref?.();
  }

  private touch(): void {
    if (this.disposed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.dispose("idle_timeout"), this.policy.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private consumeBudget(direction: "input" | "output", bytes: number): void {
    const now = Date.now();
    if (now - this.windowStartedAt >= 1_000) {
      this.windowStartedAt = now;
      this.inputBytes = 0;
      this.outputBytes = 0;
    }
    if (direction === "input") {
      this.inputBytes += bytes;
      if (this.inputBytes > this.policy.maxInputBytesPerSecond) {
        void this.dispose("input_rate_limit");
        throw new Error("input rate limit exceeded");
      }
      return;
    }
    this.outputBytes += bytes;
    if (this.outputBytes > this.policy.maxOutputBytesPerSecond) throw new Error("output rate limit exceeded");
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.hardTimer) clearTimeout(this.hardTimer);
    if (this.terminateTimer) clearTimeout(this.terminateTimer);
    if (this.killTimer) clearTimeout(this.killTimer);
    this.onRelease();
    this.resolveTerminated();
  }

  private finishProcess(code: number | null, signal: string | null): void {
    this.disposed = true;
    if (!this.sawExit) {
      this.sawExit = true;
      const exit = this.reportedExit ?? { code, signal };
      this.events.emit("exit", exit.code, exit.signal);
    }
    this.release();
  }

  private killChild(signal: NodeJS.Signals): void {
    if (this.released) return;
    try {
      this.child.kill(signal);
    } catch {
      // The close/error handlers own final release.
    }
  }
}

function resolveAllowedCwd(policy: ShellProviderPolicy, repoRoot: string, requestedCwd?: string): string {
  const candidate = realpathSync(resolve(repoRoot, requestedCwd ?? "."));
  const allowed = policy.cwdAllowlist.some((allowedRoot) => {
    const root = realpathSync(resolve(allowedRoot));
    return candidate === root || candidate.startsWith(root + sep);
  });
  if (!allowed) throw new Error(`cwd outside allowlist: ${candidate}`);
  return candidate;
}

function inferRepoRoot(cwd: string): string {
  const normalized = resolve(cwd);
  return /[/\\]apps[/\\](?:console|gitboard)$/.test(normalized) ? resolve(normalized, "../..") : normalized;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function resolveShell(policy: ShellProviderPolicy, runtimeEnv: NodeJS.ProcessEnv): string {
  const candidate = runtimeEnv.SHELL || "/bin/bash";
  if (policy.shellAllowlist.includes(candidate)) return candidate;
  throw new Error(`shell outside allowlist: ${basename(candidate)}`);
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

function buildSpawnEnv(
  policy: ShellProviderPolicy,
  cwd: string,
  shell: string,
  runtimeEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
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
    if (runtimeEnv[key] !== undefined) env[key] = runtimeEnv[key];
  }
  env.PATH = runtimeEnv.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  env.HOME = runtimeEnv.HOME;
  env.PWD = cwd;
  env.SHELL = shell;
  env.TERM = "xterm-256color";
  for (const key of policy.envScrub) delete env[key];
  return env;
}
