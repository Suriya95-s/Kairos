export function pickCrossMapJumps(primaryBank, crossMapGraph = {}, rankedBanks = []) {
  const neighbors = crossMapGraph?.[primaryBank] || [];
  const rankedSet = new Set(rankedBanks.map((entry) => entry.bank));
  const jumps = [];

  for (const bank of neighbors) {
    if (bank !== primaryBank) jumps.push(bank);
    if (jumps.length >= 2) break;
  }

  for (const entry of rankedBanks) {
    if (entry.bank === primaryBank || jumps.includes(entry.bank)) continue;
    if (rankedSet.has(entry.bank)) jumps.push(entry.bank);
    if (jumps.length >= 3) break;
  }

  return jumps;
}
