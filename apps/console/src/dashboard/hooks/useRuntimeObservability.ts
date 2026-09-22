import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeOverviewResponse } from "../../types/runtime-observability.ts";
import { buildRuntimeObservabilityModel } from "../pages/console/runtime-observability/model.ts";
import { useChains } from "./useChains.ts";

const POLL_MS = 2_500;

export function useRuntimeObservability() {
  const [overview, setOverview] = useState<RuntimeOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);
  const chains = useChains();

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/console/runtime/overview?event_limit=240", { cache: "no-store" });
      if (!response.ok) throw new Error(`Runtime API ${response.status}: ${response.statusText}`);
      const payload = await response.json() as RuntimeOverviewResponse;
      if (!aliveRef.current) return;
      setOverview(payload);
      setError(null);
    } catch (cause) {
      if (!aliveRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const model = useMemo(
    () => buildRuntimeObservabilityModel(overview, chains.chains),
    [chains.chains, overview],
  );

  return {
    overview,
    model,
    loading: loading || chains.loading,
    error: error ?? chains.error,
    specialistsError: chains.error,
    refresh,
  };
}
