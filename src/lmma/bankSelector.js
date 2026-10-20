function getStageBankWeights(stageBanks = []) {
  return new Map(stageBanks.map((bank, index) => [bank, Math.max(0.2, 1 - index * 0.14)]));
}

export function selectBanks({ primaryBank, jumpBanks = [], stage = '', rules = {} }) {
  const stageBanks = rules?.stagePriorities?.[stage] || [];
  const stageWeights = getStageBankWeights(stageBanks);
  const scored = new Map();

  const add = (bank, score) => {
    if (!bank) return;
    scored.set(bank, Math.max(score, scored.get(bank) || 0));
  };

  add(primaryBank, 1.25);
  jumpBanks.forEach((bank, index) => add(bank, 0.92 - index * 0.08));
  stageBanks.forEach((bank) => add(bank, stageWeights.get(bank) || 0.3));

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([bank]) => bank);
}
