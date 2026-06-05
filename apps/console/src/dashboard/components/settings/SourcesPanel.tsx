import { useEffect, useState } from "react";

type SourceRow = {
  source_key: string;
  kind: string;
  display_path: string;
  origin: string;
  status: string;
};

type SourcesResponse = { sources: SourceRow[] };

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

export function SourcesPanel() {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [path, setPath] = useState("");
  const [kind, setKind] = useState("beads");
  const [error, setError] = useState<string | null>(null);

  async function loadSources(): Promise<void> {
    const body = await requestJson<SourcesResponse>("/api/sources");
    setSources(body.sources);
  }

  useEffect(() => {
    void loadSources().catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)));
  }, []);

  async function pinSource(): Promise<void> {
    setError(null);
    await requestJson("/api/sources/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, kind }),
    });
    setPath("");
    await loadSources();
  }

  async function removeSource(sourceKey: string): Promise<void> {
    setError(null);
    await requestJson(`/api/sources/pin/${encodeURIComponent(sourceKey)}`, { method: "DELETE" });
    await loadSources();
  }

  async function refreshSources(): Promise<void> {
    setError(null);
    await requestJson("/api/sources/refresh", { method: "POST" });
    await loadSources();
  }

  return (
    <section className="fui-panel" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h2 style={{ margin: 0 }}>Sources</h2>
        <button onClick={() => void refreshSources().catch((refreshError) => setError(refreshError instanceof Error ? refreshError.message : String(refreshError)))}>
          Refresh sources
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <select value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="beads">beads</option>
          <option value="observability">observability</option>
        </select>
        <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/path/to/source" style={{ flex: 1 }} />
        <button onClick={() => void pinSource().catch((pinError) => setError(pinError instanceof Error ? pinError.message : String(pinError)))} disabled={!path}>
          Add
        </button>
      </div>
      {error ? <p style={{ color: "var(--danger)" }}>{error}</p> : null}
      <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0" }}>
        {sources.map((source) => (
          <li key={source.source_key} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderTop: "1px solid var(--border-subtle)" }}>
            <div>
              <div style={{ fontWeight: 600 }}>{source.source_key}</div>
              <div style={{ color: "var(--text-secondary)" }}>{source.display_path}</div>
              <small>{source.origin} · {source.status}</small>
            </div>
            <button onClick={() => void removeSource(source.source_key).catch((removeError) => setError(removeError instanceof Error ? removeError.message : String(removeError)))}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
