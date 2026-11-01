// Play the Regulars (V3, #225): a 6-handed table of random Regulars (the
// personality bots), run like a card room. Each Regular brings a bankroll of
// BANKROLL_BUY_INS buy-ins. Between hands, one below half a buy-in tops back
// up to a full buy-in from what's left of it; one with no chips and nothing
// left leaves, and a new random Regular takes the seat with a full bankroll.
// And after any hand, whatever their stack, a Regular may just get up and go
// (LEAVE_CHANCE), as people do, so the table keeps changing. The person
// rebuys or tops up when they choose (play.js). The rules are
// ducy-bot-games' regulars (#465); play.js applies what `betweenHands`
// returns.

import { botGames } from '../wasm/ducy_wasm.js';

// As ducy-bot-games has them (a test checks they agree).
export const BANKROLL_BUY_INS = 3;
/** The chance each Regular leaves after a hand, whatever their stack. */
export const LEAVE_CHANCE = 0.015;
export const REGULARS_SEATS = 5; // and you: 6-handed

/**
 * What each bot seat has left after its first buy-in (seat 0 is you).
 * `buyIns`, when given, is each seat's own buy-in (seat 0 unused).
 */
export const startBank = (bots, buyIn, buyIns = null) => botGames({op: 'startBank', bots: bots.length, buyIn, buyIns});

const drawn = (n, rng) => Array.from({length: n}, () => rng());

/** `n` Regulars picked at random from `ids`, all different when there are enough. */
export const pickRegulars = (ids, n, rng = Math.random) => botGames({op: 'pickRegulars', ids: [...ids], n, draws: drawn(n, rng)});

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
 * newcomer buys in for; the result then has the new `buyIns` too. With
 * `nameOf`, never two of the same name at the table.
 */
export function betweenHands({stacks, bank, bots, buyIn, all, rng = Math.random, leaveChance = LEAVE_CHANCE, buyIns = null, buyInOf = null, nameOf = null}) {
  const ids = [...new Set([...all, ...bots])];
  return botGames({
    op: 'betweenHands', stacks, bank, bots, buyIn, all, leaveChance, buyIns,
    buyInOf: buyInOf ? Object.fromEntries(all.map(id => [id, buyInOf(id)])) : null,
    names: nameOf ? Object.fromEntries(ids.map(id => [id, nameOf(id)])) : null,
    // A Regular draws at most twice: whether they go, and who sits down.
    draws: drawn(2 * stacks.length, rng),
  });
}
