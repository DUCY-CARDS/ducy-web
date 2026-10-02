// Features of an Omaha starting hand (4, 5 or 6 cards like ["As","Kd",...]),
// used by the Omaha hand ranking. The ranking's weights are fitted to engine
// measurements (see scripts/fit-omaha-rank.mjs), so these should describe
// what makes a hand play well, not judge it themselves.

const RANK_VALUE = {'2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14};

// Straights by their low card (ace low through ten high), as rank bitmasks
// where bit r is rank r (ace is bit 14 and also bit 1).
const STRAIGHTS = [];
for (let low = 1; low <= 10; low++) {
  let m = 0;
  for (let r = low; r < low + 5; r++) m |= 1 << r;
  STRAIGHTS.push(m);
}

const popcount = m => { let n = 0; while (m) { m &= m - 1; n++; } return n; };

export const FEATURE_NAMES = [
  'bias',
  'high_card_sum', 'aces', 'kings', 'queens', 'broadways', 'low_cards',
  'pairs', 'top_pair_rank', 'second_pair_rank', 'pair_aa', 'pair_kk', 'pair_qq', 'pair_jj_tt', 'trips_or_more',
  'suits_with_2', 'suits_with_3plus', 'rainbow', 'suited_ace', 'suited_king', 'suited_low_only',
  'straights_2', 'straights_3', 'straights_4', 'max_in_straight', 'connectors', 'one_gaps', 'two_gaps', 'rundown_4',
  'danglers', 'aa_suited', 'pair_suited_with_side',
  'double_suited_connected', 'broadway_rundown',
  // Interactions: a big pair is only as good as what comes with it.
  'aa_danglers', 'aa_rainbow', 'aa_double_suited', 'aa_side_connected', 'kk_qq_double_suited', 'kk_qq_danglers',
  'pair_side_connected', 'two_danglers_plus', 'no_pair_no_suit',
];

/** Feature vector for a hand; same order as FEATURE_NAMES. */
export function omahaFeatures(cards) {
  const n = cards.length;
  const ranks = cards.map(c => RANK_VALUE[c[0]]);
  const suits = cards.map(c => c[1]);

  const rankCount = {};
  for (const r of ranks) rankCount[r] = (rankCount[r] || 0) + 1;
  const suitCount = {};
  for (const s of suits) suitCount[s] = (suitCount[s] || 0) + 1;

  const pairRanks = Object.keys(rankCount).map(Number).filter(r => rankCount[r] === 2).sort((a, b) => b - a);
  const tripsOrMore = Object.values(rankCount).filter(c => c >= 3).reduce((a, c) => a + (c - 2), 0);

  // Suit structure: suits with exactly two cards are the strongest flush draws;
  // three or more of a suit cost outs.
  const suitCounts = Object.values(suitCount);
  const suitsWith2 = suitCounts.filter(c => c === 2).length;
  const suitsWith3 = suitCounts.filter(c => c >= 3).length;
  let suitedAce = 0, suitedKing = 0, suitedLowOnly = 0;
  for (const s of Object.keys(suitCount)) {
    if (suitCount[s] < 2) continue;
    const rs = cards.filter(c => c[1] === s).map(c => RANK_VALUE[c[0]]);
    if (rs.includes(14)) suitedAce++;
    else if (rs.includes(13)) suitedKing++;
    else if (Math.max(...rs) <= 9) suitedLowOnly++;
  }

  // Straight potential from distinct ranks (ace counts high and low).
  let mask = 0;
  for (const r of ranks) { mask |= 1 << r; if (r === 14) mask |= 1 << 1; }
  let s2 = 0, s3 = 0, s4 = 0, maxIn = 0;
  for (const st of STRAIGHTS) {
    const k = popcount(mask & st);
    if (k >= 2) s2++;
    if (k >= 3) s3++;
    if (k >= 4) s4++;
    maxIn = Math.max(maxIn, k);
  }
  const distinct = [...new Set(ranks)].sort((a, b) => b - a);
  let connectors = 0, oneGaps = 0, twoGaps = 0;
  for (let i = 0; i < distinct.length; i++) for (let j = i + 1; j < distinct.length; j++) {
    const d = distinct[i] - distinct[j];
    if (d === 1) connectors++; else if (d === 2) oneGaps++; else if (d === 3) twoGaps++;
  }
  // Ace-low connections (A with 2-4).
  if (distinct.includes(14)) for (const r of distinct) { if (r === 2) connectors++; else if (r === 3) oneGaps++; else if (r === 4) twoGaps++; }
  let run = 1, bestRun = 1;
  for (let i = 1; i < distinct.length; i++) { run = distinct[i - 1] - distinct[i] === 1 ? run + 1 : 1; bestRun = Math.max(bestRun, run); }

  // Danglers: cards that aren't paired, suited with another card, or within
  // three ranks of another card.
  let danglers = 0;
  cards.forEach((c, i) => {
    const r = ranks[i];
    const paired = rankCount[r] > 1;
    const suited = suitCount[suits[i]] > 1;
    const near = ranks.some((r2, j) => j !== i && r2 !== r && (Math.abs(r2 - r) <= 3 || (r === 14 && r2 <= 4) || (r2 === 14 && r <= 4)));
    if (!paired && !suited && !near) danglers++;
  });

  const aaSuited = rankCount[14] === 2 && cards.some(c => c[0] === 'A' && suitCount[c[1]] >= 2) ? 1 : 0;
  const pairSuitedWithSide = pairRanks.some(pr => cards.some((c, i) => ranks[i] === pr && suitCount[c[1]] >= 2)) ? 1 : 0;
  const broadways = ranks.filter(r => r >= 10).length;

  // Side cards of the top pair: how many of them sit within three ranks of
  // each other (they make straights together instead of dangling).
  const aa = rankCount[14] === 2 ? 1 : 0;
  const kkqq = rankCount[13] === 2 || rankCount[12] === 2 ? 1 : 0;
  const sideRanks = pairRanks.length ? distinct.filter(r => r !== pairRanks[0]) : [];
  let sideConnected = 0;
  for (let i = 0; i < sideRanks.length; i++) for (let j = i + 1; j < sideRanks.length; j++) {
    if (Math.abs(sideRanks[i] - sideRanks[j]) <= 3) sideConnected++;
  }
  const doubleSuited = suitsWith2 >= 2 ? 1 : 0;

  return [
    1,
    ranks.reduce((a, r) => a + (r - 2) / 12, 0) / n,
    rankCount[14] || 0, rankCount[13] || 0, rankCount[12] || 0, broadways, ranks.filter(r => r <= 5).length,
    pairRanks.length, pairRanks[0] ? (pairRanks[0] - 2) / 12 : 0, pairRanks[1] ? (pairRanks[1] - 2) / 12 : 0,
    rankCount[14] === 2 ? 1 : 0, rankCount[13] === 2 ? 1 : 0, rankCount[12] === 2 ? 1 : 0,
    rankCount[11] === 2 || rankCount[10] === 2 ? 1 : 0, tripsOrMore,
    suitsWith2, suitsWith3, suitCounts.length === n ? 1 : 0, suitedAce, suitedKing, suitedLowOnly,
    s2, s3, s4, maxIn, connectors, oneGaps, twoGaps, bestRun >= 4 ? 1 : 0,
    danglers, aaSuited, pairSuitedWithSide,
    suitsWith2 >= 2 && maxIn >= 3 ? 1 : 0, distinct.filter(r => r >= 10).length >= 4 ? 1 : 0,
    aa * danglers, aa * (suitCounts.length === n ? 1 : 0), aa * doubleSuited, aa * Math.min(sideConnected, 2),
    kkqq * doubleSuited, kkqq * danglers,
    pairRanks.length ? Math.min(sideConnected, 3) : 0, danglers >= 2 ? 1 : 0,
    !pairRanks.length && !suitsWith2 && !suitsWith3 ? 1 : 0,
  ];
}
