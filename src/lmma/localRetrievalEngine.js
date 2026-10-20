function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function normalizeToken(token) {
  return String(token || '').toLowerCase().trim();
}

function normalizeQueryTokens(entities) {
  return [...new Set(
    entities
      .map(normalizeToken)
      .flatMap((entity) => entity.split(/[^\w./-]+/))
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && token.length <= 24)
  )].slice(0, 16);
}

function normalizeList(items = []) {
  return items.map((item) => normalizeToken(item)).filter(Boolean);
}

function computeOverlapScore(left = [], right = []) {
  if (!left.length || !right.length) return 0;
  const leftSet = new Set(normalizeList(left));
  const rightSet = new Set(normalizeList(right));
  let overlap = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) overlap++;
  }
  return overlap / Math.max(leftSet.size, rightSet.size);
}

// Seeded/legacy entries carry only `content`/`tags`, whereas writeback entries
// carry `title`/`summary`/`entities`/`ontology_tags`. Map both onto the canonical
// shape so seeds are actually retrievable (previously they scored ~0 and were
// effectively invisible to recall).
function canonicalizeEntry(entry) {
  const e = entry || {};
  const content = e.content != null ? String(e.content) : '';
  return {
    title: e.title ?? content.slice(0, 80),
    summary: e.summary ?? content,
    entities: e.entities ?? e.tags ?? [],
    ontology_tags: e.ontology_tags ?? e.tags ?? [],
    importance: e.importance,
  };
}

function scoreCandidate(rawEntry, queryTokens, ontologyTags, entities, exactOnly = false) {
  const entry = canonicalizeEntry(rawEntry);
  const title = normalizeToken(entry.title);
  const summary = normalizeToken(entry.summary);
  const entryEntities = normalizeList(entry.entities);
  const entryTags = normalizeList(entry.ontology_tags);
  const loweredTags = normalizeList(ontologyTags);
  const loweredEntities = normalizeList(entities);

  const exactTitleHits = queryTokens.filter((token) => title.includes(token)).length;
  const summaryHits = queryTokens.filter((token) => summary.includes(token)).length;
  const exactHit = exactTitleHits > 0 || entryEntities.some((entity) => queryTokens.includes(entity));
  if (exactOnly && !exactHit) return { score: 0, exactHit: false };

  const tagOverlap = computeOverlapScore(loweredTags, entryTags);
  const entityOverlap = computeOverlapScore(loweredEntities, entryEntities);
  const importance = clamp(Number(entry.importance || 0));

  const score = clamp(
    (exactTitleHits ? 0.34 : 0) +
    clamp(summaryHits * 0.07, 0, 0.21) +
    tagOverlap * 0.18 +
    entityOverlap * 0.17 +
    importance * 0.1
  );

  return { score, exactHit };
}

function collectGraphBanks(selectedBanks = [], crossMapGraph = {}) {
  const expanded = new Set(selectedBanks);
  for (const bank of selectedBanks) {
    for (const neighbor of (crossMapGraph?.[bank] || []).slice(0, 2)) {
      expanded.add(neighbor);
    }
  }
  return [...expanded];
}

function buildCandidateSet({ banks, bankEntries, queryTokens, ontologyTags, entities, exactOnly = false }) {
  const candidates = [];
  for (const bank of banks) {
    const entries = bankEntries[bank] || [];
    for (const entry of entries) {
      const { score, exactHit } = scoreCandidate(entry, queryTokens, ontologyTags, entities, exactOnly);
      if ((exactOnly && exactHit) || (!exactOnly && (exactHit || score >= 0.18))) {
        candidates.push({ bank, entry, score: Number(score.toFixed(2)), exactHit });
      }
    }
  }
  return candidates;
}

function rerankCandidates(candidates = []) {
  return [...candidates]
    .sort((a, b) => {
      if (b.exactHit !== a.exactHit) return Number(b.exactHit) - Number(a.exactHit);
      if ((b.entry.importance || 0) !== (a.entry.importance || 0)) return (b.entry.importance || 0) - (a.entry.importance || 0);
      return b.score - a.score;
    })
    .slice(0, 8)
    .map((candidate, index) => ({
      ...candidate,
      rerankedScore: Number(clamp(candidate.score + Math.max(0, 0.06 - index * 0.01)).toFixed(2)),
      retrievalStage: candidate.exactHit ? 'exact' : 'graph-rerank',
    }))
    .map(({ rerankedScore, ...candidate }) => ({ ...candidate, score: rerankedScore }));
}

export function retrieveLocalMemory({
  bankEntries = {},
  selectedBanks = [],
  entities = [],
  ontologyTags = [],
  crossMapGraph = {},
}) {
  const queryTokens = normalizeQueryTokens(entities);
  const exactCandidates = buildCandidateSet({
    banks: selectedBanks,
    bankEntries,
    queryTokens,
    ontologyTags,
    entities,
    exactOnly: true,
  });

  const graphBanks = collectGraphBanks(selectedBanks, crossMapGraph);
  const graphCandidates = buildCandidateSet({
    banks: graphBanks,
    bankEntries,
    queryTokens,
    ontologyTags,
    entities,
    exactOnly: false,
  });

  let candidatePool = [...exactCandidates];
  const existingIds = new Set(candidatePool.map((item) => item.entry.memory_id));
  for (const candidate of graphCandidates) {
    if (!existingIds.has(candidate.entry.memory_id)) {
      candidatePool.push(candidate);
      existingIds.add(candidate.entry.memory_id);
    }
  }

  if (candidatePool.length < 3) {
    const adjacentBanks = graphBanks.filter((bank) => !selectedBanks.includes(bank));
    const adjacentCandidates = buildCandidateSet({
      banks: adjacentBanks,
      bankEntries,
      queryTokens,
      ontologyTags,
      entities,
      exactOnly: false,
    });
    for (const candidate of adjacentCandidates) {
      if (!existingIds.has(candidate.entry.memory_id)) {
        candidatePool.push(candidate);
        existingIds.add(candidate.entry.memory_id);
      }
    }
  }

  return rerankCandidates(candidatePool);
}
