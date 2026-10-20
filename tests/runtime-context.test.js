// tests/runtime-context.test.js
// Phase 1 (de-globalization) — proves AgentContext delivers real isolation and
// that the ambient context preserves today's single-run behavior exactly.
//
// These are the acceptance tests for JARVIS_EVOLUTION_PLAN.md Phase 1: without
// them, "concurrent sessions are safe" is an assumption rather than a fact.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import baseConfig from '../src/config.js';
import {
  AgentContext,
  createContext,
  getAmbientContext,
  resetAmbientContext,
  resolveContext,
} from '../src/runtime/context.js';

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kairos-ctx-${tag}-`));
}

describe('AgentContext — isolation', () => {
  afterEach(() => resetAmbientContext());

  test('ambient context uses the config singleton BY REFERENCE', () => {
    // This is the backward-compatibility contract: ~45 modules do
    // `import config from './config.js'` and must keep observing the same
    // object the ambient context mutates.
    const amb = getAmbientContext();
    assert.equal(amb.config, baseConfig, 'ambient config must be the singleton itself');

    const dir = tmpdir('ambient');
    amb.setWorkspace(dir);
    assert.equal(baseConfig._workspace, path.resolve(dir),
      'setWorkspace must keep config._workspace in lock-step for HITL/learning modules');
  });

  test('explicit contexts get an isolated config clone', () => {
    const a = createContext({ workspace: tmpdir('a'), config: { model: 'model-a' } });
    const b = createContext({ workspace: tmpdir('b'), config: { model: 'model-b' } });

    assert.equal(a.config.model, 'model-a');
    assert.equal(b.config.model, 'model-b');

    a.config.maxOutputTokens = 111;
    assert.notEqual(b.config.maxOutputTokens, 111, 'sibling contexts must not share config');
    assert.notEqual(baseConfig.model, 'model-a', 'explicit contexts must not mutate the singleton');
  });

  test('two contexts hold independent workspaces simultaneously', () => {
    // The core daemon requirement: concurrent missions in one process.
    const dirA = tmpdir('ws-a');
    const dirB = tmpdir('ws-b');
    const a = createContext({ workspace: dirA });
    const b = createContext({ workspace: dirB });

    assert.equal(a.workspace, path.resolve(dirA));
    assert.equal(b.workspace, path.resolve(dirB));
    assert.equal(a.resolve('.agent/task.md'), path.join(path.resolve(dirA), '.agent/task.md'));
    assert.notEqual(a.resolve('x'), b.resolve('x'));
  });

  test('slots are per-context, created once', () => {
    const a = createContext({ workspace: tmpdir('slot-a') });
    const b = createContext({ workspace: tmpdir('slot-b') });

    let calls = 0;
    const factory = () => { calls++; return { n: 0 }; };

    a.slot('k', factory).n = 1;
    a.slot('k', factory).n += 1;          // memoized — factory not re-run
    const fromB = b.slot('k', factory);

    assert.equal(a.slot('k', factory).n, 2);
    assert.equal(fromB.n, 0, 'context B must not see context A slot state');
    assert.equal(calls, 2, 'factory runs exactly once per context');
  });

  test('workspace-scoped slots are dropped when the workspace changes', () => {
    // Regression guard for the class of bug that made completionGuard flaky:
    // a cache built against the old root serving the new one.
    const ctx = createContext({ workspace: tmpdir('inv-1') });
    ctx.slot('cache', () => ({ tag: 'first' }), { workspaceScoped: true });
    ctx.slot('sticky', () => ({ tag: 'kept' }));

    ctx.setWorkspace(tmpdir('inv-2'));

    assert.equal(ctx.hasSlot('cache'), false, 'workspace-scoped slot must be invalidated');
    assert.equal(ctx.hasSlot('sticky'), true, 'unscoped slot must survive');
    assert.equal(ctx.slot('cache', () => ({ tag: 'second' }), { workspaceScoped: true }).tag, 'second');
  });

  test('setting the same workspace does not invalidate slots', () => {
    const dir = tmpdir('same');
    const ctx = createContext({ workspace: dir });
    ctx.slot('cache', () => ({ tag: 'first' }), { workspaceScoped: true });
    ctx.setWorkspace(dir);
    assert.equal(ctx.hasSlot('cache'), true, 'a no-op setWorkspace must not throw away work');
  });
});

describe('AgentContext — lifecycle', () => {
  afterEach(() => resetAmbientContext());

  test('dispose runs disposers in reverse order and clears slots', () => {
    const ctx = createContext({ workspace: tmpdir('disp') });
    const order = [];
    ctx.slot('first', () => 1, { dispose: () => order.push('first') });
    ctx.slot('second', () => 2, { dispose: () => order.push('second') });

    ctx.dispose();

    assert.deepEqual(order, ['second', 'first'], 'disposers run LIFO');
    assert.equal(ctx.disposed, true);
    assert.equal(ctx.hasSlot('first'), false);
  });

  test('one failing disposer does not strand the others', () => {
    const ctx = createContext({ workspace: tmpdir('disp-err') });
    let cleaned = false;
    ctx.slot('good', () => 1, { dispose: () => { cleaned = true; } });
    ctx.slot('bad', () => 2, { dispose: () => { throw new Error('handle stuck'); } });

    assert.throws(() => ctx.dispose(), (err) => err instanceof AggregateError);
    assert.equal(cleaned, true, 'the remaining disposer must still run');
  });

  test('dispose is idempotent and using a disposed context throws', () => {
    const ctx = createContext({ workspace: tmpdir('disp-2') });
    ctx.dispose();
    assert.doesNotThrow(() => ctx.dispose());
    assert.throws(() => ctx.slot('x', () => 1), /disposed/);
  });

  test('resolveContext falls back to ambient, honors an explicit context', () => {
    const explicit = createContext({ workspace: tmpdir('res') });
    assert.equal(resolveContext(explicit), explicit);
    assert.equal(resolveContext(undefined), getAmbientContext());
    assert.equal(resolveContext(null), getAmbientContext());
    assert.equal(resolveContext({ not: 'a context' }), getAmbientContext());
  });

  test('resetAmbientContext yields a fresh instance', () => {
    const first = getAmbientContext();
    first.slot('leftover', () => 'stale');
    const second = resetAmbientContext();
    assert.notEqual(first, second);
    assert.equal(second.hasSlot('leftover'), false);
    assert.ok(second instanceof AgentContext);
  });
});

describe('Phase 1.2 — implicit context propagation (the exit criterion)', () => {
  afterEach(() => resetAmbientContext());

  test('context survives await boundaries', async () => {
    const { runWithContext, currentContext } = await import('../src/runtime/context.js');
    const ctx = createContext({ workspace: tmpdir('als-await') });

    await runWithContext(ctx, async () => {
      assert.equal(currentContext(), ctx);
      await new Promise(r => setTimeout(r, 5));
      assert.equal(currentContext(), ctx, 'context must survive a timer await');
      await Promise.resolve();
      assert.equal(currentContext(), ctx, 'context must survive a microtask');
    });

    assert.notEqual(currentContext(), ctx, 'context must not leak after the run ends');
  });

  test('TWO CONCURRENT RUNS interleave without bleeding state', async () => {
    // This is the Phase 1 acceptance criterion. Sequential isolation is easy;
    // the real hazard is two runs interleaving at await points, which is
    // exactly what a daemon does. Each side yields between every write to
    // force the scheduler to interleave them.
    const { runWithContext } = await import('../src/runtime/context.js');
    const state = await import('../src/state.js');

    const dirA = tmpdir('conc-a');
    const dirB = tmpdir('conc-b');
    const a = createContext({ workspace: dirA });
    const b = createContext({ workspace: dirB });

    const yieldTick = () => new Promise(r => setTimeout(r, 1));

    async function mission(ctx, tag, fileCount) {
      return runWithContext(ctx, async () => {
        state.initAgentDir();
        await yieldTick();
        state.writeTask(`task for ${tag}`);
        await yieldTick();
        for (let i = 0; i < fileCount; i++) {
          state.trackFileWrite(`${tag}-file-${i}.js`, { step: i });
          await yieldTick();
        }
        state.flushFilesTouched();
        await yieldTick();
        // Read back from INSIDE the run — must see only this run's data.
        return {
          workspace: state.getWorkspace(),
          task:      state.readTask(),
          writes:    Object.keys(state.readFilesTouched().writes).sort(),
        };
      });
    }

    const [ra, rb] = await Promise.all([mission(a, 'alpha', 3), mission(b, 'beta', 2)]);

    assert.equal(ra.workspace, path.resolve(dirA));
    assert.equal(rb.workspace, path.resolve(dirB));
    assert.equal(ra.task, 'task for alpha');
    assert.equal(rb.task, 'task for beta', 'B task must not be overwritten by A');
    assert.deepEqual(ra.writes, ['alpha-file-0.js', 'alpha-file-1.js', 'alpha-file-2.js']);
    assert.deepEqual(rb.writes, ['beta-file-0.js', 'beta-file-1.js']);

    // And on disk, after both finished — no cross-contamination.
    await runWithContext(a, async () => {
      assert.equal(state.readTask(), 'task for alpha');
      assert.equal(Object.keys(state.readFilesTouched().writes).length, 3);
    });
    await runWithContext(b, async () => {
      assert.equal(state.readTask(), 'task for beta');
      assert.equal(Object.keys(state.readFilesTouched().writes).length, 2);
    });
  });

  test('nested runWithContext shadows, then restores the outer context', async () => {
    // The conductor case: a specialist dispatched into its own context must not
    // permanently retarget the parent mission.
    const { runWithContext, currentContext } = await import('../src/runtime/context.js');
    const outer = createContext({ workspace: tmpdir('nest-out') });
    const inner = createContext({ workspace: tmpdir('nest-in') });

    await runWithContext(outer, async () => {
      assert.equal(currentContext(), outer);
      await runWithContext(inner, async () => {
        await new Promise(r => setTimeout(r, 2));
        assert.equal(currentContext(), inner, 'inner scope shadows');
      });
      assert.equal(currentContext(), outer, 'outer restored after inner completes');
    });
  });

  test('concurrent cost tracking attributes tokens to the right run', async () => {
    // costTracker resolves via resolveContext(), so it should follow the ALS
    // store with no explicit ctx argument — proving the 1.3/1.4 migrations
    // compose with implicit propagation.
    const { runWithContext } = await import('../src/runtime/context.js');
    const { startSession, recordUsage, sessionCost } = await import('../src/observability/costTracker.js');
    const a = createContext({ workspace: tmpdir('cc-a') });
    const b = createContext({ workspace: tmpdir('cc-b') });

    async function run(ctx, id, tokens) {
      return runWithContext(ctx, async () => {
        startSession(id);                       // note: no ctx passed
        await new Promise(r => setTimeout(r, 3));
        recordUsage({ prompt_tokens: tokens, completion_tokens: 0 });
        await new Promise(r => setTimeout(r, 3));
        return sessionCost();
      });
    }

    const [ca, cb] = await Promise.all([run(a, 'sess-a', 700), run(b, 'sess-b', 200)]);
    assert.equal(ca.sessionId, 'sess-a');
    assert.equal(cb.sessionId, 'sess-b');
    assert.equal(ca.promptTokens, 700);
    assert.equal(cb.promptTokens, 200);
  });

  test('code outside any run still resolves to ambient', async () => {
    // process.on('exit') handlers and CLI helpers run with no store; they must
    // keep working exactly as before rather than throwing.
    const { currentContext, currentContextOrNull } = await import('../src/runtime/context.js');
    assert.equal(currentContextOrNull(), null);
    assert.equal(currentContext(), getAmbientContext());
  });
});

describe('Phase 1.5 — per-mission checkpoints & child contexts', () => {
  let stateMod;
  beforeEach(async () => { stateMod = await import('../src/state.js'); });
  afterEach(() => resetAmbientContext());

  test('no missionId keeps the legacy checkpoint path (CLI / --resume compat)', async () => {
    const { runWithContext } = await import('../src/runtime/context.js');
    const ctx = createContext({ workspace: tmpdir('cp-legacy') });
    await runWithContext(ctx, async () => {
      assert.equal(stateMod.checkpointRelPath(), '.agent/checkpoint.json');
    });
  });

  test('a missionId routes the checkpoint into its own directory', async () => {
    const { runWithContext } = await import('../src/runtime/context.js');
    const ctx = createContext({ workspace: tmpdir('cp-mission'), missionId: 'ep-42-coder' });
    await runWithContext(ctx, async () => {
      assert.equal(stateMod.checkpointRelPath(), '.agent/missions/ep-42-coder/checkpoint.json');
    });
  });

  test('mission ids are sanitized to a single safe path segment', async () => {
    const { runWithContext } = await import('../src/runtime/context.js');

    // The guarantee: whatever the id, the result is exactly one directory
    // segment under .agent/missions/ that cannot escape it.
    // Note: '' is not in this list — an empty missionId means "no mission" and
    // correctly falls back to the legacy checkpoint path (asserted below).
    const hostile = ['../../etc/passwd', '..', '.', '...', 'a/b\\c', 'x'.repeat(400)];
    for (const missionId of hostile) {
      const ctx = createContext({ workspace: tmpdir('cp-evil'), missionId });
      // eslint-disable-next-line no-await-in-loop
      await runWithContext(ctx, async () => {
        const rel = stateMod.checkpointRelPath();
        assert.match(rel, /^\.agent\/missions\/[A-Za-z0-9._-]+\/checkpoint\.json$/,
          `unsafe path for missionId ${JSON.stringify(missionId)}: ${rel}`);
        const segment = rel.split('/')[2];
        assert.ok(!/^\.+$/.test(segment),
          `dot-segment would escape the mission dir: ${JSON.stringify(missionId)} -> ${segment}`);
        // Normalizing must not climb above the missions directory.
        assert.ok(path.posix.normalize(rel).startsWith('.agent/missions/'),
          `normalized path escaped: ${path.posix.normalize(rel)}`);
      });
    }

    // An empty/absent missionId is "no mission", not a hostile id.
    for (const missionId of ['', null, undefined]) {
      const ctx = createContext({ workspace: tmpdir('cp-empty'), missionId });
      // eslint-disable-next-line no-await-in-loop
      await runWithContext(ctx, async () => {
        assert.equal(stateMod.checkpointRelPath(), '.agent/checkpoint.json',
          `missionId ${JSON.stringify(missionId)} should use the legacy path`);
      });
    }
  });

  test('parallel siblings checkpoint independently — the _ephemeralCheckpoint fix', async () => {
    // Previously both wrote .agent/checkpoint.json, so the workaround was to
    // write nothing at all and leave specialists unresumable. Now each has its
    // own file and BOTH survive.
    const { runWithContext } = await import('../src/runtime/context.js');
    const dir = tmpdir('cp-siblings');
    const parent = createContext({ workspace: dir, missionId: 'ep-1' });
    const coder    = parent.child({ missionId: 'ep-1-coder' });
    const reviewer = parent.child({ missionId: 'ep-1-reviewer' });

    async function work(ctx, step) {
      return runWithContext(ctx, async () => {
        stateMod.initAgentDir();
        await new Promise(r => setTimeout(r, 2));
        stateMod.saveCheckpoint({ step, workingMemory: [] });
        await new Promise(r => setTimeout(r, 2));
        return stateMod.loadCheckpoint().step;
      });
    }

    const [a, b] = await Promise.all([work(coder, 11), work(reviewer, 22)]);
    assert.equal(a, 11);
    assert.equal(b, 22, 'reviewer checkpoint must not be overwritten by coder');
    assert.ok(fs.existsSync(path.join(dir, '.agent/missions/ep-1-coder/checkpoint.json')));
    assert.ok(fs.existsSync(path.join(dir, '.agent/missions/ep-1-reviewer/checkpoint.json')));
  });

  test('children SHARE workspace-scoped state but ISOLATE run state', async () => {
    // The rule that makes sibling specialists correct: they mutate one
    // workspace concurrently (file tracking must accumulate, not race), while
    // cost/traces must stay attributable per specialist.
    const { runWithContext } = await import('../src/runtime/context.js');
    const { startSession, recordUsage, sessionCost } = await import('../src/observability/costTracker.js');
    const dir = tmpdir('cp-share');
    const parent = createContext({ workspace: dir, missionId: 'ep-2' });
    const a = parent.child({ missionId: 'ep-2-a' });
    const b = parent.child({ missionId: 'ep-2-b' });

    await runWithContext(parent, async () => stateMod.initAgentDir());

    await runWithContext(a, async () => {
      stateMod.trackFileWrite('from-a.js', { step: 1 });
      startSession('a'); recordUsage({ prompt_tokens: 10, completion_tokens: 0 });
    });
    await runWithContext(b, async () => {
      stateMod.trackFileWrite('from-b.js', { step: 1 });
      startSession('b'); recordUsage({ prompt_tokens: 99, completion_tokens: 0 });
      stateMod.flushFilesTouched();
    });

    // Shared: one accumulated file-tracking cache, so neither write was lost.
    const seen = await runWithContext(parent, async () =>
      Object.keys(stateMod.readFilesTouched().writes).sort());
    assert.deepEqual(seen, ['from-a.js', 'from-b.js'],
      'siblings share workspace state — neither write may be clobbered');

    // Isolated: per-specialist cost accounting survives.
    assert.equal(sessionCost(a).promptTokens, 10);
    assert.equal(sessionCost(b).promptTokens, 99);
  });

  test('a child with a different workspace does not share parent state', async () => {
    const parent = createContext({ workspace: tmpdir('ws-p') });
    const kid = parent.child({ missionId: 'k' });
    kid.setWorkspace(tmpdir('ws-k'));

    parent.slot('shared', () => ({ tag: 'parent' }), { workspaceScoped: true });
    const kidSlot = kid.slot('shared', () => ({ tag: 'kid' }), { workspaceScoped: true });
    assert.equal(kidSlot.tag, 'kid', 'different workspace ⇒ no sharing');
  });
});

describe('Phase 1.6 — daemon mode owns process lifecycle', () => {
  afterEach(() => resetAmbientContext());

  test('daemonMode is carried on the context and inherited by children', () => {
    const ctx = createContext({ workspace: tmpdir('dm'), daemonMode: true });
    assert.equal(ctx.daemonMode, true);
    assert.equal(ctx.child({ missionId: 'x' }).daemonMode, true, 'children inherit daemon mode');
    assert.equal(createContext({ workspace: tmpdir('dm2') }).daemonMode, false, 'default is CLI mode');
  });

  test('the loop only registers process signal handlers outside daemon mode', () => {
    // Behavioural assertion is impractical without a live LLM, so assert the
    // guard exists and that both exit-hook registrations are gated. An
    // ungated version would leak one listener per mission and let a single
    // mission process.exit() the whole daemon.
    const src = fs.readFileSync(new URL('../src/loop.js', import.meta.url), 'utf-8');
    assert.match(src, /const ownsProcessSignals = !runtimeCtx\.daemonMode/);
    assert.match(src, /if \(ownsProcessSignals\) \{[\s\S]*?process\.on\('SIGTERM'/);
    assert.match(src, /if \(!runtimeCtx\.daemonMode\) process\.on\('exit', closePalace\)/);
    assert.match(src, /if \(runtimeCtx\.daemonMode\) \{[\s\S]*?dispose: \(\) => disconnectAll\(\)/);
    assert.match(src, /runtimeCtx\.requestShutdown = \(\) =>/,
      'daemon mode must expose a cooperative stop');
  });
});

describe('Phase 1.4 — observability is per-context', () => {
  afterEach(() => resetAmbientContext());

  test('cost accumulators do not merge across concurrent runs', async () => {
    const { startSession, recordUsage, sessionCost } = await import('../src/observability/costTracker.js');
    const a = createContext({ workspace: tmpdir('cost-a'), config: { model: 'gpt-4o' } });
    const b = createContext({ workspace: tmpdir('cost-b'), config: { model: 'gpt-4o-mini' } });

    startSession('run-a', 'agent-a', a);
    startSession('run-b', 'agent-b', b);
    recordUsage({ prompt_tokens: 1_000_000, completion_tokens: 0 }, 'execution', a);
    recordUsage({ prompt_tokens:   500_000, completion_tokens: 0 }, 'execution', b);

    const ca = sessionCost(a);
    const cb = sessionCost(b);
    assert.equal(ca.promptTokens, 1_000_000, 'A must not absorb B tokens');
    assert.equal(cb.promptTokens,   500_000, 'B must not absorb A tokens');
    assert.equal(ca.sessionId, 'run-a');
    assert.equal(cb.sessionId, 'run-b');

    // Each context prices against ITS OWN model. Previously both billed at the
    // process-wide config.model, so a conductor running mixed models — the
    // documented cheap/strong split — mis-billed every specialist.
    assert.equal(ca.model, 'gpt-4o');
    assert.equal(cb.model, 'gpt-4o-mini');
    assert.equal(ca.estimatedDollars, 2.5,  '1M prompt tokens @ $2.50/1M');
    assert.equal(cb.estimatedDollars, 0.075, '0.5M prompt tokens @ $0.15/1M');
  });

  test('startSession on one context does not reset another', async () => {
    const { startSession, recordUsage, sessionCost } = await import('../src/observability/costTracker.js');
    const a = createContext({ workspace: tmpdir('cost-r-a') });
    const b = createContext({ workspace: tmpdir('cost-r-b') });

    startSession('a', 'a', a);
    recordUsage({ prompt_tokens: 100, completion_tokens: 50 }, '', a);
    startSession('b', 'b', b);   // would have zeroed A's counters before

    assert.equal(sessionCost(a).totalTokens, 150, 'A survives B starting');
    assert.equal(sessionCost(b).totalTokens, 0);
  });

  test('otel traces and span buffers are per-context', async () => {
    const { startTrace, getTraceId } = await import('../src/otel.js');
    const a = createContext({ workspace: tmpdir('otel-a') });
    const b = createContext({ workspace: tmpdir('otel-b') });

    startTrace('trace-a', a);
    startTrace('trace-b', b);
    assert.equal(getTraceId(a), 'trace-a');
    assert.equal(getTraceId(b), 'trace-b', 'a second run must not hijack the first trace id');
  });

  test('telemetry reads its enabled flag at call time, not module load', async () => {
    const { initTelemetry, track } = await import('../src/observability/telemetry.js');
    const dir = tmpdir('tel');
    const ctx = createContext({ workspace: dir, config: { telemetryEnabled: true } });
    initTelemetry(dir, 'sess-1', ctx);
    track('unit.test', { k: 'v' }, ctx);

    const file = path.join(dir, ctx.config.telemetryDir || '.agent/telemetry', 'events.jsonl');
    assert.ok(fs.existsSync(file), 'enabling telemetry on the context must take effect');
    assert.match(fs.readFileSync(file, 'utf-8'), /"name":"unit\.test"/);

    // A context with it disabled writes nothing, even though the module was
    // already imported while another context had it on.
    const offDir = tmpdir('tel-off');
    const off = createContext({ workspace: offDir, config: { telemetryEnabled: false } });
    initTelemetry(offDir, 'sess-2', off);
    track('should.not.appear', {}, off);
    assert.equal(fs.existsSync(path.join(offDir, '.agent/telemetry', 'events.jsonl')), false);
  });

  test('llm log path is per-context', async () => {
    const { setLLMLogDir } = await import('../src/llm.js');
    const dirA = tmpdir('llm-a');
    const dirB = tmpdir('llm-b');
    const a = createContext({ workspace: dirA });
    const b = createContext({ workspace: dirB });

    setLLMLogDir(dirA, a);
    setLLMLogDir(dirB, b);
    // Both .agent dirs exist independently; B's setup must not have retargeted A.
    assert.ok(fs.existsSync(path.join(dirA, '.agent')));
    assert.ok(fs.existsSync(path.join(dirB, '.agent')));
    assert.notEqual(a.slot('llm:logFile', () => ({ path: null })).path,
                    b.slot('llm:logFile', () => ({ path: null })).path);
  });
});

describe('Phase 1.3 — palace state is per-context', () => {
  afterEach(() => resetAmbientContext());

  test('semantic graph cache does not bleed across workspaces', async () => {
    const graph = await import('../src/palace/semanticGraph.js');
    const a = createContext({ workspace: tmpdir('sem-a') });
    const b = createContext({ workspace: tmpdir('sem-b') });

    graph.assert('snake.js', 'modified_by', 'write_file', 1.0, a);
    assert.equal(graph.count(a), 1);
    assert.equal(graph.count(b), 0, 'workspace B must not see A facts');
    assert.deepEqual(graph.queryBySubject('snake.js', b), []);
  });

  test('procedural success log is per-context', async () => {
    const proc = await import('../src/palace/proceduralIndex.js');
    const a = createContext({ workspace: tmpdir('proc-a') });
    const b = createContext({ workspace: tmpdir('proc-b') });

    // Threshold is 3 successes; feed A exactly 3 and B one.
    for (let i = 0; i < 3; i++) {
      proc.recordSuccess({ tool: 'run_command', args: { command: 'npm test' }, result: 'ok', domain: '' }, a);
    }
    proc.recordSuccess({ tool: 'run_command', args: { command: 'npm test' }, result: 'ok', domain: '' }, b);

    assert.equal(proc.getAllRecipes(a).length, 1, 'A reached the recipe threshold');
    assert.equal(proc.getAllRecipes(b).length, 0, 'B has only 1 success and must not inherit A progress');
  });

  test('palace session holder is per-context and disposes its handle', async () => {
    const { getPalaceSession } = await import('../src/palace/session.js');
    const a = createContext({ workspace: tmpdir('pal-a') });
    const b = createContext({ workspace: tmpdir('pal-b') });

    // Never initialized: both must independently report "no session" rather
    // than sharing one module-level singleton.
    assert.equal(getPalaceSession(a), null);
    assert.equal(getPalaceSession(b), null);

    // The disposer is registered up front, so disposing a context that never
    // opened a database is safe.
    assert.doesNotThrow(() => a.dispose());
    assert.equal(getPalaceSession(b), null, 'disposing A must not disturb B');
  });
});

describe('state.js rides the ambient context', () => {
  let stateMod;

  beforeEach(async () => {
    stateMod = await import('../src/state.js');
  });
  afterEach(() => resetAmbientContext());

  test('setWorkspace/getWorkspace round-trip through the context', () => {
    const dir = tmpdir('state-ws');
    stateMod.setWorkspace(dir);
    assert.equal(stateMod.getWorkspace(), path.resolve(dir));
    assert.equal(getAmbientContext().workspace, path.resolve(dir));
  });

  test('file-tracking cache does not leak across workspaces', () => {
    // Previously this was a module-level `let` manually nulled inside
    // setWorkspace(); it is now a workspace-scoped slot, so the invalidation is
    // structural rather than a thing someone must remember to do.
    const dirA = tmpdir('state-a');
    stateMod.setWorkspace(dirA);
    stateMod.initAgentDir();
    stateMod.trackFileWrite('only-in-a.js', { step: 1 });
    stateMod.flushFilesTouched();
    assert.ok('only-in-a.js' in stateMod.readFilesTouched().writes, 'A recorded its own write');

    const dirB = tmpdir('state-b');
    stateMod.setWorkspace(dirB);
    stateMod.initAgentDir();
    stateMod.trackFileWrite('only-in-b.js', { step: 1 });
    stateMod.flushFilesTouched();

    const bWrites = stateMod.readFilesTouched().writes;
    assert.ok('only-in-b.js' in bWrites, 'B recorded its own write');
    assert.equal('only-in-a.js' in bWrites, false, 'workspace B must not inherit A writes');

    // And A's file on disk must not have been clobbered by B's flush.
    stateMod.setWorkspace(dirA);
    assert.ok('only-in-a.js' in stateMod.readFilesTouched().writes, 'A is intact after B ran');
    assert.equal('only-in-b.js' in stateMod.readFilesTouched().writes, false);
  });
});
