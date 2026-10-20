import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { extractEntitiesAndIntents } from '../src/lmma/entityIntentExtractor.js';
import { detectDomains } from '../src/lmma/domainDetector.js';
import { retrieveLocalMemory } from '../src/lmma/localRetrievalEngine.js';
import { buildMemoryWriteback } from '../src/lmma/memoryWriteback.js';
import { buildRunMetrics, compareRunMetrics } from '../src/lmma/benchmark.js';
import { selectBanks } from '../src/lmma/bankSelector.js';

describe('LMMA heuristics', () => {
  test('entity extraction trims noisy paragraphs and giant commands', () => {
    const { entities, intents } = extractEntitiesAndIntents({
      task: 'Build a snake game in Python with config.py, game.py, and _render_check.py. Use python3 -c "print(123)" for verification.',
      currentSubtask: 'Fix snake.py and board.py render behavior.',
      recentResults: ['python3 -c "from snake.game import Game; print(\'game OK\')"'],
    });

    assert.ok(entities.includes('config.py'));
    assert.ok(entities.includes('game.py'));
    assert.ok(!entities.some((entity) => entity.length > 40), 'entities should stay compact');
    assert.ok(intents.includes('implement'));
    assert.ok(intents.includes('verify'));
  });

  test('domain detection avoids unrelated bank jumps', () => {
    const domains = detectDomains({
      task: 'Build a terminal snake game in Python.',
      currentSubtask: 'Run python3 _render_check.py and fix snake.py rendering.',
      stage: 'execution',
      recentActions: ['run_command {"command":"python3 _render_check.py"}', 'read_file {"path":"snake/board.py"}'],
      recentResults: ['render OK'],
    });

    assert.ok(domains.code >= 0.18);
    assert.ok(domains.testing >= 0.18);
    assert.ok(!('api' in domains), 'snake execution should not route into api by default');
    assert.ok(!('database' in domains), 'snake execution should not route into database by default');
  });

  test('retrieval scores remain bounded and meaningful', () => {
    const hits = retrieveLocalMemory({
      selectedBanks: ['code', 'verification'],
      crossMapGraph: { code: ['testing'], verification: ['testing'] },
      entities: ['snake.py', 'render', 'board.py'],
      ontologyTags: ['File', 'Test', 'CodeArtifact'],
      bankEntries: {
        code: [
          {
            memory_id: 'mem-1',
            title: 'Fix render path in board.py',
            summary: 'board.py render now catches bottom-right curses writes',
            entities: ['board.py', 'render'],
            ontology_tags: ['File', 'CodeArtifact'],
            importance: 0.7,
          },
        ],
        verification: [
          {
            memory_id: 'mem-2',
            title: 'Smoke test passed',
            summary: 'render OK',
            entities: ['_render_check.py'],
            ontology_tags: ['Test'],
            importance: 0.6,
          },
        ],
      },
    });

    assert.equal(hits[0].entry.memory_id, 'mem-1');
    assert.ok(hits[0].score <= 1);
    assert.ok(hits[0].score >= 0.22);
  });

  test('writeback routes plan and docs outside the default code bank', () => {
    const planWriteback = buildMemoryWriteback({
      step: 10,
      stage: 'planning',
      action: { tool: 'update_plan', args: {} },
      toolResult: 'Plan updated',
      toolError: false,
      activeRoute: { primaryBank: 'code', selectedBanks: ['code', 'plan'], ontologyTags: ['Plan'] },
      importance: 0.7,
    });
    const docsWriteback = buildMemoryWriteback({
      step: 11,
      stage: 'execution',
      action: { tool: 'write_file', args: { path: 'README.md' } },
      toolResult: 'README updated',
      toolError: false,
      activeRoute: { primaryBank: 'code', selectedBanks: ['code', 'docs'], ontologyTags: ['ProjectKnowledge'] },
      importance: 0.65,
    });

    assert.equal(planWriteback.bank, 'plan');
    assert.equal(docsWriteback.bank, 'docs');
  });

  test('bank selection applies stage bias without overriding the primary bank', () => {
    const banks = selectBanks({
      primaryBank: 'api',
      jumpBanks: ['frontend'],
      stage: 'verification',
      rules: {
        stagePriorities: {
          verification: ['testing', 'commands', 'verification', 'learnings'],
        },
      },
    });

    assert.equal(banks[0], 'api');
    assert.ok(banks.includes('testing'));
    assert.ok(banks.includes('verification'));
  });

  test('writeback skips low-importance full memory blocks', () => {
    const lowImportance = buildMemoryWriteback({
      step: 12,
      stage: 'execution',
      action: { tool: 'read_file', args: { path: 'README.md' } },
      toolResult: 'Read README',
      toolError: false,
      activeRoute: { primaryBank: 'docs', selectedBanks: ['docs'], ontologyTags: ['ProjectKnowledge'] },
      importance: 0.2,
    });

    assert.equal(lowImportance.mode, 'aggregate_only');
    assert.equal(lowImportance.entry, null);
  });

  test('benchmark comparison reports baseline vs LMMA deltas', () => {
    const baseline = buildRunMetrics({
      stepCount: 50,
      routeTraces: [],
      recoveryEvents: [{ type: 'tool_error' }, { type: 'tool_error' }, { type: 'parse_error' }],
      commandsRun: [{ command: 'python3 _smoke_test.py', success: false }, { command: 'python3 _smoke_test.py', success: false }],
      checkpoint: { compactionCount: 1 },
    });
    const lmma = buildRunMetrics({
      stepCount: 35,
      routeTraces: [{ primary_bank: 'code' }, { primary_bank: 'code' }, { primary_bank: 'testing' }],
      recoveryEvents: [{ type: 'tool_error' }],
      commandsRun: [{ command: 'python3 _smoke_test.py', success: false }, { command: 'python3 _smoke_test.py', success: true }],
      checkpoint: { compactionCount: 2, stageState: { currentStage: 'finalization' }, verificationFailures: 0 },
    });
    const comparison = compareRunMetrics(baseline, lmma);

    assert.ok(comparison.stepReduction > 0);
    assert.ok(comparison.mistakeReduction > 0);
    assert.ok(comparison.routeStabilityDelta >= -1 && comparison.routeStabilityDelta <= 1);
  });
});
