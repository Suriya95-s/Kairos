import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import config from '../src/config.js';
import { WorkingMemory } from '../src/memory.js';
import {
  initAgentDir,
  setWorkspace,
  writeTask,
  readLmmaActiveRoute,
  readLmmaWorkingMemory,
  readLmmaBank,
  saveCheckpoint,
  loadCheckpoint,
  getStateHash,
  readRwkvMeta,
} from '../src/state.js';
import { prepareLmmaStep, finalizeLmmaStep } from '../src/lmma/index.js';
import { buildMessages } from '../src/context.js';
import { getLmmaCompactionStatus } from '../src/compaction.js';

let testDir;

function setupWorkspace() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lmma-'));
  setWorkspace(testDir);
  initAgentDir();
  writeTask('Integrate LMMA memory routing into the advanced loop.');
}

function cleanupWorkspace() {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

describe('LMMA Integration', () => {
  beforeEach(() => setupWorkspace());
  afterEach(() => cleanupWorkspace());

  test('seeds LMMA filesystem state during agent dir init', () => {
    const expected = [
      config.lmmaOntologyFile,
      config.lmmaBankRegistryFile,
      config.lmmaActiveRouteFile,
      `${config.lmmaBanksDir}/code.jsonl`,
      `${config.lmmaBanksDir}/project.jsonl`,
    ];
    for (const relPath of expected) {
      assert.ok(fs.existsSync(path.join(testDir, relPath)), `Expected LMMA file ${relPath}`);
    }
  });

  test('prepareLmmaStep writes active route and working memory packet', () => {
    const memory = new WorkingMemory();
    memory.push({
      step: 1,
      action: 'read_file',
      args: { path: 'src/context.js' },
      result: 'Need to integrate routed memory into context.js',
      error: false,
      timestamp: Date.now(),
    });

    const result = prepareLmmaStep({
      step: 2,
      stage: 'execution',
      task: 'Integrate LMMA memory routing into the advanced loop.',
      currentSubtask: 'Wire frontend fetch logic to backend API and add a smoke test',
      memory,
    });

    assert.equal(result.activeRoute.primaryBank, 'api');
    assert.ok(result.activeRoute.jumpBanks.includes('frontend'));
    assert.ok(result.workingMemory.routePath.includes('api'));

    const activeRoute = readLmmaActiveRoute();
    const packet = readLmmaWorkingMemory();
    assert.equal(activeRoute.primaryBank, 'api');
    assert.ok(packet.summary.includes('Primary bank api'));
  });

  test('finalizeLmmaStep writes routed memory into the selected bank', () => {
    const memory = new WorkingMemory();
    prepareLmmaStep({
      step: 3,
      stage: 'verification',
      task: 'Integrate LMMA memory routing into the advanced loop.',
      currentSubtask: 'Run verification smoke tests and persist learnings',
      memory,
    });

    finalizeLmmaStep({
      step: 3,
      stage: 'verification',
      action: { tool: 'run_command', args: { command: 'node --test tests/lmma-integration.test.js' } },
      toolResult: 'Exit code 0:\nSMOKE OK',
      toolError: false,
    });

    const testingBank = readLmmaBank('testing');
    assert.equal(testingBank.length, 1);
    assert.ok(testingBank[0].summary.includes('SMOKE OK'));
  });

  test('LMMA context is injected into buildMessages and saved in checkpoints', () => {
    const memory = new WorkingMemory();
    prepareLmmaStep({
      step: 4,
      stage: 'planning',
      task: 'Integrate LMMA memory routing into the advanced loop.',
      currentSubtask: 'Plan resume and compaction support',
      memory,
    });

    const messages = buildMessages({
      step: 4,
      memory,
      stageState: null,
      workspace: testDir,
    });
    assert.ok(messages[1].content.includes('LMMA Routed Memory'));

    saveCheckpoint({
      step: 4,
      bank_focus: readLmmaActiveRoute().primaryBank,
      active_route: readLmmaActiveRoute().routePath,
      active_ontology_tags: readLmmaActiveRoute().ontologyTags,
      rwkv_state_hash: getStateHash(),
      lmma_packet_version: 2,
      workingMemory: memory.toJSON(),
      lmma: {
        activeRoute: readLmmaActiveRoute(),
        workingMemory: readLmmaWorkingMemory(),
      },
    });

    const checkpoint = loadCheckpoint();
    assert.equal(checkpoint.lmma.activeRoute.primaryBank, readLmmaActiveRoute().primaryBank);
    assert.equal(checkpoint.bank_focus, readLmmaActiveRoute().primaryBank);
    assert.equal(checkpoint.lmma_packet_version, 2);
  });

  test('compaction status reports LMMA artifacts as preserved', () => {
    prepareLmmaStep({
      step: 5,
      stage: 'execution',
      task: 'Integrate LMMA memory routing into the advanced loop.',
      currentSubtask: 'Keep LMMA route traces stable across compaction',
      memory: new WorkingMemory(),
    });

    const status = getLmmaCompactionStatus();
    assert.equal(status.preservesOntologyFiles, true);
    assert.equal(status.preservesRouteTraces, true);
    assert.ok(status.routeTraceCount >= 1);
  });

  test('RWKV metadata is initialized in the workspace state surface', () => {
    const meta = readRwkvMeta();
    assert.equal(meta.stateHash, 'sha256:none');
    assert.equal(meta.controllerAvailable, false);
  });
});
