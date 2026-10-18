// "Leave before my big blind": play on until the big blind would come to
// you, then get up instead of posting it, the way players leave a live game
// after the button and blinds have gone round.
//
// nextBigBlind is the engine's rule (ducy-play Table::next_positions),
// worked out from the seats on screen: the button moves to the next seat
// that will be dealt in; heads-up the button posts the small blind and the
// other player the big blind, otherwise the two seats after the button do.

/**
 * The seat that posts the big blind in the next hand, or -1 if fewer than
 * two seats would be dealt in. `seats` are the table's seats ({empty,
 * sitting_out, stack}) and `button` the current button's seat. `refill`:
 * seats with no chips are dealt in anyway (a Regulars table tops its bots up
 * between hands); otherwise only seats with chips play.
 */
export function nextBigBlind(seats, button, refill = false) {
  const n = seats.length;
  const plays = s => !s.empty && !s.sitting_out && (refill || Number(s.stack) > 0);
  const dealt = seats.map((s, i) => (plays(s) ? i : -1)).filter(i => i >= 0);
  if (dealt.length < 2) return -1;
  const after = from => {
    for (let k = 1; k <= n; k++) if (dealt.includes((from + k) % n)) return (from + k) % n;
    return -1;
  };
  const btn = after(button);
  const sb = dealt.length === 2 ? btn : after(btn);
  return after(sb);
}
