// src/otel.js
// Minimal zero-dep OpenTelemetry span emitter.
// Spans written to .agent/otel/spans.jsonl (always).
// If OTEL_EXPORTER_OTLP_ENDPOINT is set, spans also exported via OTLP/HTTP JSON.
// Task 6.2

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveContext } from './runtime/context.js';

// Phase 1.4: trace id and the pending-span buffer were module-level, so
// concurrent runs interleaved spans into one trace and one flush drained
// everybody's buffer. Both now live per-context.
const SLOT = 'otel:trace';

function tracer(ctx) {
  return resolveContext(ctx).slot(SLOT, () => ({ activeTraceId: null, pendingSpans: [] }));
}

function otelDir(c) {
  return c.resolve(path.join(c.config.agentDir, 'otel'));
}
const spansFile = (c) => path.join(otelDir(c), 'spans.jsonl');

/** Start a new trace (one per loop session). */
export function startTrace(sessionId, ctx) {
  const t = tracer(ctx);
  t.activeTraceId = sessionId || randomUUID();
  return t.activeTraceId;
}

/** Get the current trace id. */
export function getTraceId(ctx) { return tracer(ctx).activeTraceId; }

/**
 * Record a span.
 * @param {string} name
 * @param {object} attributes
 * @param {number} startMs
 * @param {number} endMs
 * @param {'ok'|'error'} [status]
 */
export function recordSpan(name, attributes = {}, startMs = Date.now(), endMs = Date.now(), status = 'ok', ctx) {
  const c = resolveContext(ctx);
  if (!c.config.otelEnabled) return;
  const t = tracer(c);
  const span = {
    traceId:    t.activeTraceId || 'no-trace',
    spanId:     randomUUID().replace(/-/g, '').slice(0, 16),
    name,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    status,
    attributes,
  };
  _persistSpan(span, c);
  t.pendingSpans.push(span);
}

/** Convenience: time a synchronous function as a span. */
export function withSpan(name, attributes, fn, ctx) {
  const start = Date.now();
  let status = 'ok';
  try {
    const result = fn();
    return result;
  } catch (err) {
    status = 'error';
    throw err;
  } finally {
    recordSpan(name, attributes, start, Date.now(), status, ctx);
  }
}

/** Flush any pending spans to OTLP endpoint (best-effort, non-blocking). */
export async function flushSpans(ctx) {
  const c = resolveContext(ctx);
  const t = tracer(c);
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || t.pendingSpans.length === 0 || !c.config.otelEnabled) return;

  const body = JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: t.pendingSpans.map(_toOtlpSpan) }] }] });
  t.pendingSpans.length = 0;

  try {
    await fetch(`${endpoint}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* non-critical — spans already written locally */ }
}

function _persistSpan(span, c) {
  try {
    fs.mkdirSync(otelDir(c), { recursive: true });
    fs.appendFileSync(spansFile(c), JSON.stringify(span) + '\n');
  } catch { /* non-critical */ }
}

function _toOtlpSpan(span) {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    startTimeUnixNano: String(span.startMs * 1_000_000),
    endTimeUnixNano: String(span.endMs * 1_000_000),
    status: { code: span.status === 'ok' ? 1 : 2 },
    attributes: Object.entries(span.attributes || {}).map(([k, v]) => ({
      key: k,
      value: typeof v === 'number' ? { doubleValue: v } : { stringValue: String(v) },
    })),
  };
}
