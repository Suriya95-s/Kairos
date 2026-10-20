// src/kernel/bus.js
// The nervous system: one normalized event schema (D2), an in-process emitter
// for latency, and a JSONL journal for durability and replay.
//
// No broker. The repo's whole state philosophy is "files you can cat", and an
// always-on daemon does not get to add a message-queue dependency to a
// zero-dependency project. In-process delivery gives sub-millisecond fan-out;
// the journal gives crash recovery, `<brand> logs`, and deterministic replay.
//
// Two ordering guarantees, both deliberate:
//   * Journal-before-deliver. A subscriber that crashes the process must not
//     take the event with it — by then it is already on disk.
//   * Monotonic `seq` per bus. Wall-clock timestamps collide inside a
//     millisecond; sorting a replay by `ts` alone silently reorders bursts.
//     (Exactly the bug that made the multi-agent handoff test flaky.)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { dir as kernelDir } from './paths.js';
import { redactTrace } from '../learning/redactor.js';

/** Who produced the event. */
export const EVENT_SOURCES = Object.freeze([
  'timer', 'watcher', 'user.cli', 'user.voice', 'user.tui', 'user.web',
  'mission', 'system',
]);

/**
 * What kind of thing happened. The first six are the D2 canonical set; the
 * remainder are kernel-internal extensions the daemon needs to describe its
 * own lifecycle. Kept in one list so validation stays a single check.
 */
export const EVENT_KINDS = Object.freeze([
  // D2 canonical
  'utterance', 'trigger', 'mission_update', 'approval', 'schedule_due', 'observation',
  // kernel extensions
  'daemon_state', 'session_update', 'health', 'error',
  // B1 internal state (arousal/load/confidence), published with each health probe
  'brain',
  // voice-loop telemetry (scores, rejections, speaking) for the TUI Voice view.
  // NOTE: kinds MUST be registered here before daemon._publish can carry them —
  // its try/catch swallows the validation throw, so an unregistered kind is not
  // an error anyone sees, it is events silently not existing. The brain events
  // above shipped with exactly that bug and were discarded for a day.
  'voice',
  // ontology engine: drop-folder ingests, candidate promotions, graph exports
  'ontology',
]);

/** How much the recipient's attention is owed. Consumed by P6 etiquette. */
export const URGENCIES = Object.freeze(['now', 'soon', 'whenever']);

const DEFAULT_MAX_SEGMENT_BYTES = 8 * 1024 * 1024;

/**
 * Build a validated, normalized event. Exported separately from publish() so
 * callers (and tests) can construct and inspect an event without a bus.
 *
 * Throws on an unknown source/kind/urgency rather than coercing. A typo'd kind
 * that silently becomes "observation" is a bug that surfaces weeks later as
 * "why didn't my trigger fire".
 */
export function createEvent(partial = {}, { now = Date.now, seq = 0, rand = defaultRand } = {}) {
  const { source, kind, sessionId = null, identity = 'default', payload = {}, urgency = 'whenever' } = partial;

  if (!EVENT_SOURCES.includes(source)) {
    throw new Error(`invalid event source "${source}" (expected one of: ${EVENT_SOURCES.join(', ')})`);
  }
  if (!EVENT_KINDS.includes(kind)) {
    throw new Error(`invalid event kind "${kind}" (expected one of: ${EVENT_KINDS.join(', ')})`);
  }
  if (!URGENCIES.includes(urgency)) {
    throw new Error(`invalid event urgency "${urgency}" (expected one of: ${URGENCIES.join(', ')})`);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('event payload must be a plain object');
  }

  const ts = now();
  return {
    id: `evt-${ts.toString(36)}-${String(seq).padStart(6, '0')}-${rand()}`,
    ts,
    seq,
    source,
    kind,
    sessionId,
    identity,
    payload,
    urgency,
  };
}

function defaultRand() {
  return crypto.randomBytes(3).toString('hex');
}

/** Journal segment name for a given timestamp: events-YYYY-MM-DD[.N].jsonl */
function segmentName(ts, index = 0) {
  const d = new Date(ts);
  const day = [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
  ].join('-');
  return index === 0 ? `events-${day}.jsonl` : `events-${day}.${index}.jsonl`;
}

/** Parse a segment filename back into { day, index } — null when it isn't one. */
function parseSegmentName(name) {
  const m = /^events-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/.exec(name);
  if (!m) return null;
  return { day: m[1], index: m[2] ? parseInt(m[2], 10) : 0 };
}

export class Bus extends EventEmitter {
  /**
   * @param {object}   [opts]
   * @param {string}   [opts.journalDir]  where segments live (default: ~/.<brand>/bus)
   * @param {boolean}  [opts.journal]     false → in-memory only (fast unit tests)
   * @param {number}   [opts.maxSegmentBytes]
   * @param {function} [opts.now]         injectable clock, for deterministic tests
   * @param {function} [opts.rand]        injectable id entropy
   * @param {function} [opts.onError]     called when a subscriber throws
   */
  constructor({
    journalDir = null,
    journal = true,
    maxSegmentBytes = DEFAULT_MAX_SEGMENT_BYTES,
    now = Date.now,
    rand = defaultRand,
    onError = null,
  } = {}) {
    super();
    // An always-on daemon accumulates subscribers (each client, each mission).
    // Node's default warning at 10 would be noise, but unbounded is how leaks
    // hide, so raise the ceiling rather than removing it.
    this.setMaxListeners(200);
    this._journalDir = journalDir;
    this._journalEnabled = journal;
    this._maxSegmentBytes = maxSegmentBytes;
    this._now = now;
    this._rand = rand;
    this._onError = onError;
    this._seq = 0;
    this._closed = false;
  }

  /** Resolved journal directory. Late-bound so KAIROS_HOME can change in tests. */
  get journalDir() {
    return this._journalDir || kernelDir('bus');
  }

  /** Number of events published by this bus instance. */
  get published() { return this._seq; }

  /**
   * Publish an event: validate → redact → journal → deliver.
   *
   * Redaction runs before *both* persistence and delivery, so a leaked
   * credential cannot reach a journal file, an SSE client, or an LLM context
   * via a subscriber. This is the S1 guarantee, enforced in one place.
   *
   * @returns {object} the normalized (and redacted) event that was delivered
   */
  publish(partial) {
    if (this._closed) throw new Error('bus is closed');

    const raw = createEvent(partial, { now: this._now, seq: this._seq++, rand: this._rand });
    const evt = { ...raw, payload: redactTrace(raw.payload) };

    if (this._journalEnabled) {
      try {
        this._append(evt);
      } catch (err) {
        // A full or read-only disk must not silently stop the nervous system.
        // Report and keep delivering in-process; S2's disk watcher is what is
        // supposed to have warned long before this.
        this._reportError(err, evt, 'journal');
      }
    }

    this._deliver(evt);
    return evt;
  }

  /** Emit to `kind` listeners, `*` listeners, and per-session listeners. */
  _deliver(evt) {
    for (const channel of [evt.kind, '*', evt.sessionId ? `session:${evt.sessionId}` : null]) {
      if (!channel) continue;
      for (const fn of this.listeners(channel)) {
        try {
          fn(evt);
        } catch (err) {
          // One bad subscriber must not stop the others from seeing the event.
          this._reportError(err, evt, `subscriber:${channel}`);
        }
      }
    }
  }

  _reportError(err, evt, where) {
    if (typeof this._onError === 'function') {
      try { this._onError(err, evt, where); return; } catch { /* fall through */ }
    }
    process.stderr.write(`[bus] ${where} failed for ${evt?.id}: ${err.message}\n`);
  }

  /**
   * Subscribe to events.
   * @param {string|string[]|function} filter  event kind(s), '*', 'session:<id>',
   *                                           or a predicate over the event
   * @param {function} handler
   * @returns {function} unsubscribe
   */
  subscribe(filter, handler) {
    if (typeof filter === 'function' && handler === undefined) {
      handler = filter;
      filter = '*';
    }
    if (typeof handler !== 'function') throw new TypeError('bus.subscribe requires a handler function');

    if (typeof filter === 'function') {
      const wrapped = (evt) => { if (filter(evt)) handler(evt); };
      this.on('*', wrapped);
      return () => this.off('*', wrapped);
    }

    const channels = Array.isArray(filter) ? filter : [filter];
    for (const ch of channels) this.on(ch, handler);
    return () => { for (const ch of channels) this.off(ch, handler); };
  }

  // ── Journal ───────────────────────────────────────────────────────────────

  /** Append one event to the current segment, rotating on the size cap (S2). */
  _append(evt) {
    const d = this.journalDir;
    fs.mkdirSync(d, { recursive: true });

    const line = JSON.stringify(evt) + '\n';
    let index = 0;
    let target = path.join(d, segmentName(evt.ts, index));
    // Roll forward past any full segments for today. Bounded so a bad
    // maxSegmentBytes (say 0) can't spin here forever.
    while (index < 10_000) {
      let size = 0;
      try { size = fs.statSync(target).size; } catch { size = 0; }
      if (size === 0 || size + line.length <= this._maxSegmentBytes) break;
      index++;
      target = path.join(d, segmentName(evt.ts, index));
    }
    fs.appendFileSync(target, line);
    return target;
  }

  /** Journal segment files, oldest first. */
  segments() {
    const d = this.journalDir;
    let names;
    try { names = fs.readdirSync(d); } catch { return []; }
    return names
      .map(name => ({ name, parsed: parseSegmentName(name) }))
      .filter(x => x.parsed)
      .sort((a, b) => a.parsed.day.localeCompare(b.parsed.day) || a.parsed.index - b.parsed.index)
      .map(x => path.join(d, x.name));
  }

  /**
   * Read events back from the journal.
   *
   * Segments are read oldest-first and the result is NOT re-sorted: append
   * order within a segment is the true publication order, and `seq` collides
   * across daemon restarts (each process starts at 0), so sorting by it would
   * scramble history. Filter, don't reorder.
   *
   * @param {object} [filter]
   * @param {number} [filter.sinceTs]   only events with ts >= this
   * @param {string} [filter.afterId]   skip everything up to and including this id
   * @param {string[]} [filter.kinds]
   * @param {string} [filter.sessionId]
   * @param {number} [filter.limit]     return at most N (the most recent N)
   * @returns {object[]}
   */
  replay({ sinceTs = null, afterId = null, kinds = null, sessionId = null, limit = null } = {}) {
    const out = [];
    let seenAfterId = afterId == null;

    for (const seg of this.segments()) {
      let text;
      try { text = fs.readFileSync(seg, 'utf-8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        let evt;
        // A torn final line (daemon killed mid-append) is expected, not fatal.
        try { evt = JSON.parse(line); } catch { continue; }

        if (!seenAfterId) {
          if (evt.id === afterId) seenAfterId = true;
          continue;
        }
        if (sinceTs != null && evt.ts < sinceTs) continue;
        if (kinds && !kinds.includes(evt.kind)) continue;
        if (sessionId != null && evt.sessionId !== sessionId) continue;
        out.push(evt);
      }
    }

    if (limit != null && out.length > limit) return out.slice(-limit);
    return out;
  }

  /**
   * Delete journal segments older than `retentionDays` (S2 rotation).
   * Consolidation (P5.4) is expected to have run first — this is the last step,
   * so it only ever deletes, never summarizes.
   * @returns {string[]} deleted segment paths
   */
  prune({ retentionDays = 30, now = null } = {}) {
    const cutoff = (now ?? this._now()) - retentionDays * 86_400_000;
    const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
    const deleted = [];
    for (const seg of this.segments()) {
      const parsed = parseSegmentName(path.basename(seg));
      if (!parsed || parsed.day >= cutoffDay) continue;
      try { fs.rmSync(seg); deleted.push(seg); } catch { /* best effort */ }
    }
    return deleted;
  }

  /** Total bytes occupied by the journal — input to the S2 disk quota watcher. */
  journalBytes() {
    let total = 0;
    for (const seg of this.segments()) {
      try { total += fs.statSync(seg).size; } catch { /* gone mid-scan */ }
    }
    return total;
  }

  /** Drop all subscribers and refuse further publishes. */
  close() {
    this._closed = true;
    this.removeAllListeners();
  }
}

/**
 * Process-wide bus for the daemon. Kept as an explicit accessor rather than a
 * module-level instance so tests can reset it — the Phase 1 lesson about
 * import-time singletons applies here too.
 */
let _bus = null;

export function getBus(opts) {
  if (!_bus) _bus = new Bus(opts);
  return _bus;
}

export function setBus(bus) {
  _bus = bus;
  return _bus;
}

export function resetBus() {
  if (_bus) { try { _bus.close(); } catch { /* already closed */ } }
  _bus = null;
}
