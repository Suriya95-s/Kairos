function formatConfidenceLines(confidence = {}) {
  return Object.entries(confidence)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([bank, score]) => `- ${bank}: ${Number(score).toFixed(2)}`);
}

export function buildLmmaContextBlock({ activeRoute, workingMemory }) {
  if (!activeRoute || !workingMemory) return '';

  const SHOWN = 3;
  const allMemories = workingMemory.retrievedMemories || [];
  const topMemories = allMemories.slice(0, SHOWN).map((item) =>
    `- [${item.bank}] ${item.title}: ${item.summary}`
  );
  // Overflow signal: never silently drop retrieved memories. If more than SHOWN
  // hits matched, tell the agent how many were withheld and from which banks so
  // it can refine the route or explicitly ask to surface more.
  if (allMemories.length > SHOWN) {
    const withheld = allMemories.slice(SHOWN);
    const byBank = {};
    for (const m of withheld) byBank[m.bank] = (byBank[m.bank] || 0) + 1;
    const breakdown = Object.entries(byBank).map(([bank, n]) => `${bank}:${n}`).join(', ');
    topMemories.push(`- +${withheld.length} more retrieved (showing ${SHOWN} of ${allMemories.length}). Withheld by bank: ${breakdown}. Refine entities/route to surface specific ones.`);
  }
  const recentTraces = (workingMemory.recentRouteTraces || []).slice(-2).map((trace) =>
    `- step ${trace.step}: ${trace.route_path?.join(' -> ') || trace.primary_bank || 'project'}${trace.cache_hit ? ' (cache hit)' : ''}`
  );
  const guidance = [];
  if ((activeRoute.unresolvedGaps || []).length > 0) {
    guidance.push(`Route gaps: ${activeRoute.unresolvedGaps.join(' | ')}`);
  }
  if ((activeRoute.controller?.confidence || 0) < 0.6) {
    guidance.push('LMMA confidence is low; use concrete file or command evidence before broad bank jumps.');
  }
  if (Number(activeRoute.consecutiveBankSteps || 0) > 5) {
    guidance.push('The route has stayed in the same bank for several steps; consider a targeted cross-bank jump if progress stalls.');
  }

  return [
    '## LMMA Routed Memory',
    '### Knowledge',
    `Route path: ${(activeRoute.routePath || [activeRoute.primaryBank, ...(activeRoute.jumpBanks || [])]).filter(Boolean).join(' -> ') || 'project'}`,
    `Primary bank: ${activeRoute.primaryBank || 'project'}`,
    `Ontology tags: ${(activeRoute.ontologyTags || []).join(', ') || 'none'}`,
    `Entities: ${(activeRoute.entities || []).slice(0, 8).join(', ') || 'none'}`,
    topMemories.length ? topMemories.join('\n') : '- No matching bank memories retrieved yet.',
    '',
    '### State',
    `Bank confidence: ${(formatConfidenceLines(activeRoute.bankConfidence || {})).join('\n') || '- none'}`,
    `Route summary: ${activeRoute.routeSummary || 'none'}`,
    `Unresolved gaps: ${(activeRoute.unresolvedGaps || []).join(' | ') || 'none'}`,
    '',
    '### Session',
    workingMemory.summary || 'No routed memory packet available.',
    `Cache status: ${workingMemory.cacheStatus || 'unknown'}`,
    recentTraces.length ? `Recent routes:\n${recentTraces.join('\n')}` : 'Recent routes: none',
    '',
    '### Guidance',
    workingMemory.focusHint || 'No route focus hint.',
    guidance.length ? guidance.join('\n') : 'No extra LMMA guidance.',
  ].filter(Boolean).join('\n');
}
