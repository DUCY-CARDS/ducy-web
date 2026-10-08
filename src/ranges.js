// Hold'em starting-hand classes and range text, shared by the equity
// calculator and the trainer. A hand class is "AA", "AKs" or "AKo". ducy reads
// the range text (holdemRangeReport); the page adds "top N%".

import { HOLDEM_PERCENTILE } from './holdem-rank.js';
import { holdemRangeReport } from '../wasm/ducy_wasm.js';

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
 * The top `pct`% of Hold'em hands by the trainer's ranking (holdem-rank.js):
 * every class whose middle combo falls inside the cutoff, so the range covers
 * about pct% of the 1,326 combos.
 */
export function topRange(pct) {
  return new Set(Object.keys(HOLDEM_PERCENTILE).filter(c => HOLDEM_PERCENTILE[c] < pct));
}

/**
 * Parses range text like "QQ+, AKs, A5s-A2s, KQ, top 20%" into a Set of hand
 * classes. Terms ducy can't read are skipped, so a range being typed keeps
 * showing what's readable so far; `rangeErrors` lists them.
 */
export function parseRange(text) {
  return readRange(text).sel;
}

/** The terms of range text that aren't hands or ranges, as ducy's messages. */
export function rangeErrors(text) {
  return readRange(text).errors;
}

function readRange(text) {
  const sel = new Set();
  const errors = [];
  // "top 20%" (or "top20%") adds the top 20% of hands.
  text = text.replace(/\btop\s*(\d+(?:\.\d+)?)\s*%?/gi, (_, n) => {
    for (const c of topRange(+n)) sel.add(c);
    return ' ';
  });
  // Each bad term ducy names is blanked out and the rest read again.
  for (let tries = 0; tries < 100; tries++) {
    const r = holdemRangeReport(text, undefined);
    if (r.ok) {
      for (const c of r.classes) sel.add(c);
      break;
    }
    const {term, start: byte, message} = r.error;
    errors.push(message);
    // ducy gives a byte offset into the UTF-8 text.
    const start = new TextDecoder().decode(new TextEncoder().encode(text).slice(0, byte)).length;
    text = text.slice(0, start) + ' '.repeat(term.length) + text.slice(start + term.length);
  }
  return {sel, errors};
}
