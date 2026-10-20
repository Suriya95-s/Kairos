export function resolveMemoryMaps({ domains = {}, ontologyTags = [], bankRegistry = {}, rules = {} }) {
  const bankScores = {};

  for (const [domain, score] of Object.entries(domains)) {
    const banks = rules?.domainToBanks?.[domain] || [];
    for (const bank of banks) {
      bankScores[bank] = (bankScores[bank] || 0) + score;
    }
  }

  for (const tag of ontologyTags) {
    const bank = bankRegistry[tag];
    if (bank) bankScores[bank] = (bankScores[bank] || 0) + 0.45;
  }

  if (Object.keys(bankScores).length === 0) {
    bankScores.project = 0.5;
  }

  const rankedBanks = Object.entries(bankScores)
    .sort((a, b) => b[1] - a[1])
    .map(([bank, score]) => ({ bank, score: Number(score.toFixed(2)) }));

  return {
    bankScores,
    rankedBanks,
    primaryBank: rankedBanks[0]?.bank || 'project',
  };
}
