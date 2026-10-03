// Hold'em starting-hand classes and range-text parsing, shared by the equity
// calculator and the trainer. A hand class is "AA", "AKs" or "AKo".

import { HOLDEM_PERCENTILE } from './holdem-rank.js';

export const RK = ['A','K','Q','J','T','9','8','7','6','5','4','3','2'];

/** Number of card combinations in each hand class (pair 6, suited 4, offsuit 12). */
export const COMBOS = {};
for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
  const l = r === c ? RK[r] + RK[c] : r < c ? RK[r] + RK[c] + 's' : RK[c] + RK[r] + 'o';
  COMBOS[l] = r === c ? 6 : r < c ? 4 : 12;
}

const ri = r => RK.indexOf(r);

/** Hand class at row r, column c of the 13x13 grid (suited above the diagonal). */
export function gridLabel(r, c) {
  return r === c ? RK[r] + RK[c] : r < c ? RK[r] + RK[c] + 's' : RK[c] + RK[r] + 'o';
}

/** Hand class for two cards like "Ah", "Kh" -> "AKs". */
export function handClass(c1, c2) {
  const [a, b] = ri(c1[0]) <= ri(c2[0]) ? [c1, c2] : [c2, c1];
  if (a[0] === b[0]) return a[0] + b[0];
  return a[0] + b[0] + (a[1] === b[1] ? 's' : 'o');
}

export function comboCount(sel) {
  return [...sel].reduce((a, k) => a + (COMBOS[k] || 0), 0);
}

/** Parses range text like "QQ+, AKs, A5s-A2s, KQ" into a Set of hand classes. */
/**
 * The top `pct`% of Hold'em hands by the trainer's ranking (holdem-rank.js):
 * every class whose middle combo falls inside the cutoff, so the range covers
 * about pct% of the 1,326 combos.
 */
export function topRange(pct) {
  return new Set(Object.keys(HOLDEM_PERCENTILE).filter(c => HOLDEM_PERCENTILE[c] < pct));
}

export function parseRange(text) {
  const sel = new Set();
  // "top 20%" (or "top20%") adds the top 20% of hands.
  text = text.replace(/\btop\s*(\d+(?:\.\d+)?)\s*%?/gi, (_, n) => {
    for (const c of topRange(+n)) sel.add(c);
    return ' ';
  });
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  for (const tok of tokens) {
    const t = tok.trim();
    if (!t) continue;
    const dashMatch = t.match(/^([AKQJT2-9]{2}[so]?)-([AKQJT2-9]{2}[so]?)$/);
    if (dashMatch) {
      expandDash(dashMatch[1], dashMatch[2], sel);
      continue;
    }
    const plusMatch = t.match(/^([AKQJT2-9]{2}[so]?)\+$/);
    if (plusMatch) {
      expandPlus(plusMatch[1], sel);
      continue;
    }
    if (COMBOS[t]) { sel.add(t); continue; }
    if (t.length === 2 && t[0] !== t[1] && ri(t[0]) >= 0 && ri(t[1]) >= 0) {
      const hi = Math.min(ri(t[0]), ri(t[1]));
      const lo = Math.max(ri(t[0]), ri(t[1]));
      const ks = RK[hi]+RK[lo]+'s';
      const ko = RK[hi]+RK[lo]+'o';
      if (COMBOS[ks]) sel.add(ks);
      if (COMBOS[ko]) sel.add(ko);
    }
  }
  return sel;
}

function expandPlus(hand, sel) {
  if (hand.length === 2 && hand[0] === hand[1]) {
    const start = ri(hand[0]);
    for (let i = start; i >= 0; i--) sel.add(RK[i]+RK[i]);
  } else if (hand.length === 2) {
    const hi = ri(hand[0]), lo = ri(hand[1]);
    for (let i = lo; i > hi; i--) {
      const ks = RK[hi]+RK[i]+'s';
      const ko = RK[hi]+RK[i]+'o';
      if (COMBOS[ks]) sel.add(ks);
      if (COMBOS[ko]) sel.add(ko);
    }
  } else if (hand.length === 3) {
    const suit = hand[2];
    const hi = ri(hand[0]), lo = ri(hand[1]);
    for (let i = lo; i > hi; i--) {
      const k = RK[hi]+RK[i]+suit;
      if (COMBOS[k]) sel.add(k);
    }
  }
}

function expandDash(lo, hi, sel) {
  if (lo.length === 2 && hi.length === 2 && lo[0] === lo[1] && hi[0] === hi[1]) {
    let a = ri(lo[0]), b = ri(hi[0]);
    if (a < b) [a, b] = [b, a];
    for (let i = b; i <= a; i++) sel.add(RK[i]+RK[i]);
  } else if (lo.length >= 2 && hi.length >= 2 && lo[0] === hi[0] && lo[0] !== lo[1]) {
    const hiCard = ri(lo[0]);
    let a = ri(lo[1]), b = ri(hi[1]);
    if (a < b) [a, b] = [b, a];
    const loSuffix = lo.length === 3 ? lo[2] : null;
    const hiSuffix = hi.length === 3 ? hi[2] : null;
    const suffix = loSuffix || hiSuffix;
    for (let i = b; i <= a; i++) {
      if (suffix) {
        const k = RK[hiCard]+RK[i]+suffix;
        if (COMBOS[k]) sel.add(k);
      } else {
        const ks = RK[hiCard]+RK[i]+'s';
        const ko = RK[hiCard]+RK[i]+'o';
        if (COMBOS[ks]) sel.add(ks);
        if (COMBOS[ko]) sel.add(ko);
      }
    }
  }
}
