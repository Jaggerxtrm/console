import { useEffect, useState } from "react";
import type { TimeRange, ObservabilitySummary } from "../../server/observability/metrics-dao.ts";
import { apiClient } from "../lib/client.ts";

export function useObservabilitySummary(range: TimeRange) {
  const [data, setData] = useState<ObservabilitySummary | null>(null);
  useEffect(() => { apiClient.getObservabilitySummary(range).then(setData).catch(() => setData(null)); }, [range]);
  return data;
}
