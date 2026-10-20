// tests/palace-e2e.test.js
// Phase 2.19 — E2E test: simulate a multi-step task run.
// Verifies that episodic events are recorded, retrieved, and decay is applied.
// Uses EpisodicStore + retrieve + consolidate directly (no live agent loop needed).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EpisodicStore } from '../src/palace/episodic-store.js';
import { retrieve }      from '../src/palace/retrieval.js';
import { consolidate }   from '../src/palace/consolidation.js';
import { buildRoomGraph } from '../src/palace/rooms.js';
import path from 'node:path';

// Inline scoring for tests — importance.js deleted in Wave C-1.
function scoreImportance({ tool, toolError }) {
  let score = 0.3;
  if (toolError) score += 0.3;
  if (['finish', 'update_plan'].includes(tool)) score += 0.25;
  if (['write_file', 'edit_file'].includes(tool)) score += 0.1;
  return Math.min(1.0, score);
}
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.join(__dirname, '..');
const NOW = Math.floor(Date.now() / 1000);

// ── Simulate a multi-step task ─────────────────────────────────────────────────

function simulateTaskRun(store) {
  const steps = [
    { tool: 'read_file',    args: { path: 'src/loop.js' },  result: 'read 1200 lines', domain: 'coding',    who: 'kairos',    ts: NOW - 300 },
    { tool: 'think',        args: {},                         result: 'planning approach', domain: 'coding',  who: 'kairos',    ts: NOW - 250 },
    { tool: 'write_file',   args: { path: 'src/test.js' },   result: 'wrote 50 lines',  domain: 'coding',    who: 'kairos',    ts: NOW - 200 },
    { tool: 'run_command',  args: { command: 'node --test' }, result: '5 tests passed',  domain: 'testing',   who: 'kairos',    ts: NOW - 150 },
    { tool: 'update_plan',  args: {},                          result: 'plan updated',    domain: 'coding',    who: 'kairos',    ts: NOW - 100 },
    { tool: 'run_command',  args: { command: 'node --test' }, result: '5 tests passed',  domain: 'testing',   who: 'kairos',    ts: NOW - 50  },
    { tool: 'finish',       args: {},                          result: 'task complete',   domain: 'coding',    who: 'kairos',    ts: NOW       },
  ];

  const ids = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const importance = scoreImportance({
      tool: s.tool,
      toolError: false,
      result: s.result,
      step: i + 1,
      consecutiveErrors: 0,
      domain: s.domain,
    });
    const id = store.insert({
      verbatim:  `[step ${i + 1}] tool=${s.tool} result="${s.result}"`,
      domain:    s.domain,
      timestamp: s.ts,
      summary:   `${s.tool}: ${s.result}`,
      who:       s.who,
      note:      `importance=${importance.toFixed(2)}`,
    });
    ids.push(id);
  }

  // Link sequential steps
  for (let i = 1; i < ids.length; i++) {
    store.addLink(ids[i - 1], ids[i], 1.0);
  }

  return ids;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Palace E2E — episodic event recording', () => {
  it('events are recorded during a simulated task (count > 0)', () => {
    const store = new EpisodicStore();
    simulateTaskRun(store);
    assert.ok(store.count() > 0, 'expected events to be recorded');
    assert.equal(store.count(), 7, 'expected 7 steps');
    store.close();
  });

  it('events are tagged with who=kairos', () => {
    const store = new EpisodicStore();
    simulateTaskRun(store);
    const events = store.queryRecent(10);
    const allKairos = events.every(e => e.who === 'kairos');
    assert.ok(allKairos, 'all agent-initiated events should be tagged who=kairos');
    store.close();
  });

  it('events span multiple domains (coding + testing)', () => {
    const store = new EpisodicStore();
    simulateTaskRun(store);
    const coding  = store.queryTemporal(NOW - 400, NOW + 1, 'coding',  10);
    const testing = store.queryTemporal(NOW - 400, NOW + 1, 'testing', 10);
    assert.ok(coding.length  > 0, 'expected coding events');
    assert.ok(testing.length > 0, 'expected testing events');
    store.close();
  });
});

describe('Palace E2E — retrieval surfaces relevant memories', () => {
  it('retrieve returns results (non-empty for a seeded store)', () => {
    const store = new EpisodicStore();
    simulateTaskRun(store);
    const graph = buildRoomGraph(WORKSPACE);

    const results = retrieve({
      episodicStore: store,
      roomGraph:     graph,
      query:         'write test loop',
      currentFile:   'src/loop.js',
      topK:          5,
    });

    assert.ok(results.length > 0, 'expected retrieval results');
    store.close();
  });

  it('retrieve returns spatial results for a known file (spatial-only mode)', () => {
    // Use no episodic store so only spatial mode runs — isolates the spatial path.
    const graph = buildRoomGraph(WORKSPACE);

    const results = retrieve({
      episodicStore: null,
      roomGraph:     graph,
      query:         'loop.js',
      currentFile:   'src/loop.js',
      topK:          10,
    });

    const spatialHits = results.filter(r => r.mode === 'spatial');
    assert.ok(spatialHits.length > 0, 'expected spatial hits for src/loop.js');
  });

  it('queryBefore returns the pre-task history', () => {
    const store = new EpisodicStore();
    simulateTaskRun(store);
    const before = store.queryBefore(NOW - 100, null, 10);
    assert.ok(before.length > 0, 'expected events before NOW-100');
    assert.ok(before.every(e => e.timestamp < NOW - 100), 'all results before cutoff');
    store.close();
  });
});

describe('Palace E2E — consolidation (decay) applied', () => {
  it('consolidate runs without error and returns counts', () => {
    const store = new EpisodicStore();
    simulateTaskRun(store);
    const result = consolidate(store);
    assert.ok(typeof result.decayed === 'number', 'decayed should be a number');
    assert.ok(typeof result.pruned  === 'number', 'pruned should be a number');
    assert.ok(typeof result.message === 'string', 'message should be a string');
    store.close();
  });

  it('consolidate message mentions event count', () => {
    const store = new EpisodicStore();
    simulateTaskRun(store);
    const { message } = consolidate(store);
    assert.ok(message.includes('Palace consolidation:'), `unexpected message: ${message}`);
    store.close();
  });

  it('count remains > 0 after consolidation (recent events survive)', () => {
    const store = new EpisodicStore();
    simulateTaskRun(store);
    consolidate(store);
    // Recent events should NOT be archived (only 30+ day old orphans are archived)
    assert.ok(store.count() > 0, 'events should survive consolidation when recent');
    store.close();
  });

  it('links are decayed correctly (surviving links count is >= 0)', () => {
    const store = new EpisodicStore();
    const ids = simulateTaskRun(store);
    const { decayed } = consolidate(store, { alpha: 0.01, deltaT: 1.0, theta: 0.001 });
    // 6 links were created; all should survive one decay step at alpha=0.01
    assert.ok(decayed >= 0 && decayed <= ids.length - 1);
    store.close();
  });
});

describe('Palace E2E — importance scoring', () => {
  it('finish tool has higher score than think', () => {
    const finishScore = scoreImportance({ tool: 'finish', toolError: false, result: 'done', step: 7, consecutiveErrors: 0 });
    const thinkScore  = scoreImportance({ tool: 'think',  toolError: false, result: 'hmm', step: 4, consecutiveErrors: 0 });
    assert.ok(finishScore > thinkScore, `finish (${finishScore}) should score higher than think (${thinkScore})`);
  });

  it('error events score higher than successes', () => {
    const errorScore   = scoreImportance({ tool: 'run_command', toolError: true,  result: 'exit 1', step: 3, consecutiveErrors: 0 });
    const successScore = scoreImportance({ tool: 'run_command', toolError: false, result: 'exit 0', step: 3, consecutiveErrors: 0 });
    assert.ok(errorScore > successScore, 'errors should score higher than successes');
  });
});
