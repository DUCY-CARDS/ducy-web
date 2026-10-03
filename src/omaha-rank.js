// Ranks Omaha starting hands (4, 5 or 6 cards) by percentile: 0 is the best
// hand, 100 the worst, so a hand at 12.5 is in the top 12.5% of hands.
// The model and its cutoffs come from scripts/fit-omaha-rank.mjs.

import { omahaFeatures } from './omaha-features.js';
import { nutFlushBlock } from './omaha-blockers.js';
import { OMAHA_MODEL } from './omaha-rank-model.js';

export function omahaScore(cards) {
  const m = OMAHA_MODEL[cards.length];
  const w = m.weights;
  const x = omahaFeatures(cards);
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * x[i];
  // Holding the nut card of a suit that may flush (see omaha-blockers.js).
  const b = m.blocker;
  if (b && b.weight) s += b.weight * b.scoreSd / b.sd * (nutFlushBlock(cards) - b.mean);
  return s;
}

/** Percentile of a hand among all hands with the same card count (top X%). */
export function omahaPercentile(cards) {
  const cut = OMAHA_MODEL[cards.length].cutoffs; // descending scores
  const steps = cut.length - 1;
  const s = omahaScore(cards);
  if (s >= cut[0]) return 0;
  if (s <= cut[steps]) return 100;
  let lo = 0, hi = steps; // cut[lo] >= s > cut[hi]
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cut[mid] >= s) lo = mid; else hi = mid;
  }
  const span = cut[lo] - cut[hi];
  const frac = span > 0 ? (cut[lo] - s) / span : 0;
  return (lo + frac) / steps * 100;
}
