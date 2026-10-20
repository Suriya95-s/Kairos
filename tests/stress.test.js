// tests/stress.test.js — load/stress across every major subsystem of the loop.
// Network-free and deterministic: pushes VOLUME (large palaces, huge contexts,
// resize storms, command fuzz) and asserts INVARIANTS (counts / termination /
// bounds), not wall-clock, so it never flakes on slow CI. This is the "exercise
// everything under load" pass that the per-feature suites don't cover.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setWorkspace } from '../src/state.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-')); setWorkspace(dir); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

// A tiny seeded PRNG so the "random" stress inputs are reproducible run-to-run.
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

// ── Episodic palace (CEI) ─────────────────────────────────────────────────────
describe('stress: episodic palace handles thousands of events', () => {
  test('insert 5,000, query, consolidate — stays usable', async () => {
    const { EpisodicStore } = await import('../src/palace/episodic-store.js');
    const store = new EpisodicStore(':memory:');
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 5000; i++) {
      store.insert({ verbatim: `event ${i} payload ${i % 7}`, domain: i % 2 ? 'a' : 'b', timestamp: now - i });
    }
    assert.equal(store.count(), 5000);
    const recent = store.queryRecent(10);
    assert.equal(recent.length, 10);
    assert.doesNotThrow(() => store.consolidate(0.01, 1.0, 0.001));
    assert.ok(store.count() > 0, 'recent events survive consolidation');
    store.close();
  });
});

// ── Semantic graph idempotency (unbounded-growth guard) ───────────────────────
describe('stress: semantic graph stays bounded under repeated asserts', () => {
  test('same triple 2,000× → 1 line; 2,000 distinct → 2,000 lines', async () => {
    const { assert: assertTriple, count, flush } = await import('../src/palace/semanticGraph.js');
    flush();
    for (let i = 0; i < 2000; i++) assertTriple('src/a.js', 'modified_by', 'edit_file', 1.0);
    assert.equal(count(), 1, 'idempotent — repeated identical facts do not accumulate');
    for (let i = 0; i < 2000; i++) assertTriple(`src/f${i}.js`, 'modified_by', 'write_file', 1.0);
    assert.equal(count(), 2001);
    const jsonl = path.join(dir, '.agent/palace/semantic.jsonl');
    const lines = fs.readFileSync(jsonl, 'utf-8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2001, 'on-disk lines match in-memory count');
    flush();
  });
});

// ── Procedural index ──────────────────────────────────────────────────────────
describe('stress: procedural recipes form without runaway growth', () => {
  test('1,000 successes across a few triggers → bounded recipe set', async () => {
    const { recordSuccess, getAllRecipes, flush } = await import('../src/palace/proceduralIndex.js');
    flush();
    for (let i = 0; i < 1000; i++) {
      recordSuccess({ tool: 'edit_file', args: {}, result: 'ok', domain: '' });
      recordSuccess({ tool: 'write_file', args: { path: `f.js` }, result: 'ok', domain: '' });
    }
    const recipes = getAllRecipes();
    assert.ok(recipes.length >= 1 && recipes.length <= 16, `recipe count bounded, got ${recipes.length}`);
    flush();
  });
});

// ── Typed DAG ─────────────────────────────────────────────────────────────────
describe('stress: DAG scales and detects cycles without hanging', () => {
  test('200-node linear chain → 200 single-node waves', async () => {
    const { topoWaves } = await import('../src/agents/dag.js');
    const a = Array.from({ length: 200 }, (_, i) => ({ role: `r${i}`, dependsOn: i ? [`r${i - 1}`] : [] }));
    const { waves, hasCycle } = topoWaves(a);
    assert.equal(hasCycle, false);
    assert.equal(waves.length, 200);
    assert.ok(waves.every(w => w.length === 1));
  });
  test('wide diamond → 3 waves with a large parallel middle', async () => {
    const mids = Array.from({ length: 150 }, (_, i) => ({ role: `m${i}`, dependsOn: ['root'] }));
    const a = [{ role: 'root', dependsOn: [] }, ...mids, { role: 'sink', dependsOn: mids.map(m => m.role) }];
    const { waves, hasCycle } = (await import('../src/agents/dag.js')).topoWaves(a);
    assert.equal(hasCycle, false);
    assert.equal(waves.length, 3);
    assert.equal(waves[1].length, 150);
  });
  test('large cycle is detected (no infinite loop)', async () => {
    const a = Array.from({ length: 100 }, (_, i) => ({ role: `c${i}`, dependsOn: [`c${(i + 99) % 100}`] }));
    const { hasCycle } = (await import('../src/agents/dag.js')).topoWaves(a);
    assert.equal(hasCycle, true);
  });
});

// ── Token estimator ───────────────────────────────────────────────────────────
describe('stress: token estimator on large inputs', () => {
  test('1 MB string + 1,000 messages → finite, no NaN', async () => {
    const { estimateTokens, estimateMessagesTokens } = await import('../src/llm.js');
    const big = 'x'.repeat(1_000_000);
    const t = estimateTokens(big);
    assert.ok(Number.isFinite(t) && t > 0);
    const msgs = Array.from({ length: 1000 }, (_, i) => ({ role: 'user', content: `msg ${i} `.repeat(20) }));
    const mt = estimateMessagesTokens(msgs);
    assert.ok(Number.isFinite(mt) && mt > 0);
  });
});

// ── RMT segmentation (infinite-loop regression guard) ─────────────────────────
describe('stress: RMT segmentation terminates on huge input', () => {
  test('segmentText on 500 KB terminates with a sane segment count', async () => {
    const { segmentText } = await import('../src/rmt/index.js');
    const segs = segmentText('a'.repeat(500_000), 2048, 128);
    assert.ok(Array.isArray(segs) && segs.length > 0 && segs.length < 10_000, `bounded segments, got ${segs.length}`);
  });
});

// ── Tool contract under volume ────────────────────────────────────────────────
describe('stress: tool registry handles many calls + dryRun is side-effect-free', () => {
  test('500 write/read cycles all return structured ok; dryRun writes nothing', async () => {
    const { executeRegistryTool } = await import('../src/routing/toolRegistry.js');
    for (let i = 0; i < 500; i++) {
      const w = executeRegistryTool('write_file', { path: `f${i}.txt`, content: `line ${i}` });
      assert.equal(w.error, false);
      const r = executeRegistryTool('read_file', { path: `f${i}.txt` });
      assert.equal(r.error, false);
    }
    const dry = executeRegistryTool('write_file', { path: 'ghost.txt', content: 'x', dryRun: true });
    assert.equal(dry.error, false);
    assert.equal(fs.existsSync(path.join(dir, 'ghost.txt')), false);
  });
});

// ── Line renderer (all event types, high volume) ──────────────────────────────
describe('stress: line renderer never throws over 10k mixed events', () => {
  test('all 16 event types × volume; noise suppressed', async () => {
    const { formatEvent } = await import('../src/observability/lineRenderer.js');
    const types = ['session_start', 'step', 'tool_result', 'approval_requested', 'approval_response',
      'approval_timeout', 'clarification_asked', 'clarification_answered', 'steering_injected',
      'paused', 'resumed', 'cost_update', 'stage_metrics', 'compaction', 'session_end', 'unknown_type'];
    const rand = rng(42);
    let suppressed = 0, rendered = 0;
    for (let i = 0; i < 10_000; i++) {
      const type = types[Math.floor(rand() * types.length)];
      const ev = { type, step: i, tool: 'run_command', result: 'x'.repeat(Math.floor(rand() * 500)),
        thought: 'thinking '.repeat(Math.floor(rand() * 30)), id: `id${i}`, exitReason: 'completed',
        totalSteps: i, costUsd: rand(), reason: 'because', message: 'steer', question: 'q?', answer: 'a' };
      let line;
      assert.doesNotThrow(() => { line = formatEvent(ev); });
      if (line == null) suppressed++; else rendered++;
    }
    assert.ok(suppressed > 0 && rendered > 0, 'both suppressed-noise and rendered-signal paths exercised');
  });
});

// ── Frame composer resize storm (TUI) ─────────────────────────────────────────
describe('stress: composeFrame survives a resize storm', () => {
  test('100 random sizes (incl. narrow) → always H lines, never throws', async () => {
    const { state, setState } = await import('../apps/tui/src/state.js');
    const { composeFrame } = await import('../apps/tui/src/app.js');
    setState({
      showSplash: false, view: 'live', overlay: null, status: 'running', task: 'stress',
      step: 9, stage: 'execution', model: 'm', costUsd: 0.1,
      steps: [{ step: 9, tool: 'run_command', arg: 'x', thought: 't', result: '', error: false, startMs: 1 }],
      stepLatenciesMs: [], pendingApprovals: [], focusChain: [{ text: 'a', state: 'current' }],
      modelPickerOpen: false, settingsOpen: false, modelConfigOpen: false, chatToolApproval: null, toast: null,
    });
    const rand = rng(7);
    for (let i = 0; i < 100; i++) {
      const W = 20 + Math.floor(rand() * 180);   // 20..200, spans the <60 narrow path
      const H = 8 + Math.floor(rand() * 50);
      let frame;
      assert.doesNotThrow(() => { frame = composeFrame(W, H); }, `composeFrame(${W},${H}) threw`);
      assert.equal(frame.length, H, `frame at ${W}x${H} must be exactly H lines`);
    }
  });
});

// ── Command router fuzz (crash-safety under volume) ───────────────────────────
describe('stress: executeCmd never rejects over 300 fuzzed commands', () => {
  test('garbage + safe slash commands; network/spawn/exit verbs skipped', async () => {
    const { state, setState } = await import('../apps/tui/src/state.js');
    const { executeCmd } = await import('../apps/tui/src/app.js');
    setState({ view: 'live', status: 'running', overlay: null, steps: [], chatMessages: [],
      cmdHistory: [], pendingApprovals: [], pendingClarifications: [], toast: null });
    // Pure state-mutating commands only — no branch here touches the network
    // (so the fuzz stays fast + offline; the network paths are covered elsewhere).
    const safe = ['/live', '/hitl', '/memory', '/metrics', '/chat', '/clear', '/clearchat',
      '/status', '/help', '/settings'];
    const rand = rng(99);
    const alpha = 'abcdefghijklmnop/ 0123';
    for (let i = 0; i < 300; i++) {
      let input;
      if (rand() < 0.5) input = safe[Math.floor(rand() * safe.length)];
      else { // random slash-prefixed garbage → unknown-command branch (no network)
        let s = '/';
        const len = 1 + Math.floor(rand() * 12);
        for (let j = 0; j < len; j++) s += alpha[Math.floor(rand() * alpha.length)];
        input = s;
      }
      await assert.doesNotReject(() => executeCmd(input), `executeCmd(${JSON.stringify(input)}) rejected`);
    }
    if (state._toastTimer) { clearTimeout(state._toastTimer); setState({ _toastTimer: null }); }
  });
});

// ── Budget ceilings ───────────────────────────────────────────────────────────
describe('stress: budget step + USD ceilings hold under volume', () => {
  test('1,000 steps + cost accrual trip the ceilings', async () => {
    const { createBudget } = await import('../src/agents/budget.js');
    const b = createBudget({ total: 500, perRole: { coder: 300 }, maxDollars: 1.0 });
    for (let i = 0; i < 1000; i++) b.recordStep('coder');
    assert.ok(!b.canStep('coder', 1000).ok, 'step budget trips');
    const b2 = createBudget({ total: 1e9, maxDollars: 1.0 });
    for (let i = 0; i < 1000; i++) b2.recordCost('coder', 0.01); // $10 total
    assert.ok(!b2.canStep('coder', 0).ok, 'USD ceiling trips');
    assert.match(b2.canStep('coder', 0).reason, /cost ceiling/i);
  });
});

// ── Conductor manifest durability ─────────────────────────────────────────────
describe('stress: manifest survives many atomic writes', () => {
  test('500 write/read cycles — no corruption, no .tmp leak', async () => {
    const { initManifest, writeManifest, readManifest } = await import('../src/agents/manifest.js');
    const assignments = [{ role: 'scout' }, { role: 'coder', dependsOn: ['scout'] }];
    let m = initManifest('ep-stress', 'task', assignments);
    for (let i = 0; i < 500; i++) {
      m.status.scout = i % 2 ? 'completed' : 'running';
      writeManifest(dir, m);
      const got = readManifest(dir, 'ep-stress');
      assert.equal(got.sessionId, 'ep-stress');
      m = got;
    }
    assert.equal(fs.existsSync(path.join(dir, '.agent/conductor-state.json.tmp')), false);
  });
});
