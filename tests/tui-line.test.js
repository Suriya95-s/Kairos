// tests/tui-line.test.js — Wave E-1: in-process line renderer (the --no-tui path).
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { formatEvent, lineFor, attachLineRenderer } from '../src/observability/lineRenderer.js';

describe('formatEvent — one tagged line per signal event', () => {
  test('session_start', () => {
    const l = formatEvent({ type: 'session_start', episodeId: 'ep-9', model: 'claude', task: 'fix the parser' });
    assert.match(l, /^SESSION ep-9 model=claude task="fix the parser"/);
  });

  test('session_start marks resume', () => {
    const l = formatEvent({ type: 'session_start', episodeId: 'ep-9', model: 'claude', task: 't', resume: true });
    assert.match(l, /\(resumed\)/);
  });

  test('step includes number, stage, tool, thought', () => {
    const l = formatEvent({ type: 'step', step: 47, stage: 'execution', tool: 'run_command', arg: 'node --test', thought: 're-running suite' });
    assert.match(l, /^STEP 47 \[execution\] run_command/);
    assert.match(l, /re-running suite/);
  });

  test('tool_result ok vs error carry a symbol', () => {
    assert.match(formatEvent({ type: 'tool_result', result: 'all pass', error: false }), /✓ ok all pass/);
    assert.match(formatEvent({ type: 'tool_result', result: 'boom', error: true }), /✗ ERR boom/);
  });

  test('approval_requested surfaces tool + reason + id', () => {
    const l = formatEvent({ type: 'approval_requested', tool: 'run_command', reason: 'destructive: rm -rf build/', id: 'a1' });
    assert.match(l, /^APPROVAL NEEDED run_command — destructive: rm -rf build\/ \[id a1\]/);
  });

  test('approval_response / timeout', () => {
    assert.match(formatEvent({ type: 'approval_response', approved: true, id: 'a1' }), /APPROVAL approved \[id a1\]/);
    assert.match(formatEvent({ type: 'approval_response', approved: false, id: 'a1' }), /APPROVAL denied \[id a1\]/);
    assert.match(formatEvent({ type: 'approval_timeout', id: 'a1' }), /APPROVAL TIMEOUT \(auto-denied\) \[id a1\]/);
  });

  test('clarification asked / answered', () => {
    assert.match(formatEvent({ type: 'clarification_asked', question: 'which port?', id: 'c1' }), /CLARIFY\? which port\? \[id c1\]/);
    assert.match(formatEvent({ type: 'clarification_answered', answer: '8080', id: 'c1' }), /CLARIFY answered: 8080 \[id c1\]/);
  });

  test('steering / paused / resumed / compaction', () => {
    assert.match(formatEvent({ type: 'steering_injected', message: 'focus on tests' }), /STEER focus on tests/);
    assert.equal(formatEvent({ type: 'paused' }), 'PAUSED');
    assert.equal(formatEvent({ type: 'resumed' }), 'RESUMED');
    assert.match(formatEvent({ type: 'compaction', step: 30 }), /COMPACTION .*step 30/);
  });

  test('session_end carries exit reason, steps, cost', () => {
    const l = formatEvent({ type: 'session_end', exitReason: 'completed', totalSteps: 47, costUsd: 0.8312 });
    assert.match(l, /^DONE completed \(47 steps \$0\.8312\)/);
  });
});

describe('formatEvent — suppressed (per-step noise)', () => {
  test('cost_update and stage_metrics return null', () => {
    assert.equal(formatEvent({ type: 'cost_update', costUsd: 0.1 }), null);
    assert.equal(formatEvent({ type: 'stage_metrics', breakdown: {} }), null);
  });
  test('unknown / malformed events return null', () => {
    assert.equal(formatEvent({ type: 'nonsense' }), null);
    assert.equal(formatEvent(null), null);
    assert.equal(formatEvent({}), null);
  });
});

describe('formatEvent — purity + clamping', () => {
  test('is deterministic (no timestamp, same input → same output)', () => {
    const ev = { type: 'step', step: 1, tool: 'think' };
    assert.equal(formatEvent(ev), formatEvent(ev));
  });
  test('collapses whitespace and clamps very long fields', () => {
    const l = formatEvent({ type: 'steering_injected', message: 'a'.repeat(500) });
    assert.ok(l.length < 220, 'long field is clamped');
    assert.match(l, /…$/);
  });
});

describe('lineFor — timestamped writer line', () => {
  test('prepends an injected timestamp', () => {
    assert.equal(lineFor({ type: 'paused' }, '12:00:00'), '12:00:00  PAUSED');
  });
  test('returns null when the event is suppressed', () => {
    assert.equal(lineFor({ type: 'cost_update' }, '12:00:00'), null);
  });
});

describe('attachLineRenderer — gateway subscription', () => {
  test('writes a line per signal event and unsubscribes cleanly', () => {
    const listeners = new Set();
    const fakeGateway = {
      addSseListener: (fn) => listeners.add(fn),
      removeSseListener: (fn) => listeners.delete(fn),
    };
    const out = [];
    const unsub = attachLineRenderer(fakeGateway, (s) => out.push(s));
    assert.equal(listeners.size, 1);

    const emit = (ev) => listeners.forEach(fn => fn(JSON.stringify(ev)));
    emit({ type: 'paused' });
    emit({ type: 'cost_update', costUsd: 1 }); // suppressed
    emit({ type: 'resumed' });

    // Strip the wall-clock "HH:MM:SS  " prefix and compare the bodies.
    const bodies = out.map(l => l.replace(/^\d\d:\d\d:\d\d\s+/, ''));
    assert.deepEqual(bodies, ['PAUSED', 'RESUMED']);

    unsub();
    assert.equal(listeners.size, 0);
  });

  test('ignores malformed JSON payloads without throwing', () => {
    const listeners = new Set();
    const fakeGateway = { addSseListener: (fn) => listeners.add(fn), removeSseListener: (fn) => listeners.delete(fn) };
    const out = [];
    attachLineRenderer(fakeGateway, (s) => out.push(s));
    assert.doesNotThrow(() => listeners.forEach(fn => fn('{not json')));
    assert.equal(out.length, 0);
  });
});
