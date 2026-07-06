import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { logClientEvent } from "../../../lib/client-log.ts";

const LEAF_META: Record<string, { kind: "string" | "number" | "boolean" | "array" | "enum"; enumValues?: string[] }> = {
  "execution.model": { kind: "string" },
  "execution.fallback_model": { kind: "string" },
  "execution.fallback_models": { kind: "array" },
  "execution.timeout_ms": { kind: "number" },
  "execution.stall_timeout_ms": { kind: "number" },
  "execution.interactive": { kind: "boolean" },
  "execution.thinking_level": { kind: "enum", enumValues: ["off", "minimal", "low", "medium", "high", "xhigh"] },
  "execution.max_retries": { kind: "number" },
  "execution.prompt_limit_bytes": { kind: "number" },
  "execution.stdout_limit_bytes": { kind: "number" },
  "execution.extensions.serena": { kind: "boolean" },
  "execution.extensions.gitnexus": { kind: "boolean" },
  "prompt.system_prompt_mode": { kind: "enum", enumValues: ["append", "replace"] },
  "stall_detection.waiting_auto_close_ms": { kind: "number" },
  "beads_write_notes": { kind: "boolean" },
  "notes_mode": { kind: "enum", enumValues: ["full-trail", "final-only"] },
  "output_file": { kind: "string" },
  "skills.paths": { kind: "array" },
};

type Snapshot = {
  host: { label: string; scope: string };
  specialists: Array<{ name: string }>;
  userConfig: {
    path: string;
    displayPath: string;
    mtimeMs?: number;
    content: Record<string, unknown>;
    validationErrors: Array<{ path: string; message: string }>;
    leafPaths: string[];
  };
  consoleConfig: {
    path: string;
    displayPath: string;
    mtimeMs?: number;
    content: { base_dirs: string[]; repos: Array<{ name: string; path: string }> };
  };
};

export interface SpecialistConfigEditorProps {
  hostLabel: string;
  apiBasePath?: string;
}

export function SpecialistConfigEditor({ hostLabel, apiBasePath = "/api/specialists/config" }: SpecialistConfigEditorProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selectedSpecialist, setSelectedSpecialist] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void loadSnapshot();
    logClientEvent("specialist.config.mount", { hostLabel, apiBasePath });
  }, [apiBasePath, hostLabel]);

  useEffect(() => {
    if (!snapshot?.specialists.length) return;
    if (snapshot.specialists.some((entry) => entry.name === selectedSpecialist)) return;
    setSelectedSpecialist(snapshot.specialists[0]!.name);
  }, [selectedSpecialist, snapshot]);

  const selectedOverride = useMemo(() => readSpecialist(snapshot?.userConfig.content, selectedSpecialist), [selectedSpecialist, snapshot]);

  async function loadSnapshot() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(apiBasePath);
      if (!res.ok) {
        setError(`load failed: ${res.status}`);
        return;
      }
      const body = await res.json() as Snapshot;
      setSnapshot(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "load failed");
    } finally {
      setLoading(false);
    }
  }

  async function saveUserField(path: string, rawInput: string) {
    if (!snapshot || !selectedSpecialist) return;
    try {
      const meta = LEAF_META[path];
      const value = parseValue(meta, rawInput);
      const res = await fetch(`${apiBasePath}/user`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specialist: selectedSpecialist, path, op: "set", value, expectedMtimeMs: snapshot.userConfig.mtimeMs }),
      });
      logClientEvent("specialist.config.user.save", { specialist: selectedSpecialist, path, status: res.status });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        setError(body.error ?? `save failed: ${res.status}`);
        return;
      }
      setStatus(`saved ${selectedSpecialist}.${path}`);
      await loadSnapshot();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "save failed");
    }
  }

  async function saveConsole(action: string, payload: Record<string, unknown>) {
    if (!snapshot) return;
    try {
      const res = await fetch(`${apiBasePath}/console`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, expectedMtimeMs: snapshot.consoleConfig.mtimeMs, ...payload }),
      });
      logClientEvent(`specialist.config.${action}`, { status: res.status });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        setError(body.error ?? `save failed: ${res.status}`);
        return;
      }
      setStatus(`updated ${action}`);
      await loadSnapshot();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "save failed");
    }
  }

  return (
    <section className="console-specialist-config" data-testid="specialist-config-editor">
      <header className="console-specialist-config-header">
        <div>
          <div className="console-specialists-eyebrow">Specialist config</div>
          <h2>{hostLabel}</h2>
        </div>
        <div className="console-specialist-config-meta">
          <span>{snapshot?.host.label ?? "Host-wide config"}</span>
          <button type="button" onClick={() => void loadSnapshot()}>Reload</button>
        </div>
      </header>
      {loading ? <div className="console-specialists-empty-state-message">Loading config…</div> : null}
      {error ? <div className="console-specialists-empty">{error}</div> : null}
      {status ? <div className="console-specialists-empty-state-message">{status}</div> : null}
      {snapshot ? (
        <div className="console-specialist-config-grid">
          <section className="console-specialist-config-panel">
            <div className="console-specialists-section-label">user.json overrides</div>
            <div className="console-specialist-config-file">{snapshot.userConfig.displayPath}</div>
            <label className="console-specialist-config-picker">
              <span>Specialist</span>
              <select value={selectedSpecialist} onChange={(event: ChangeEvent<HTMLSelectElement>) => setSelectedSpecialist(event.target.value)}>
                {snapshot.specialists.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
              </select>
            </label>
            <div className="console-specialist-config-fields">
              {snapshot.userConfig.leafPaths.map((path) => (
                <FieldRow key={path} path={path} value={readLeaf(selectedOverride, path)} onSave={(next) => void saveUserField(path, next)} />
              ))}
            </div>
          </section>
          <section className="console-specialist-config-panel">
            <div className="console-specialists-section-label">Console repo registry</div>
            <div className="console-specialist-config-file">{snapshot.consoleConfig.displayPath}</div>
            <ConsoleRegistryEditor
              baseDirs={snapshot.consoleConfig.content.base_dirs}
              repos={snapshot.consoleConfig.content.repos}
              onAddRepo={(repo) => void saveConsole("addRepo", { repo })}
              onRemoveRepo={(previousName) => void saveConsole("removeRepo", { previousName })}
              onEditRepo={(previousName, field, value) => void saveConsole("editRepo", { previousName, field, value })}
              onAddBaseDir={(baseDir) => void saveConsole("addBaseDir", { baseDir })}
              onRemoveBaseDir={(baseDir) => void saveConsole("removeBaseDir", { baseDir })}
              onRescan={() => void saveConsole("rescan", {})}
            />
          </section>
        </div>
      ) : null}
    </section>
  );
}

function FieldRow({ path, value, onSave }: { path: string; value: unknown; onSave: (value: string) => void }) {
  const meta = LEAF_META[path];
  const [draft, setDraft] = useState(formatValue(value));

  useEffect(() => setDraft(formatValue(value)), [value]);

  return (
    <label className="console-specialist-config-row">
      <span>{path}</span>
      {meta?.kind === "enum" ? (
        <select value={draft} onChange={(event: ChangeEvent<HTMLSelectElement>) => setDraft(event.target.value)}>
          <option value="null">inherit</option>
          {meta.enumValues?.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </select>
      ) : (
        <input value={draft} onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)} placeholder="inherit/null" />
      )}
      <button type="button" onClick={() => onSave(draft)}>Save</button>
    </label>
  );
}

function ConsoleRegistryEditor(props: {
  baseDirs: string[];
  repos: Array<{ name: string; path: string }>;
  onAddRepo: (repo: { name: string; path: string }) => void;
  onRemoveRepo: (name: string) => void;
  onEditRepo: (name: string, field: "name" | "path", value: string) => void;
  onAddBaseDir: (baseDir: string) => void;
  onRemoveBaseDir: (baseDir: string) => void;
  onRescan: () => void;
}) {
  const [repoName, setRepoName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [baseDir, setBaseDir] = useState("");

  return (
    <div className="console-specialist-config-console">
      <div className="console-specialist-config-inline-form">
        <input value={repoName} onChange={(event: ChangeEvent<HTMLInputElement>) => setRepoName(event.target.value)} placeholder="repo name" />
        <input value={repoPath} onChange={(event: ChangeEvent<HTMLInputElement>) => setRepoPath(event.target.value)} placeholder="repo path" />
        <button type="button" onClick={() => props.onAddRepo({ name: repoName, path: repoPath })}>Add repo</button>
      </div>
      <div className="console-specialist-config-inline-form">
        <input value={baseDir} onChange={(event: ChangeEvent<HTMLInputElement>) => setBaseDir(event.target.value)} placeholder="base dir" />
        <button type="button" onClick={() => props.onAddBaseDir(baseDir)}>Add base dir</button>
        <button type="button" onClick={props.onRescan}>Rescan</button>
      </div>
      <div className="console-specialist-config-list">
        {props.baseDirs.map((entry) => (
          <div key={entry} className="console-specialist-config-chip-row">
            <span>{entry}</span>
            <button type="button" onClick={() => props.onRemoveBaseDir(entry)}>Remove</button>
          </div>
        ))}
      </div>
      <div className="console-specialist-config-list">
        {props.repos.map((repo) => (
          <div key={`${repo.name}:${repo.path}`} className="console-specialist-config-repo-row">
            <input defaultValue={repo.name} onBlur={(event: ChangeEvent<HTMLInputElement>) => props.onEditRepo(repo.name, "name", event.target.value)} />
            <input defaultValue={repo.path} onBlur={(event: ChangeEvent<HTMLInputElement>) => props.onEditRepo(repo.name, "path", event.target.value)} />
            <button type="button" onClick={() => props.onRemoveRepo(repo.name)}>Remove</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function readSpecialist(config: Record<string, unknown> | undefined, specialist: string): Record<string, unknown> {
  const candidate = config?.[specialist];
  return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as Record<string, unknown> : {};
}

function readLeaf(obj: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = obj;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

function parseValue(meta: { kind: string; enumValues?: string[] } | undefined, rawInput: string): unknown {
  const trimmed = rawInput.trim();
  if (trimmed === "" || trimmed === "null" || trimmed === "inherit") return null;
  if (!meta) return trimmed;
  switch (meta.kind) {
    case "number": return Number(trimmed);
    case "boolean": return trimmed === "true";
    case "array": return trimmed.startsWith("[") ? JSON.parse(trimmed) : trimmed.split(",").map((item) => item.trim()).filter(Boolean);
    default: return trimmed;
  }
}
