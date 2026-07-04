import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DoltClient } from "../../core/dolt-client.ts";
import { formatSourceDisplayPath } from "../routes/sources-policy.ts";
import {
  getBeadsSourcePath as coreGetBeadsSourcePath,
  readSourceMaterializationState as coreReadSourceMaterializationState,
} from "../../../../../packages/core/src/state/index.ts";

export type BeadsSourceFacts = {
  repoPath: string;
  projectName: string;
  doltPort?: number;
  doltDatabase?: string;
  doltPid?: number;
  doltPidAlive?: boolean;
  sharedServerEnabled: boolean;
  jsonlUpdatedAt?: string;
};

export type BeadsRepairAction = {
  id: "rescan_source_health" | "inspect_dolt_status" | "start_dolt_server" | "restart_dolt_server" | "recover_port_config" | "remove_dead_pid_file";
  label: string;
  description: string;
  command?: string;
  endpoint?: string;
  available: boolean;
  disabledReason?: string;
};

export async function readSubstrateProjectConnection(db: Database | null | undefined, projectId: string): Promise<Record<string, unknown>> {
  if (!db) return { source: "none", status: "error", degraded: true, error: "xtrm.sqlite unavailable" };
  const row = db.query("SELECT source_key, path FROM sources WHERE kind = 'beads' AND source_key = ?").get(`beads:${projectId}`) as { source_key: string; path: string } | undefined;
  if (!row) return { source: "none", status: "not_found", degraded: true, error: "Project not found" };
  const facts = readBeadsSourceFacts(row.path);
  const state = coreReadSourceMaterializationState(db, row.source_key);
  const base = {
    port: facts.doltPort,
    database: facts.doltDatabase,
    pid: facts.doltPid,
    pid_alive: facts.doltPidAlive,
    jsonl_updated_at: facts.jsonlUpdatedAt,
    last_success_at: state?.last_success_at ?? null,
    last_error: state?.last_error ?? null,
  };
  if (!facts.doltPort) {
    return { ...base, source: "jsonl", status: "jsonl_fallback", degraded: true, note: "No Dolt port configured; reading materialized JSONL backup." };
  }
  const client = createDoltClient(facts);
  try {
    await client.connect();
    return { ...base, source: "dolt", status: "dolt_connected", degraded: state?.last_status === "error", message: state?.last_error ?? `Dolt connected:${facts.doltPort}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = facts.doltPidAlive === false ? "dolt_process_dead" : "dolt_unreachable";
    return { ...base, source: "jsonl", status, degraded: true, error: state?.last_error ?? message, note: "Dolt unavailable; using materialized/JSONL fallback." };
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

export async function readSubstrateProjectRepairActions(db: Database | null | undefined, projectId: string): Promise<{ projectId: string; status: string; actions: BeadsRepairAction[] }> {
  const connection = await readSubstrateProjectConnection(db, projectId);
  const beadsPath = coreGetBeadsSourcePath(db, projectId);
  const facts = beadsPath ? readBeadsSourceFacts(beadsPath) : null;
  const projectRef = facts?.repoPath ? formatSourceDisplayPath(facts.repoPath) : "<repo>";
  const bd = `bd -C ${shellQuote(projectRef)} dolt`;
  const status = String(connection.status ?? "error");
  const hasProject = facts != null;
  const hasPort = facts?.doltPort != null;
  const deadPid = facts?.doltPid != null && facts.doltPidAlive === false;
  const sharedPortPath = "~/.beads/shared-server/dolt-server.port";
  const localPortPath = ".beads/dolt-server.port";

  return {
    projectId,
    status,
    actions: [
      {
        id: "rescan_source_health",
        label: "Rescan source health",
        description: "Refresh the project connection probe and source-health projection without mutating Beads data.",
        endpoint: `/api/substrate/projects/${encodeURIComponent(projectId)}/connection`,
        available: hasProject,
        disabledReason: hasProject ? undefined : "Project not found",
      },
      {
        id: "inspect_dolt_status",
        label: "Inspect Dolt status",
        description: "Check the Dolt server configuration and connection from the project directory.",
        command: `${bd} status && ${bd} show`,
        available: hasProject,
        disabledReason: hasProject ? undefined : "Project not found",
      },
      {
        id: "start_dolt_server",
        label: "Start Dolt server",
        description: "Start the project Dolt SQL server when no reachable server is detected.",
        command: `${bd} start && ${bd} test`,
        available: hasProject && !hasPort,
        disabledReason: hasProject && hasPort ? "Dolt port is already configured; use restart if it is unreachable." : hasProject ? undefined : "Project not found",
      },
      {
        id: "restart_dolt_server",
        label: "Restart Dolt server",
        description: "Restart Dolt when the configured port is unreachable or the pid file points at a dead process.",
        command: `${bd} stop && ${bd} start && ${bd} test`,
        available: hasProject && hasPort && status !== "dolt_connected",
        disabledReason: hasProject && status === "dolt_connected" ? "Dolt is currently reachable." : hasProject ? undefined : "Project not found",
      },
      {
        id: "recover_port_config",
        label: "Recover port config",
        description: facts?.sharedServerEnabled
          ? "Shared-server repos read their port from the user-level shared-server file."
          : "Project-local repos should have a Dolt port recorded in .beads config or the local port file.",
        command: facts?.sharedServerEnabled
          ? `test -s ${sharedPortPath} && cat ${sharedPortPath} || bd dolt start`
          : `test -s ${localPortPath} && cat ${localPortPath} || ${bd} start`,
        available: hasProject && !hasPort,
        disabledReason: hasProject && hasPort ? `Port ${facts?.doltPort} is already configured.` : hasProject ? undefined : "Project not found",
      },
      {
        id: "remove_dead_pid_file",
        label: "Remove dead pid file",
        description: "Clear stale Dolt pid files only after the pid is confirmed dead, then restart Dolt.",
        command: facts?.sharedServerEnabled
          ? "rm -f ~/.beads/shared-server/dolt-server.pid && bd dolt start"
          : `rm -f .beads/dolt-server.pid && ${bd} start`,
        available: hasProject && deadPid,
        disabledReason: hasProject && !deadPid ? "No dead Dolt pid file detected." : hasProject ? undefined : "Project not found",
      },
    ],
  };
}

export function readBeadsSourceFacts(beadsPath: string): BeadsSourceFacts {
  const repoPath = beadsPath.endsWith("/.beads") ? dirname(beadsPath) : beadsPath;
  const projectName = repoPath.split("/").filter(Boolean).at(-1) ?? beadsPath;
  const metadata = readJsonFile(join(beadsPath, "metadata.json"));
  const config = readTextFile(join(beadsPath, "config.yaml")) ?? "";
  const sharedServerEnabled = /dolt\.shared-server:\s*true|shared-server:\s*true/.test(config);
  const configuredPort = numberFromMatch(config.match(/port:\s*(\d+)/));
  const sharedPort = sharedServerEnabled ? readSharedServerPort() : undefined;
  const doltPort = sharedPort ?? (sharedServerEnabled ? undefined : configuredPort);
  const doltDatabase = stringFromMatch(config.match(/dolt_database:\s*(\S+)/)) ?? stringFromRecord(metadata, "dolt_database");
  const doltPid = readDoltPid(beadsPath);
  return {
    repoPath,
    projectName,
    doltPort,
    doltDatabase,
    doltPid,
    doltPidAlive: isPidAlive(doltPid),
    sharedServerEnabled,
    jsonlUpdatedAt: mtimeIso(join(beadsPath, "issues.jsonl")),
  };
}

function createDoltClient(facts: BeadsSourceFacts): DoltClient {
  return new DoltClient({ host: process.env.DOLT_HOST ?? defaultDoltHost(), port: facts.doltPort ?? 0, database: facts.doltDatabase ?? "dolt" });
}

function defaultDoltHost(): string {
  return process.env.XDG_PROJECTS_DIR ? "host.docker.internal" : "127.0.0.1";
}

function readSharedServerPort(): number | undefined {
  const path = process.env.HOME ? join(process.env.HOME, ".beads/shared-server/dolt-server.port") : null;
  if (!path) return undefined;
  const value = Number(readTextFile(path)?.trim());
  return Number.isFinite(value) ? value : undefined;
}

function readDoltPid(beadsPath: string): number | undefined {
  const candidates = [
    join(beadsPath, "dolt-server.pid"),
    process.env.HOME ? join(process.env.HOME, ".beads/shared-server/dolt-server.pid") : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const value = Number(readTextFile(candidate)?.trim());
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function isPidAlive(pid: number | undefined): boolean | undefined {
  if (pid == null) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function readTextFile(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function readJsonFile(path: string): Record<string, unknown> | null {
  const text = readTextFile(path);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function mtimeIso(path: string): string | undefined {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function numberFromMatch(match: RegExpMatchArray | null): number | undefined {
  const value = match?.[1] == null ? NaN : Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function stringFromMatch(match: RegExpMatchArray | null): string | undefined {
  return match?.[1] || undefined;
}

function stringFromRecord(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
