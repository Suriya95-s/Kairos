// src/tools/utils/toolResult.js
//
// The structured tool contract (Wave B). A tool handler returns a ToolResult:
//
//   { ok: boolean, data: string, stderr: string, exitCode: number, dryRun: boolean }
//
// The registry derives the loop-facing `error` flag straight from `ok` — no more
// sniffing the output string for failure markers (the old isToolFailureResult).
// `renderForModel()` flattens a ToolResult into the exact string the model sees.
//
// Migration is incremental: a handler may still return a bare string, which the
// registry treats as legacy and routes through the old string-sniffing path.
// `isToolResult()` is the discriminator between the two shapes.
//
// Design note — render parity: handlers carry their full, human/model-facing
// wording in `data` (success) or `stderr` (failure), and renderForModel returns
// it verbatim. This keeps every downstream substring heuristic in loop.js /
// context.js / compaction.js / router.js working unchanged while the *error*
// signal becomes explicit. exitCode / dryRun ride along as structured metadata
// for tests and future callers (they are not re-rendered into the string).

/**
 * A successful tool result.
 * @param {string} data   model-facing output (the tool's existing success text)
 * @param {object} [extra] optional structured fields, e.g. { dryRun, exitCode }
 */
export function ok(data = '', extra = {}) {
  return { ok: true, data: String(data ?? ''), stderr: '', exitCode: 0, dryRun: false, ...extra };
}

/**
 * A failed tool result.
 * @param {string} message model-facing failure text (the tool's existing error text)
 * @param {object} [extra]  optional structured fields, e.g. { exitCode, data }
 */
export function fail(message = '', extra = {}) {
  return { ok: false, data: '', stderr: String(message ?? ''), exitCode: 1, dryRun: false, ...extra };
}

/** True when a handler returned the structured shape (vs a legacy string). */
export function isToolResult(x) {
  return x !== null && typeof x === 'object' && typeof x.ok === 'boolean';
}

/**
 * Flatten a ToolResult to the single string the model context receives.
 * Deliberately minimal: the handler owns the wording, so the rendered text is
 * byte-identical to what the tool used to return as a bare string.
 */
export function renderForModel(r) {
  if (!isToolResult(r)) return String(r ?? '');
  if (r.ok) return r.data || '(no output)';
  return r.stderr || r.data || 'Tool failed.';
}
