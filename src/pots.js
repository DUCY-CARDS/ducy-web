// The pots as they stand during a hand: the main pot, any side pots, and
// a bet nobody can call (an all-in bigger than every stack that called it),
// which isn't in any pot: it goes back to whoever bet it. ducy works them
// out (ducy_play::hands, #461) from the table's seats and the hand's events.

import { shownPots as ducyPots } from '../wasm/ducy_wasm.js';

const amt = x => Math.max(0, Number(x) || 0);

/**
 * The pots to show at the table now, from its state's seats ({stack,
 * street_bet, folded, all_in}) and events: {pots: [{amount, eligible}],
 * uncalled: {seat, amount} | null}, or null when there's just the one pot
 * and nothing uncalled (show it as usual). While betting goes on, bets
 * still out this street stay in front of the players: only chips already
 * gathered are split. Once nobody can bet any more (all-in), every chip is.
 */
export function shownPots(seats, events) {
  return ducyPots(seats, events || []) ?? null;
}

/**
 * The table as it should look with an uncalled all-in already handed back
 * (as a dealer would at once): the bettor's stack has it again, and their
 * bet out and the pot are only what was matched. The same `state` when
 * there's nothing uncalled, or the hand is over (the engine has paid it).
 */
export function returnUncalled(state) {
  if (!state || state.complete) return state;
  const u = shownPots(state.seats, state.events)?.uncalled;
  if (!u) return state;
  const seats = state.seats.map((x, i) => {
    if (i !== u.seat) return x;
    const back = Math.min(amt(x.street_bet), u.amount);
    // With chips behind again, they're not all-in any more.
    return {...x, stack: amt(x.stack) + u.amount, street_bet: amt(x.street_bet) - back, all_in: false};
  });
  return {...state, seats, pot: Math.max(0, amt(state.pot) - u.amount)};
}
