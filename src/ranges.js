// Hold'em starting-hand classes and range text, shared by the equity
// calculator and the trainer. A hand class is "AA", "AKs" or "AKo".
// ducy-training reads the range text, "top N%" included (#464).

import { training } from '../wasm/ducy_wasm.js';

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

/**
 * The top `pct`% of Hold'em hands by the trainer's ranking: every class whose
 * middle combo falls inside the cutoff, so the range covers about pct% of the
 * 1,326 combos.
 */
export function topRange(pct) {
  return new Set(training({op: 'topRange', pct: Number(pct) || 0}));
}

/**
 * Parses range text like "QQ+, AKs, A5s-A2s, KQ, top 20%" into a Set of hand
 * classes. Terms ducy can't read are skipped, so a range being typed keeps
 * showing what's readable so far.
 */
export function parseRange(text) {
  return new Set(training({op: 'readRange', text: String(text ?? '')}).classes);
}
