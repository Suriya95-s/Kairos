// tests/observability.test.js
// Phase 6 observability tests: logger, OTel, costTracker, telemetry, skill lock.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-obs-'));
}

function rmTmp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ── Logger ────────────────────────────────────────────────────────────────────

describe('logger', () => {
  test('exports debug/info/warn/error', async () => {
    const { logger } = await import('../src/logger.js');
    assert.equal(typeof logger.debug, 'function');
    assert.equal(typeof logger.info,  'function');
    assert.equal(typeof logger.warn,  'function');
    assert.equal(typeof logger.error, 'function');
  });

  test('child logger has all methods', async () => {
    const { logger } = await import('../src/logger.js');
    const child = logger.child('test-prefix');
    assert.equal(typeof child.debug, 'function');
    assert.equal(typeof child.info,  'function');
    assert.equal(typeof child.warn,  'function');
    assert.equal(typeof child.error, 'function');
  });

  test('info does not throw', async () => {
    const { logger } = await import('../src/logger.js');
    assert.doesNotThrow(() => logger.info('test message', { key: 'val' }));
  });

  test('child logger does not throw', async () => {
    const { logger } = await import('../src/logger.js');
    const child = logger.child('prefix');
    assert.doesNotThrow(() => child.warn('test', { x: 1 }));
  });

  test('default export is the same object', async () => {
    const mod = await import('../src/logger.js');
    assert.equal(mod.default, mod.logger);
  });
});

// ── OTel ──────────────────────────────────────────────────────────────────────

describe('otel', () => {
  test('exports startTrace / getTraceId / recordSpan / flushSpans / withSpan', async () => {
    const otel = await import('../src/otel.js');
    assert.equal(typeof otel.startTrace,  'function');
    assert.equal(typeof otel.getTraceId,  'function');
    assert.equal(typeof otel.recordSpan,  'function');
    assert.equal(typeof otel.flushSpans,  'function');
    assert.equal(typeof otel.withSpan,    'function');
  });

  test('startTrace returns a string id', async () => {
    const { startTrace, getTraceId } = await import('../src/otel.js');
    const id = startTrace('my-session');
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
    assert.equal(getTraceId(), id);
  });

  test('recordSpan with otelEnabled=false does not throw', async () => {
    const { recordSpan } = await import('../src/otel.js');
    // otelEnabled defaults false in tests (KAIROS_OTEL not set)
    assert.doesNotThrow(() => recordSpan('test.span', { step: 1 }));
  });

  test('withSpan returns function result', async () => {
    const { withSpan } = await import('../src/otel.js');
    const result = withSpan('test', {}, () => 42);
    assert.equal(result, 42);
  });

  test('withSpan propagates thrown errors', async () => {
    const { withSpan } = await import('../src/otel.js');
    assert.throws(() => withSpan('test', {}, () => { throw new Error('boom'); }), /boom/);
  });

  test('flushSpans resolves without error when disabled', async () => {
    const { flushSpans } = await import('../src/otel.js');
    await assert.doesNotReject(flushSpans());
  });
});

// ── TF-IDF (retrieval) ────────────────────────────────────────────────────────

describe('tfidfScores', () => {
  test('exact match scores higher than no match', async () => {
    const { tfidfScores } = await import('../src/palace/retrieval.js');
    const scores = tfidfScores('machine learning', [
      'machine learning is great',
      'the weather is nice today',
    ]);
    assert.equal(scores.length, 2);
    assert.ok(scores[0] > scores[1], `expected ${scores[0]} > ${scores[1]}`);
  });

  test('returns zeros for empty query', async () => {
    const { tfidfScores } = await import('../src/palace/retrieval.js');
    const scores = tfidfScores('', ['hello world', 'foo bar']);
    assert.ok(scores.every(s => s === 0));
  });

  test('returns zeros for empty corpus', async () => {
    const { tfidfScores } = await import('../src/palace/retrieval.js');
    const scores = tfidfScores('query', []);
    assert.equal(scores.length, 0);
  });

  test('scores are in [0, 1]', async () => {
    const { tfidfScores } = await import('../src/palace/retrieval.js');
    const docs = ['hello world', 'foo bar baz', 'test query hello'];
    const scores = tfidfScores('hello test', docs);
    for (const s of scores) {
      assert.ok(s >= 0 && s <= 1, `score ${s} out of range`);
    }
  });
});

// ── Cost Tracker ──────────────────────────────────────────────────────────────

describe('costTracker', () => {
  test('startSession + recordUsage + sessionCost round-trip', async () => {
    const { startSession, recordUsage, sessionCost } = await import('../src/observability/costTracker.js');
    startSession('test-sess-1', 'agent-0');
    recordUsage({ prompt_tokens: 1000, completion_tokens: 500 });
    recordUsage({ prompt_tokens: 200,  completion_tokens: 100 });
    const cost = sessionCost();
    assert.equal(cost.sessionId,         'test-sess-1');
    assert.equal(cost.agentId,           'agent-0');
    assert.equal(cost.promptTokens,      1200);
    assert.equal(cost.completionTokens,  600);
    assert.equal(cost.totalTokens,       1800);
    assert.equal(cost.calls,             2);
    assert.equal(typeof cost.estimatedDollars, 'number');
  });

  test('flushCost writes to telemetry/cost.jsonl', async () => {
    const { startSession, recordUsage, flushCost } = await import('../src/observability/costTracker.js');
    const tmp = makeTmp();
    try {
      startSession('flush-sess', 'agent-1');
      recordUsage({ prompt_tokens: 100, completion_tokens: 50 });
      flushCost(tmp);
      const file = path.join(tmp, '.agent', 'telemetry', 'cost.jsonl');
      assert.ok(fs.existsSync(file), 'cost.jsonl should exist');
      const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
      assert.ok(lines.length >= 1);
      const rec = JSON.parse(lines[lines.length - 1]);
      assert.equal(rec.sessionId, 'flush-sess');
      assert.ok(rec.ts);
    } finally {
      rmTmp(tmp);
    }
  });

  test('recordUsage handles missing fields gracefully', async () => {
    const { startSession, recordUsage, sessionCost } = await import('../src/observability/costTracker.js');
    startSession('edge-sess');
    recordUsage({});
    recordUsage(null);
    const cost = sessionCost();
    assert.equal(cost.promptTokens, 0);
    assert.equal(cost.completionTokens, 0);
  });
});

// ── Telemetry ─────────────────────────────────────────────────────────────────

describe('telemetry', () => {
  test('track is a function', async () => {
    const { track } = await import('../src/observability/telemetry.js');
    assert.equal(typeof track, 'function');
  });

  test('track does not throw when telemetry is disabled (default)', async () => {
    const { track } = await import('../src/observability/telemetry.js');
    assert.doesNotThrow(() => track('test.event', { foo: 'bar' }));
  });

  test('initTelemetry sets workspace and session', async () => {
    const { initTelemetry, track } = await import('../src/observability/telemetry.js');
    assert.doesNotThrow(() => initTelemetry('/tmp/test-ws', 'sess-abc'));
    assert.doesNotThrow(() => track('session.start'));
  });
});

// ── Atomic writeJSON (state.js) ───────────────────────────────────────────────

describe('state.writeJSON atomic', () => {
  test('writeJSON produces no .tmp residue on success', async () => {
    const tmp = makeTmp();
    try {
      const { setWorkspace, writeJSON } = await import('../src/state.js');
      setWorkspace(tmp);
      writeJSON('.agent/test-atomic.json', { hello: 'world' });
      const file = path.join(tmp, '.agent', 'test-atomic.json');
      const tmpFile = file + '.tmp';
      assert.ok(fs.existsSync(file), 'final file should exist');
      assert.ok(!fs.existsSync(tmpFile), '.tmp should be gone after success');
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      assert.equal(data.hello, 'world');
    } finally {
      rmTmp(tmp);
    }
  });

  test('writeJSON can overwrite an existing file atomically', async () => {
    const tmp = makeTmp();
    try {
      const { setWorkspace, writeJSON, readJSON } = await import('../src/state.js');
      setWorkspace(tmp);
      writeJSON('.agent/overwrite.json', { v: 1 });
      writeJSON('.agent/overwrite.json', { v: 2 });
      const data = readJSON('.agent/overwrite.json');
      assert.equal(data.v, 2);
    } finally {
      rmTmp(tmp);
    }
  });
});
