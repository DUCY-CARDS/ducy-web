// Play the Regulars (V3, #225): a 6-handed table of random Regulars (the
// personality bots), run like a card room. Each Regular brings a bankroll of
// BANKROLL_BUY_INS buy-ins. Between hands, one below half a buy-in tops back
// up to a full buy-in from what's left of it; one with no chips and nothing
// left leaves, and a new random Regular takes the seat with a full bankroll.
// The person rebuys or tops up when they choose (play.js). Pure: play.js
// applies what `betweenHands` returns.

export const BANKROLL_BUY_INS = 3;
export const REGULARS_SEATS = 5; // and you: 6-handed

/** What each bot seat has left after its first buy-in (seat 0 is you). */
export function startBank(bots, buyIn) {
  return [0, ...bots.map(() => (BANKROLL_BUY_INS - 1) * buyIn)];
}

/** `n` Regulars picked at random from `ids`, all different when there are enough. */
export function pickRegulars(ids, n, rng = Math.random) {
  const pool = [...ids];
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  while (out.length < n && ids.length) out.push(ids[Math.floor(rng() * ids.length)]);
  return out;
}

/**
 * What changes before the next hand. `stacks` are every seat's chips (seat 0
 * yours), `bank` what each bot seat has left (from startBank), `bots` the id
 * in each bot seat (seat i + 1), `all` every Regular's id. Returns
 * {sets: [{seat, chips}], swaps: [{seat, from, id, chips}], bank, bots}: the
 * stacks to set, the Regulars leaving and who replaces them, and the new
 * bank and seating.
 */
export function betweenHands({stacks, bank, bots, buyIn, all, rng = Math.random}) {
  const nextBank = [...bank];
  const seated = [...bots];
  const sets = [], swaps = [];
  for (let seat = 1; seat < stacks.length; seat++) {
    const stack = stacks[seat];
    if (stack >= buyIn / 2) continue;
    const left = nextBank[seat] || 0;
    if (left > 0) {
      const add = Math.min(buyIn - stack, left);
      nextBank[seat] = left - add;
      sets.push({seat, chips: stack + add});
      continue;
    }
    if (stack > 0) continue; // playing out the last of the bankroll
    const free = all.filter(id => !seated.includes(id));
    const id = pickRegulars(free.length ? free : all, 1, rng)[0];
    swaps.push({seat, from: seated[seat - 1], id, chips: buyIn});
    seated[seat - 1] = id;
    nextBank[seat] = (BANKROLL_BUY_INS - 1) * buyIn;
  }
  return {sets, swaps, bank: nextBank, bots: seated};
}
