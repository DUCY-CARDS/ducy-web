// The pots as they stand during a hand: the main pot, any side pots, and
// a bet nobody can call (an all-in bigger than every stack that called it),
// which isn't in any pot: it goes back to whoever bet it. The engine only
// splits the pots at the end of the hand (its awards); the table shows them
// as they form, from the hand's events. Pure.

const amt = x => Math.max(0, Number(x) || 0);

/**
 * What each seat has put in this hand, from the hand's events (blinds,
 * antes, missed blinds, calls, bets and raises): [chips], by seat.
 */
export function contributions(events, n) {
  const put = new Array(n).fill(0);
  const street = new Array(n).fill(0);
  for (const e of events || []) {
    if (e.type === 'board') { street.fill(0); continue; }
    const s = e.seat;
    if (s == null || s < 0 || s >= n) continue;
    let toPot = 0, toBet = 0;
    if (e.type === 'ante') toPot = amt(e.amount);
    else if (e.type === 'post') { toPot = amt(e.dead); toBet = amt(e.live); }
    else if (e.type === 'small_blind' || e.type === 'big_blind' || e.type === 'call') toBet = amt(e.amount);
    else if (e.type === 'bet' || e.type === 'raise') toBet = Math.max(0, amt(e.to) - street[s]);
    else continue;
    street[s] += toBet;
    put[s] += toPot + toBet;
  }
  return put;
}

/**
 * The pots from what each seat has put in (`put`) and who has folded
 * (`folded`), the way the engine splits them: a pot for each all-in level
 * of the players still in, the folded players' chips in the pots they
 * reached. Returns {pots: [{amount, eligible: [seat]}], uncalled: {seat,
 * amount} | null}: `pots` main pot first, then the side pots; `uncalled`
 * the top of a bet only its bettor can win, back to them.
 */
export function splitPots(put, folded) {
  const n = put.length;
  const live = [...new Set(put.filter((p, i) => !folded[i] && p > 0))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of live) {
    let amount = 0;
    for (let i = 0; i < n; i++) amount += Math.max(0, Math.min(put[i], level) - Math.min(put[i], prev));
    const eligible = [];
    for (let i = 0; i < n; i++) if (!folded[i] && put[i] >= level) eligible.push(i);
    if (amount > 0) pots.push({amount, eligible});
    prev = level;
  }
  // Folded chips above every live player's level go to the last pot.
  let over = 0;
  for (let i = 0; i < n; i++) over += Math.max(0, put[i] - prev);
  if (over && pots.length) pots.at(-1).amount += over;
  // A top pot only one player can win, with others still in: what they bet
  // that no one could call. (Everyone else folded: that's just their pot.)
  let uncalled = null;
  const contested = pots.filter(p => p.eligible.length > 1);
  if (contested.length && pots.at(-1).eligible.length === 1) {
    const top = pots.pop();
    uncalled = {seat: top.eligible[0], amount: top.amount};
  }
  return {pots, uncalled};
}

/** Whether nobody can bet any more this hand: everyone still in is all-in but at most one, who has matched every bet. */
export function bettingClosed(seats) {
  const live = seats.filter(s => !s.folded && !s.empty && !s.sitting_out);
  const free = live.filter(s => !s.all_in);
  if (live.length < 2 || free.length > 1) return false;
  return !free.length || live.every(s => amt(s.street_bet) <= amt(free[0].street_bet));
}

/**
 * The pots to show at the table now, from its state's seats ({stack,
 * street_bet, folded, all_in}) and events: null when there's just the one
 * pot and nothing uncalled (show it as usual). While betting goes on, bets
 * still out this street stay in front of the players: only chips already
 * gathered are split. Once nobody can bet any more (all-in), every chip is.
 */
export function shownPots(seats, events) {
  const put = contributions(events, seats.length);
  const closed = bettingClosed(seats);
  const gathered = closed ? put : put.map((p, i) => Math.max(0, p - amt(seats[i].street_bet)));
  const {pots, uncalled} = splitPots(gathered, seats.map(s => !!s.folded));
  if (pots.length <= 1 && !uncalled) return null;
  return {pots, uncalled};
}
