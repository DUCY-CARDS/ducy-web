// Blocker value of an Omaha starting hand, used by the hand ranking.
//
// Holding the best card of a suit that isn't on the board (the A♠, or the K♠
// once the A♠ is out) means no opponent can have the nut flush. That's worth a
// lot on later streets, both for bluffing (they can't hold the nuts) and for
// calling (you know they don't), even with a single card of the suit. Equity
// numbers already account for card removal, but not for that.
//
// nutFlushBlock(cards) is the exact probability, over every five-card board
// from the cards you don't hold, that the board shows a possible flush (three
// or more of a suit) while you hold that suit's nut card.

const RANK_VALUE = {'2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14};

// Binomial coefficients up to C(52, 5).
const C = [];
for (let n = 0; n <= 52; n++) {
  C[n] = [];
  for (let k = 0; k <= 5; k++) C[n][k] = k === 0 ? 1 : n === 0 ? 0 : C[n - 1][k - 1] + (k <= n - 1 ? C[n - 1][k] : 0);
}
const choose = (n, k) => (k < 0 || k > 5 || n < k ? 0 : C[n][k]);

export function nutFlushBlock(cards) {
  const deck = 52 - cards.length;
  const boards = choose(deck, 5);
  let p = 0;
  // Three suited cards on a five-card board can only happen in one suit, so
  // the per-suit probabilities add up.
  for (const suit of 'shdc') {
    const mine = cards.filter(c => c[1] === suit);
    if (!mine.length) continue;
    const top = Math.max(...mine.map(c => RANK_VALUE[c[0]]));
    const above = 14 - top; // ranks above your best card of the suit: all must be on the board
    const left = 13 - mine.length; // cards of the suit you don't hold
    let ways = 0;
    for (let j = Math.max(3, above); j <= 5; j++) ways += choose(left - above, j - above) * choose(deck - left, 5 - j);
    p += ways / boards;
  }
  return p;
}
