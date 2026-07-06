import { EventEmitter } from "node:events";
import { basename, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import type { ShellProviderPolicy, ShellProviderStatus } from "./policy.ts";

export interface LocalPtyProviderOptions {
  policy: ShellProviderPolicy;
  status: ShellProviderStatus;
  workspaceRoot: string;
  ptyFactory?: PtyFactory;
  now?: () => number;
}

export interface CreateLocalPtySessionRequest {
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
}

export interface LocalPtyOutputEvent {
  sessionId: string;
  data: string;
}

export interface LocalPtyExitEvent {
  sessionId: string;
  exitCode: number | null;
  signal: number | null;
  reason: "exit" | "idle-timeout" | "disposed";
}

export interface LocalPtySessionHandle {
  readonly id: string;
  readonly cwd: string;
  readonly shell: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(reason?: "disposed" | "idle-timeout"): void;
}

export interface PtyLike {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number | null; signal: number | null }) => void): void;
}

export interface PtyFactory {
  create(options: { cwd: string; shell: string; cols: number; rows: number; env: NodeJS.ProcessEnv }): PtyLike;
}

type SessionRecord = {
  handle: LocalPtySessionHandle;
  pty: PtyLike;
  idleTimer: ReturnType<typeof setTimeout> | null;
  hardTimer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
  inputBytes: number;
  outputBytes: number;
  windowStartMs: number;
};

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const FALLBACK_SHELL = "/bin/bash";
const SESSION_PREFIX = "pty";
const ENV_ALLOWLIST = ["TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "PATH", "USER", "LOGNAME", "PWD", "SHELL"];

export class LocalPtyProvider extends EventEmitter {
  private sessions = new Map<string, SessionRecord>();
  private nextSessionId = 1;
  private readonly policy: ShellProviderPolicy;
  private readonly status: ShellProviderStatus;
  private readonly workspaceRoot: string;
  private readonly workspaceRootReal: string;
  private readonly ptyFactory: PtyFactory;
  private readonly now: () => number;

  constructor(options: LocalPtyProviderOptions) {
    super();
    this.policy = options.policy;
    this.status = options.status;
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.workspaceRootReal = this.resolveExistingPath(this.workspaceRoot);
    this.ptyFactory = options.ptyFactory ?? createNativePtyFactory();
    this.now = options.now ?? (() => Date.now());
  }

  createSession(request: CreateLocalPtySessionRequest = {}): LocalPtySessionHandle {
    this.assertCanCreateSession();
    this.assertSessionCapacity();

    const cwd = this.resolveCwd(request.cwd);
    const shell = this.resolveShell(request.shell);
    const cols = request.cols ?? DEFAULT_COLS;
    const rows = request.rows ?? DEFAULT_ROWS;
    const id = `${SESSION_PREFIX}-${this.nextSessionId++}`;
    const env = this.buildSpawnEnv();

    const pty = this.ptyFactory.create({ cwd, shell, cols, rows, env });
    const handle = this.buildHandle(id, cwd, shell);
    const record: SessionRecord = { handle, pty, idleTimer: null, hardTimer: null, disposed: false, inputBytes: 0, outputBytes: 0, windowStartMs: this.now() };
    this.sessions.set(id, record);

    pty.onData((data) => this.forwardOutput(id, data));
    pty.onExit((event) => this.finalizeSession(id, event.exitCode, event.signal, "exit"));
    this.scheduleTimers(id);
    this.emit("session:create", { sessionId: id, cwd, shell });
    return handle;
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  write(sessionId: string, data: string): void {
    const record = this.requireSession(sessionId);
    if (record.disposed) return;
    this.consumeInputBudget(record, Buffer.byteLength(data));
    record.pty.write(data);
    this.touch(sessionId);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const record = this.requireSession(sessionId);
    if (record.disposed) return;
    record.pty.resize(cols, rows);
    this.touch(sessionId);
  }

  disposeSession(sessionId: string, reason: "disposed" | "idle-timeout" = "disposed"): void {
    const record = this.sessions.get(sessionId);
    if (!record || record.disposed) return;
    record.disposed = true;
    this.clearTimers(record);
    record.pty.kill();
    this.sessions.delete(sessionId);
    this.emit("session:exit", { sessionId, exitCode: null, signal: null, reason });
  }

  dispose(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.disposeSession(sessionId, "disposed");
    }
    this.removeAllListeners();
  }

  private buildHandle(id: string, cwd: string, shell: string): LocalPtySessionHandle {
    return {
      id,
      cwd,
      shell,
      write: (data) => this.write(id, data),
      resize: (cols, rows) => this.resize(id, cols, rows),
      dispose: (reason) => this.disposeSession(id, reason),
    };
  }

  private scheduleTimers(sessionId: string): void {
    const record = this.requireSession(sessionId);
    record.idleTimer = setTimeout(() => this.disposeSession(sessionId, "idle-timeout"), this.policy.idleTimeoutMs);
    record.hardTimer = setTimeout(() => this.disposeSession(sessionId, "disposed"), this.policy.hardTtlMs);
  }

  private touch(sessionId: string): void {
    const record = this.requireSession(sessionId);
    if (record.disposed) return;
    if (record.idleTimer) clearTimeout(record.idleTimer);
    record.idleTimer = setTimeout(() => this.disposeSession(sessionId, "idle-timeout"), this.policy.idleTimeoutMs);
    this.emit("session:activity", { sessionId, at: this.now() });
  }

  private forwardOutput(sessionId: string, data: string): void {
    const record = this.sessions.get(sessionId);
    if (!record || record.disposed) return;
    const bytes = Buffer.byteLength(data);
    if (!this.consumeOutputBudget(record, bytes)) {
      this.disposeSession(sessionId, "disposed");
      return;
    }
    this.touch(sessionId);
    this.emit("output", { sessionId, data } satisfies LocalPtyOutputEvent);
  }

  private finalizeSession(sessionId: string, exitCode: number | null, signal: number | null, reason: LocalPtyExitEvent["reason"]): void {
    const record = this.sessions.get(sessionId);
    if (!record || record.disposed) return;
    record.disposed = true;
    this.clearTimers(record);
    this.sessions.delete(sessionId);
    this.emit("exit", { sessionId, exitCode, signal, reason } satisfies LocalPtyExitEvent);
  }

  private clearTimers(record: SessionRecord): void {
    if (record.idleTimer) clearTimeout(record.idleTimer);
    if (record.hardTimer) clearTimeout(record.hardTimer);
  }

  private assertCanCreateSession(): void {
    if (!this.status.enabled) {
      throw new Error(this.status.disabledReason);
    }
  }

  private assertSessionCapacity(): void {
    if (this.sessions.size >= this.policy.maxSessions) {
      throw new Error(`shell session cap reached (${this.policy.maxSessions})`);
    }
  }

  private resolveCwd(requestedCwd?: string): string {
    const candidate = this.resolveExistingPath(resolve(this.workspaceRoot, requestedCwd ?? "."));
    const allowed = this.policy.cwdAllowlist.some((allowedRoot) => this.isWithinPath(candidate, this.resolveExistingPath(resolve(allowedRoot))));
    if (!allowed) {
      throw new Error(`cwd outside allowlist: ${candidate}`);
    }
    return candidate;
  }

  private resolveShell(requestedShell?: string): string {
    const candidate = requestedShell ?? process.env.SHELL ?? FALLBACK_SHELL;
    if (!this.policy.shellAllowlist.includes(candidate)) {
      throw new Error(`shell outside allowlist: ${basename(candidate)}`);
    }
    return candidate;
  }

  private isWithinPath(candidate: string, root: string): boolean {
    return candidate === root || candidate.startsWith(root + sep);
  }

  private resolveExistingPath(pathname: string): string {
    try {
      return realpathSync(pathname);
    } catch {
      throw new Error(`cwd missing or unreadable: ${pathname}`);
    }
  }

  private buildSpawnEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ENV_ALLOWLIST) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    for (const key of this.policy.envScrub) {
      delete env[key];
    }
    env.PWD = this.workspaceRootReal;
    env.SHELL = env.SHELL ?? this.resolveShell(undefined);
    env.TERM = env.TERM ?? "xterm-256color";
    return env;
  }

  private consumeInputBudget(record: SessionRecord, bytes: number): void {
    this.refreshWindow(record);
    record.inputBytes += bytes;
    if (record.inputBytes > this.policy.maxInputBytesPerSecond) {
      const error = this.burstError("input");
      this.disposeSession(record.handle.id, "disposed");
      throw error;
    }
  }

  private consumeOutputBudget(record: SessionRecord, bytes: number): boolean {
    this.refreshWindow(record);
    record.outputBytes += bytes;
    return record.outputBytes <= this.policy.maxOutputBytesPerSecond;
  }

  private refreshWindow(record: SessionRecord): void {
    const now = this.now();
    if (now - record.windowStartMs >= 1000) {
      record.windowStartMs = now;
      record.inputBytes = 0;
      record.outputBytes = 0;
    }
  }

  private burstError(direction: "input" | "output"): Error {
    return new Error(`${direction} rate limit exceeded`);
  }

  private requireSession(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    return record;
  }
}

function createNativePtyFactory(): PtyFactory {
  return {
    create() {
      throw new Error("node-pty unavailable; inject PtyFactory in tests or install native dependency");
    },
  };
}
