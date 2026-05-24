import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { emit, makeLogEntry } from "../logger.ts";
import type { EventType } from "./event-types.ts";

type CorrelationContext = { correlation_id: string };

const correlationStore = new AsyncLocalStorage<CorrelationContext>();

export type SpanOutcome = "ok" | "error";

export type SpanAttributes = Record<string, unknown>;

export async function correlate<T>(correlation_id: string, fn: () => T | Promise<T>): Promise<T> {
  return await correlationStore.run({ correlation_id }, async () => await fn());
}

export async function withSpan<T>(component: string, event: EventType, attrs: SpanAttributes, fn: () => T | Promise<T>): Promise<T> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const spanId = randomUUID();
  const correlationId = correlationStore.getStore()?.correlation_id;

  try {
    const value = await fn();
    emitSpan(component, event, {
      ...attrs,
      started_at: startedAt,
      duration_ms: roundMs(performance.now() - start),
      outcome: "ok",
      span_id: spanId,
      ...(correlationId ? { correlation_id: correlationId } : {}),
    });
    return value;
  } catch (error) {
    emitSpan(component, event, {
      ...attrs,
      started_at: startedAt,
      duration_ms: roundMs(performance.now() - start),
      outcome: "error",
      span_id: spanId,
      error_message: error instanceof Error ? error.message : String(error),
      ...(correlationId ? { correlation_id: correlationId } : {}),
    }, "error");
    throw error;
  }
}

function emitSpan(component: string, event: string, data: Record<string, unknown>, level: "info" | "error" = "info"): void {
  emit(makeLogEntry(component as never, event, level, undefined, data));
}

function roundMs(ms: number): number {
  return Math.round(ms);
}
