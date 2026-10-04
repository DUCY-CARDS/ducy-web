// Upswing Poker PLO preflop guide, raise first in (v4, Monker Solver 6-max 100bb):
// open frequency by hand class and suitedness [ds, ss, rainbow] per position.
// https://upswingpoker.com/wp-content/uploads/2020/04/PLO-Preflop-Guide-RFI-v4-UpswingPoker.pdf
export const POSITIONS = {UTG: 17.9, HJ: 21.8, CO: 30.0, BTN: 47.2};
export const CHART = {
  AA:      {UTG: [100, 100, 100], HJ: [100, 100, 100], CO: [100, 100, 100], BTN: [100, 100, 100]},
  KK:      {UTG: [100, 78, 35], HJ: [100, 90, 55], CO: [100, 97, 88], BTN: [100, 99, 96]},
  QQ:      {UTG: [87, 43, 24], HJ: [93, 61, 31], CO: [100, 77, 46], BTN: [100, 98, 86]},
  JJ:      {UTG: [76, 34, 15], HJ: [83, 43, 20], CO: [93, 65, 32], BTN: [100, 92, 66]},
  TT:      {UTG: [57, 33, 10], HJ: [71, 36, 17], CO: [84, 59, 27], BTN: [100, 83, 63]},
  '99-66': {UTG: [49, 14, 2], HJ: [57, 20, 3], CO: [68, 32, 6], BTN: [90, 58, 19]},
  '55-22': {UTG: [23, 6, 1], HJ: [32, 7, 1], CO: [45, 10, 1], BTN: [76, 28, 3]},
  '0g':    {UTG: [90, 71, 20], HJ: [90, 78, 30], CO: [90, 80, 30], BTN: [97, 80, 40]},
  '1g':    {UTG: [93, 49, 11], HJ: [93, 55, 15], CO: [93, 65, 22], BTN: [94, 81, 41]},
  '2g':    {UTG: [58, 16, 4], HJ: [61, 19, 8], CO: [67, 27, 13], BTN: [72, 48, 29]},
  'A[K-T][K-T]': {UTG: [100, 64, 0], HJ: [100, 77, 6], CO: [100, 99, 33], BTN: [100, 100, 100]},
  'A[9-6][9-6]': {UTG: [72, 25, 0], HJ: [76, 36, 0], CO: [90, 49, 2], BTN: [100, 73, 35]},
  'A[5-2][5-2]': {UTG: [49, 7, 0], HJ: [57, 10, 0], CO: [76, 20, 0], BTN: [93, 43, 2]},
  'Other A': {UTG: [69, 2, 0], HJ: [81, 10, 0], CO: [95, 30, 0], BTN: [100, 77, 6]},
  Other:   {UTG: [20, 1, 0], HJ: [25, 1, 0], CO: [36, 6, 0], BTN: [60, 20, 3]},
};

const RV = {'2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14};

/** 'ds' | 'ss' | 'r', or null for tri/quad-suited hands (not in the guide). */
export function suitedness(cards) {
  const n = {};
  for (const c of cards) n[c[1]] = (n[c[1]] || 0) + 1;
  const v = Object.values(n).sort((a, b) => b - a);
  if (v[0] >= 3) return null;
  return v[0] === 1 ? 'r' : v[1] === 2 ? 'ds' : 'ss';
}

// Rundown gap class of four distinct ranks: '0g' (no gaps), '1g' (one
// one-rank gap), '2g' (one two-rank gap), else null. Two single gaps
// (KJT8) count as neither: the guide puts KJT8 in "Other". Ace plays high
// or low.
function gapClass(ranks) {
  const tryRanks = rs => {
    const s = [...rs].sort((a, b) => a - b);
    const gaps = [s[1] - s[0] - 1, s[2] - s[1] - 1, s[3] - s[2] - 1];
    const nz = gaps.filter(g => g > 0);
    if (!nz.length) return '0g';
    if (nz.length === 1 && nz[0] === 1) return '1g';
    if (nz.length === 1 && nz[0] === 2) return '2g';
    return null;
  };
  const hi = tryRanks(ranks);
  const lo = ranks.includes(14) ? tryRanks(ranks.map(r => (r === 14 ? 1 : r))) : null;
  const order = ['0g', '1g', '2g'];
  const best = [hi, lo].filter(Boolean).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return best[0] || null;
}

/** Guide class of a PLO4 hand, or null (trips/quads). */
export function handClass(cards) {
  const ranks = cards.map(c => RV[c[0]]);
  const cnt = {};
  for (const r of ranks) cnt[r] = (cnt[r] || 0) + 1;
  if (Object.values(cnt).some(n => n >= 3)) return null;
  const pairs = Object.keys(cnt).map(Number).filter(r => cnt[r] === 2);
  if (pairs.length) {
    const p = Math.max(...pairs);
    return p === 14 ? 'AA' : p === 13 ? 'KK' : p === 12 ? 'QQ' : p === 11 ? 'JJ' : p === 10 ? 'TT' : p >= 6 ? '99-66' : '55-22';
  }
  const g = gapClass(ranks);
  if (g) return g;
  if (ranks.includes(14)) {
    const rest = ranks.filter(r => r !== 14);
    const inB = (lo, hi) => rest.filter(r => r >= lo && r <= hi).length;
    if (inB(10, 13) >= 2) return 'A[K-T][K-T]';
    if (inB(6, 9) >= 2) return 'A[9-6][9-6]';
    if (inB(2, 5) >= 2) return 'A[5-2][5-2]';
    return 'Other A';
  }
  return 'Other';
}

/**
 * Where the chart puts hands of a PLO4 hand's class and suitedness: the
 * percentile (0 = best) at quantile q (0 = the best hands of that kind) of
 * the class, read off the open frequencies: at a position opening P% of
 * hands, the chart opens a share f of the class, so a share f of the class
 * lies inside the top P%. Null for hands the guide doesn't cover (tri- and
 * quad-suited hands, trips).
 */
export function chartPercentile(cards, q) {
  const c = handClass(cards), su = suitedness(cards);
  if (!c || !su) return null;
  const i = {ds: 0, ss: 1, r: 2}[su];
  const pts = [[0, 0]];
  for (const [pos, P] of Object.entries(POSITIONS)) pts.push([P, Math.max(pts.at(-1)[1], CHART[c][pos][i] / 100)]);
  pts.push([100, 1]);
  for (let k = 1; k < pts.length; k++) {
    const [p0, f0] = pts[k - 1], [p1, f1] = pts[k];
    if (q <= f1 && f1 > f0) return p0 + (p1 - p0) * Math.max(0, q - f0) / (f1 - f0);
  }
  return 100;
}

/** Class and suitedness key of a PLO4 hand, or null when the guide doesn't cover it. */
export function chartCell(cards) {
  const c = handClass(cards), su = suitedness(cards);
  return c && su ? `${c} ${su}` : null;
}
