export function composeWorkingMemoryPacket({
  step,
  stage,
  task,
  selectedBanks = [],
  primaryBank,
  jumpBanks = [],
  ontologyTags = [],
  entities = [],
  retrievalHits = [],
  unresolvedGaps = [],
  bankConfidence = {},
  recentRouteTraces = [],
  cacheStatus = 'cold',
}) {
  const memories = retrievalHits.map(({ bank, entry, score }) => ({
    bank,
    memoryId: entry.memory_id,
    title: entry.title,
    summary: entry.summary,
    score: Number(score.toFixed(2)),
    ontologyTags: entry.ontology_tags || [],
  }));

  return {
    step,
    stage,
    summary: `Primary bank ${primaryBank}; selected banks ${selectedBanks.join(', ') || 'none'}. Retrieved ${memories.length} memory blocks.`,
    focusHint: primaryBank ? `Stay anchored in the ${primaryBank} bank unless a concrete blocker requires a jump.` : '',
    routePath: [primaryBank, ...jumpBanks].filter(Boolean),
    banks: selectedBanks,
    retrievedMemories: memories,
    ontologyTags,
    entities,
    unresolvedGaps,
    bankConfidence,
    cacheStatus,
    recentRouteTraces: recentRouteTraces.slice(-2),
    task,
    generatedAt: new Date().toISOString(),
  };
}
