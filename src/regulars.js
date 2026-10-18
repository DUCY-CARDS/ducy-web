// Play the Regulars (V3, #225): a 6-handed table of random Regulars (the
// personality bots), run like a card room. Each Regular brings a bankroll of
// BANKROLL_BUY_INS buy-ins. Between hands, one below half a buy-in tops back
// up to a full buy-in from what's left of it; one with no chips and nothing
// left leaves, and a new random Regular takes the seat with a full bankroll.
// And after any hand, whatever their stack, a Regular may just get up and go
// (LEAVE_CHANCE), as people do, so the table keeps changing. The person
// rebuys or tops up when they choose (play.js). Pure: play.js applies what
// `betweenHands` returns.

export const BANKROLL_BUY_INS = 3;
/** The chance each Regular leaves after a hand, whatever their stack. */
export const LEAVE_CHANCE = 0.015;
export const REGULARS_SEATS = 5; // and you: 6-handed

/**
 * What each bot seat has left after its first buy-in (seat 0 is you).
 * `buyIns`, when given, is each seat's own buy-in (seat 0 unused).
 */
export function startBank(bots, buyIn, buyIns = null) {
  return [0, ...bots.map((_, i) => (BANKROLL_BUY_INS - 1) * (buyIns?.[i + 1] ?? buyIn))];
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
 * bank and seating. `leaveChance` is each Regular's chance of leaving anyway
 * (LEAVE_CHANCE by default).
 *
 * Players who buy in for different amounts (a Bankroll challenge table):
 * `buyIns` is each seat's own buy-in (seat 0 unused) and `buyInOf(id)` what a
 * newcomer buys in for; the result then has the new `buyIns` too.
 */
export function betweenHands({stacks, bank, bots, buyIn, all, rng = Math.random, leaveChance = LEAVE_CHANCE, buyIns = null, buyInOf = null}) {
  const nextBank = [...bank];
  const seated = [...bots];
  const nextBuyIns = buyIns ? [...buyIns] : null;
  const sets = [], swaps = [];
  const replace = seat => {
    const free = all.filter(id => !seated.includes(id));
    const id = pickRegulars(free.length ? free : all, 1, rng)[0];
    const chips = buyInOf ? buyInOf(id) : buyIn;
    swaps.push({seat, from: seated[seat - 1], id, chips});
    seated[seat - 1] = id;
    if (nextBuyIns) nextBuyIns[seat] = chips;
    nextBank[seat] = (BANKROLL_BUY_INS - 1) * chips;
  };
  for (let seat = 1; seat < stacks.length; seat++) {
    const stack = stacks[seat];
    const target = nextBuyIns?.[seat] ?? buyIn;
    // Done for the day, whatever's in front of them.
    if (stack > 0 && leaveChance > 0 && rng() < leaveChance) { replace(seat); continue; }
    if (stack >= target / 2) continue;
    const left = nextBank[seat] || 0;
    if (left > 0) {
      const add = Math.min(target - stack, left);
      nextBank[seat] = left - add;
      sets.push({seat, chips: stack + add});
      continue;
    }
    if (stack > 0) continue; // playing out the last of the bankroll
    replace(seat);
  }
  return {sets, swaps, bank: nextBank, bots: seated, ...(nextBuyIns ? {buyIns: nextBuyIns} : {})};
}
