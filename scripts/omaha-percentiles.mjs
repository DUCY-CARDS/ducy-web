// Shared by fit-omaha-rank.mjs and omaha-blockers.mjs: the random hand sample
// and the step that turns fitted feature weights into a final model with the
// blocker term (src/omaha-blockers.js) and percentile cutoffs.

import { omahaFeatures } from '../src/omaha-features.js';
import { nutFlushBlock } from '../src/omaha-blockers.js';

export const PERCENTILE_SAMPLE = 400000;
export const CUTOFF_STEPS = 400;

export function* randomHands(n, count, seed) {
  let s = seed >>> 0;
  const rand = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const deck = [];
  for (const su of 'shdc') for (const r of '23456789TJQKA') deck.push(r + su);
  for (let h = 0; h < count; h++) {
    const d = deck.slice();
    for (let i = 0; i < n; i++) { const j = i + Math.floor(rand() * (52 - i)); [d[i], d[j]] = [d[j], d[i]]; }
    yield d.slice(0, n);
  }
}

const dot = (w, x) => w.reduce((a, wi, i) => a + wi * x[i], 0);

/**
 * Final model for one card count. The score is the fitted feature score plus
 * `blockerWeight` standard deviations of it per standard deviation of the
 * nut-flush blocker probability, so the weight reads as "how much a strong
 * blocker is worth next to the rest of the hand". Cutoffs come from a large
 * random sample of that combined score.
 */
export function finishModel(weights, cards, blockerWeight) {
  const base = [], blk = [];
  for (const h of randomHands(cards, PERCENTILE_SAMPLE, 17 + cards)) {
    base.push(dot(weights, omahaFeatures(h)));
    blk.push(nutFlushBlock(h));
  }
  const mean = xs => xs.reduce((a, x) => a + x, 0) / xs.length;
  const sd = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))) || 1; };
  const blocker = {weight: blockerWeight, mean: +mean(blk).toFixed(6), sd: +sd(blk).toFixed(6), scoreSd: +sd(base).toFixed(6)};
  const k = blocker.weight * blocker.scoreSd / blocker.sd;
  const sample = base.map((s, i) => s + k * (blk[i] - blocker.mean)).sort((a, b) => b - a);
  const cutoffs = [];
  for (let s = 0; s <= CUTOFF_STEPS; s++) cutoffs.push(+sample[Math.round(s / CUTOFF_STEPS * (sample.length - 1))].toFixed(5));
  return {weights: weights.map(x => +x.toFixed(6)), blocker, cutoffs};
}
