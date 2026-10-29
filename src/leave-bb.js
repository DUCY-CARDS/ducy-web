// "Leave before my big blind": play on until the big blind would come to
// you, then get up instead of posting it, the way players leave a live game
// after the button and blinds have gone round.
//
// nextBigBlind is the engine's rule (ducy_play::hands::next_big_blind, as
// Table::next_positions deals), from the seats on screen.

import { nextBigBlind as ducyNextBigBlind } from '../wasm/ducy_wasm.js';

/**
 * The seat that posts the big blind in the next hand, or -1 if fewer than
 * two seats would be dealt in. `seats` are the table's seats ({empty,
 * sitting_out, stack}) and `button` the current button's seat. `refill`:
 * seats with no chips are dealt in anyway (a Regulars table tops its bots up
 * between hands); otherwise only seats with chips play.
 */
export function nextBigBlind(seats, button, refill = false) {
  return ducyNextBigBlind(seats, button, refill);
}
