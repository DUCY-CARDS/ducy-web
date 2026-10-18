// Study while you travel or wait for a seat (Bankroll Challenge): quick
// questions on the numbers players use at the table, pot odds, outs and
// combinations. Question `n` of a world (its seed) is always the same, so a
// redrawn page shows the question you were on. Pure.

import { roll } from './quest-rooms.js';

const pct = x => `${Math.round(100 * x)}%`;
const dollars = n => `$${n.toLocaleString('en-US')}`;

// The chance of hitting one of `outs` cards by the river: from the flop (two
// cards to come) or the turn (one).
const hitChance = (outs, cards) => (cards === 2 ? 1 - ((47 - outs) * (46 - outs)) / (47 * 46) : outs / 46);

// Four choices around `right` (a share, 0 to 1), all different when rounded.
function choicesAround(right, wrong) {
  const seen = new Set([pct(right)]);
  const out = [right];
  for (const w of wrong) {
    if (out.length === 4) break;
    if (w > 0 && w < 1 && !seen.has(pct(w))) {
      seen.add(pct(w));
      out.push(w);
    }
  }
  return out;
}

const DRAWS = [
  {name: 'a flush draw', outs: 9},
  {name: 'an open-ended straight draw', outs: 8},
  {name: 'a gutshot straight draw', outs: 4},
  {name: 'a flush draw and a gutshot', outs: 12},
  {name: 'two overcards', outs: 6},
  {name: 'an open-ended straight and flush draw', outs: 15},
];
const BETS = [[1, 3, 'a third of the pot'], [1, 2, 'half the pot'], [2, 3, 'two thirds of the pot'], [3, 4, 'three quarters of the pot'], [1, 1, 'the pot']];
const HANDS = [
  {text: 'a pocket pair, like 8♠8♥', combos: 6},
  {text: 'a suited hand, like A♠K♠', combos: 4},
  {text: 'an offsuit hand, like A♠K♥', combos: 12},
  {text: 'a hand like AK, suited or not', combos: 16},
];

/**
 * Question `n` for world `seed`: {kind, text, choices: [text], answer (its
 * index), why}.
 */
export function question(seed, n) {
  const r = key => roll(seed, 'study', n, key);
  const kind = ['odds', 'outs', 'turn', 'combos'][Math.floor(r('kind') * 4)];
  let text, values, why, labels;
  if (kind === 'odds') {
    const pot = 20 * (2 + Math.floor(r('pot') * 14));
    const [num, den, size] = BETS[Math.floor(r('bet') * BETS.length)];
    const bet = Math.round((pot * num) / den);
    const right = bet / (pot + 2 * bet);
    values = choicesAround(right, [bet / (pot + bet), bet / pot, right * 1.5, right / 1.5, right + 0.1]);
    text = `The pot is ${dollars(pot)} and your opponent bets ${dollars(bet)} (${size}). How often do you need to win to call?`;
    why = `You call ${dollars(bet)} to win a pot of ${dollars(pot + 2 * bet)} with your call in it: ${dollars(bet)} ÷ ${dollars(pot + 2 * bet)} is ${pct(right)}.`;
  } else if (kind === 'outs' || kind === 'turn') {
    const d = DRAWS[Math.floor(r('draw') * DRAWS.length)];
    const cards = kind === 'outs' ? 2 : 1;
    const right = hitChance(d.outs, cards);
    values = choicesAround(right, [hitChance(d.outs, 3 - cards), d.outs / 52, right * 1.6, right / 1.6, right + 0.12]);
    text = cards === 2
      ? `On the flop you have ${d.name} (${d.outs} outs). How often do you make your hand by the river, if you see both cards?`
      : `On the turn you have ${d.name} (${d.outs} outs). How often do you make your hand on the river?`;
    why = cards === 2
      ? `With ${d.outs} outs and two cards to come it's ${pct(right)}. A quick rule: outs × 4, about ${Math.min(100, d.outs * 4)}%.`
      : `With ${d.outs} outs among 46 unseen cards it's ${pct(right)}. A quick rule: outs × 2, about ${d.outs * 2}%.`;
  } else {
    const h = HANDS[Math.floor(r('hand') * HANDS.length)];
    const options = [...new Set([h.combos, 4, 6, 12, 16, 8, 24])].slice(0, 4);
    labels = options.map(String);
    values = options;
    text = `How many ways can you be dealt ${h.text}?`;
    why = 'A pocket pair has 6 combinations, a suited hand 4 and an offsuit hand 12, so a hand like AK has 16 in all.';
  }
  labels ||= values.map(pct);
  // Shuffle the choices, the right one first before.
  const order = labels.map((_, i) => i).sort((a, b) => roll(seed, 'study', n, 'order', a) - roll(seed, 'study', n, 'order', b));
  return {kind, text, choices: order.map(i => labels[i]), answer: order.indexOf(0), why};
}
