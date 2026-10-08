// Omaha starting hands (4, 5 or 6 cards) as ducy analyses them
// (ducy::games::omaha_analysis, via omahaHand): the percentile, 0 the best
// hand and 100 the worst, so a hand at 12.5 is in the top 12.5%; and the
// trainer's tags ("you play too many ___").

import { omahaHand, omahaTagLabels } from '../wasm/ducy_wasm.js';

// The trainer asks about the same hand more than once (tags, then
// percentile), so recent answers are kept.
const cache = new Map();
function info(cards) {
  const key = cards.join(' ');
  let r = cache.get(key);
  if (!r) {
    if (cache.size > 5000) cache.clear();
    r = omahaHand(key);
    cache.set(key, r);
  }
  return r;
}

/** Percentile of a hand among all hands with the same card count (top X%). */
export const omahaPercentile = cards => info(cards).percentile;

/** The tags that describe a hand, e.g. "double-suited". */
export const omahaTags = cards => info(cards).tags;

/** Each tag and its description. */
let labels;
export function omahaLabels() {
  return (labels ||= omahaTagLabels());
}

// The ranking model's version for `cards`-card hands, so saved trainer
// scores start over when the model changes: a fingerprint of a few fixed
// hands' scores. While those match the model the page used to ship
// (src/omaha-rank-model.js), the version is that model's, so scores saved
// before ducy took over are kept.
const PROBES = {
  4: ['As Ad Kh Qh', 'Js Ts 9d 8d', '7c 6c 5h 4h', 'Kd Kc 2s 7h', 'Ah 2h 3c 3d', '9s 9h 6c 2d'],
  5: ['As Ad Kh Qh Jc', 'Js Ts 9d 8d 7c', '7c 6c 5h 4h 2s', 'Kd Kc 2s 7h 8h', 'Ah 2h 3c 3d Qs', '9s 9h 6c 2d Td'],
  6: ['As Ad Kh Qh Jc Tc', 'Js Ts 9d 8d 7c 6c', '7c 6c 5h 4h 2s 3s', 'Kd Kc 2s 7h 8h 4d', 'Ah 2h 3c 3d Qs Jd', '9s 9h 6c 2d Td 5c'],
};
const SHIPPED = {4: ['vkpzh8', '4qcpi0'], 5: ['1n9cs1b', 'wbxw05'], 6: ['66xp0e', '1cktmih']};

export function omahaModelVersion(cards, fingerprint) {
  if (!PROBES[cards]) return fingerprint('null');
  const v = fingerprint(JSON.stringify(PROBES[cards].map(h => omahaHand(h).score)));
  return SHIPPED[cards][0] === v ? SHIPPED[cards][1] : v;
}
