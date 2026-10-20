import crypto from 'node:crypto';
import {
  readTask,
  readLmmaJSON,
  readLmmaBank,
  readLmmaActiveRoute,
  readLmmaRetrievalCache,
  readLmmaImportance,
  readLmmaRouteTraces,
  writeLmmaActiveRoute,
  writeLmmaWorkingMemory,
  writeLmmaRetrievalCache,
  writeLmmaImportance,
  appendLmmaRouteTrace,
  appendLmmaBankEntry,
} from '../state.js';
import config from '../config.js';
import { detectDomains } from './domainDetector.js';
import { extractEntitiesAndIntents } from './entityIntentExtractor.js';
import { mapOntology } from './ontologyMapper.js';
import { resolveMemoryMaps } from './memoryMapResolver.js';
import { pickCrossMapJumps } from './crossMapJumpController.js';
import { selectBanks } from './bankSelector.js';
import { retrieveLocalMemory } from './localRetrievalEngine.js';
import { composeWorkingMemoryPacket } from './workingMemoryComposer.js';
import { buildRouteTrace } from './routeTrace.js';
import { buildMemoryWriteback } from './memoryWriteback.js';
import { scoreImportance, computeLearnedUtility, updateUtility } from './importanceScorer.js';

function hashRouteKey(input) {
  return crypto.createHash('sha1').update(JSON.stringify(input)).digest('hex');
}

function loadBankEntries(selectedBanks, crossMapGraph = {}) {
  const banks = new Set(selectedBanks);
  for (const bank of selectedBanks) {
    for (const neighbor of (crossMapGraph?.[bank] || []).slice(0, 2)) {
      banks.add(neighbor);
    }
  }
  return Object.fromEntries([...banks].map((bank) => [bank, readLmmaBank(bank)]));
}

function buildRouteSummary(primaryBank, jumpBanks, retrievalHits) {
  const memoryTitles = retrievalHits.slice(0, 3).map(({ entry }) => entry.title).filter(Boolean);
  return [
    `Route: ${[primaryBank, ...jumpBanks].filter(Boolean).join(' -> ') || 'project'}`,
    memoryTitles.length ? `Top memories: ${memoryTitles.join(' | ')}` : 'Top memories: none',
  ].join(' | ');
}

export function prepareLmmaStep({
  step,
  stage = '',
  task = '',
  currentSubtask = '',
  memory,
  controller = { mode: 'hosted-llm', confidence: 0, fallbackReason: '' },
}) {
  const startedAt = Date.now();
  const rules = readLmmaJSON(config.lmmaRulesFile, {});
  const bankRegistry = readLmmaJSON(config.lmmaBankRegistryFile, {});
  const taxonomy = readLmmaJSON(config.lmmaTaxonomyFile, {});
  const crossMapGraph = readLmmaJSON(config.lmmaCrossMapGraphFile, {});
  const previousRoute = readLmmaActiveRoute();
  const recentActions = memory.getRecent(4).map((entry) => `${entry.action} ${JSON.stringify(entry.args || {})}`);
  const recentResults = memory.getRecent(3).map((entry) => String(entry.result || '').slice(0, 120));

  const domains = detectDomains({ task, currentSubtask, stage, recentActions, recentResults });
  const { entities, intents } = extractEntitiesAndIntents({ task, currentSubtask, recentActions, recentResults, taxonomy });
  const ontologyTags = mapOntology({ entities, domains, taxonomy });
  const resolved = resolveMemoryMaps({ domains, ontologyTags, bankRegistry, rules });
  const jumpBanks = pickCrossMapJumps(resolved.primaryBank, crossMapGraph, resolved.rankedBanks);
  const selectedBanks = selectBanks({ primaryBank: resolved.primaryBank, jumpBanks, stage, rules });

  const cache = readLmmaRetrievalCache();
  const routeKey = hashRouteKey({ stage, task: currentSubtask || task, selectedBanks, entities, ontologyTags });
  const cachedHitIds = cache.entries?.[routeKey]?.memoryIds || [];
  const bankEntries = loadBankEntries(selectedBanks, crossMapGraph);
  const retrievalHits = retrieveLocalMemory({
    bankEntries,
    selectedBanks,
    entities,
    ontologyTags,
    crossMapGraph,
  });
  const effectiveHits = retrievalHits.length > 0
    ? retrievalHits
    : selectedBanks.flatMap((bank) => (bankEntries[bank] || []).slice(-1).map((entry) => ({ bank, entry, score: 0.4, exactHit: false })));
  const routePath = [resolved.primaryBank, ...jumpBanks].filter(Boolean);
  const routeSummary = buildRouteSummary(resolved.primaryBank, jumpBanks, effectiveHits);
  const recentRouteTraces = readLmmaRouteTraces().slice(-2);
  const consecutiveBankSteps = previousRoute?.primaryBank === resolved.primaryBank
    ? Number(previousRoute?.consecutiveBankSteps || 0) + 1
    : 1;

  const workingMemory = composeWorkingMemoryPacket({
    step,
    stage,
    task: currentSubtask || task || readTask(),
    selectedBanks,
    primaryBank: resolved.primaryBank,
    jumpBanks,
    ontologyTags,
    entities,
    retrievalHits: effectiveHits,
    unresolvedGaps: effectiveHits.length === 0 ? ['No matching LMMA memories found; gather fresh evidence.'] : [],
    bankConfidence: resolved.bankScores,
    recentRouteTraces,
    cacheStatus: cachedHitIds.length > 0 ? 'hit' : 'miss',
  });

  const activeRoute = {
    step,
    stage,
    task: currentSubtask || task,
    domains,
    entities,
    intents,
    ontologyTags,
    primaryBank: resolved.primaryBank,
    jumpBanks,
    selectedBanks,
    routePath,
    routeSummary,
    bankConfidence: resolved.bankScores,
    unresolvedGaps: workingMemory.unresolvedGaps,
    retrievalHits: effectiveHits.map(({ bank, entry, score }) => ({
      bank,
      memory_id: entry.memory_id,
      title: entry.title,
      score: Number(score.toFixed(2)),
    })),
    cacheHit: cachedHitIds.length > 0,
    consecutiveBankSteps,
    controller,
    updatedAt: new Date().toISOString(),
  };

  writeLmmaActiveRoute(activeRoute);
  writeLmmaWorkingMemory(workingMemory);
  writeLmmaRetrievalCache({
    ...cache,
    version: 2,
    entries: {
      ...(cache.entries || {}),
      [routeKey]: {
        memoryIds: effectiveHits.map(({ entry }) => entry.memory_id).filter(Boolean),
        routePath,
        updatedAt: new Date().toISOString(),
      },
    },
  });

  const routeTrace = buildRouteTrace({
    step,
    stage,
    subtask: currentSubtask || task,
    domains,
    entities,
    ontologyTags,
    primaryBank: resolved.primaryBank,
    jumpBanks,
    retrievalHits: effectiveHits,
    cacheHit: cachedHitIds.length > 0,
    latencyMs: Date.now() - startedAt,
    controller,
    routeSummary,
  });
  appendLmmaRouteTrace(routeTrace);

  return { activeRoute, workingMemory, routeTrace };
}

export function finalizeLmmaStep({
  step,
  stage = '',
  action,
  toolResult,
  toolError,
}) {
  const activeRoute = readLmmaActiveRoute();
  const importanceMap = readLmmaImportance();
  // Learned-importance feedback: read the prior utility for this memory's bank
  // and tags, nudge the score by it, then update the utility EMA from this
  // step's outcome so future scores reflect what has actually been useful.
  const _bankForUtility = activeRoute?.primaryBank || 'project';
  const _tagsForUtility = activeRoute?.ontologyTags || [];
  const learnedUtility = computeLearnedUtility(importanceMap.utility, _bankForUtility, _tagsForUtility);
  const importance = scoreImportance({
    actionTool: action.tool,
    toolError,
    stage,
    retrievalHits: activeRoute?.retrievalHits || [],
    learnedUtility,
  });
  const updatedUtility = updateUtility(importanceMap.utility, _bankForUtility, _tagsForUtility, !toolError);
  const writeback = buildMemoryWriteback({
    step,
    stage,
    action,
    toolResult,
    toolError,
    activeRoute,
    importance,
  });

  if (writeback.entry) {
    appendLmmaBankEntry(writeback.bank, writeback.entry);
  }

  writeLmmaImportance({
    ...importanceMap,
    version: 2,
    banks: {
      ...(importanceMap.banks || {}),
      [writeback.bank]: Math.max(importance, importanceMap.banks?.[writeback.bank] || 0),
    },
    memories: writeback.entry ? {
      ...(importanceMap.memories || {}),
      [writeback.entry.memory_id]: importance,
    } : (importanceMap.memories || {}),
    ontologyTags: {
      ...(importanceMap.ontologyTags || {}),
      ...Object.fromEntries((activeRoute?.ontologyTags || []).map((tag) => [tag, importance])),
    },
    routes: {
      ...(importanceMap.routes || {}),
      [`${step}:${activeRoute?.primaryBank || 'project'}`]: importance,
    },
    utility: updatedUtility,
    bankStats: {
      ...(importanceMap.bankStats || {}),
      [writeback.bank]: {
        lowImportanceCount: Number(importanceMap.bankStats?.[writeback.bank]?.lowImportanceCount || 0) + Number(writeback.stats?.lowImportanceCount || 0),
        compactCount: Number(importanceMap.bankStats?.[writeback.bank]?.compactCount || 0) + Number(writeback.stats?.compactCount || 0),
        fullCount: Number(importanceMap.bankStats?.[writeback.bank]?.fullCount || 0) + Number(writeback.stats?.fullCount || 0),
        lastActionTool: writeback.stats?.lastActionTool || importanceMap.bankStats?.[writeback.bank]?.lastActionTool || '',
        lastStage: writeback.stats?.lastStage || importanceMap.bankStats?.[writeback.bank]?.lastStage || '',
      },
    },
  });

  return { writeback, importance };
}
