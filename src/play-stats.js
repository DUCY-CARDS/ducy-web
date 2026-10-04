// Player stats for the #play table, counted from each finished hand's events
// and seat results. The counting rules mirror ducy-play's
// OpponentModel::record (stats.rs), but rates here are raw, with their
// sample sizes, rather than smoothed toward a prior.
//
// Stats are keyed by game (nlhe, plo4, ...) and then by player id: a bot's
// personality id, or "you", so they follow a character across tables.

const STATS_KEY = 'ducyPlayStats';

const num = v => Number(v); // serde sends u64 as numbers (or BigInt for very large)

export function emptyCounts() {
  return {
    hands: 0,
    vpip: 0, // hands with chips put in voluntarily preflop
    pfr: 0, // hands raised preflop
    threeBet: 0, // re-raised a single preflop raise...
    threeBetChances: 0, // ...out of hands that faced one
    aggressive: 0, // postflop bets and raises
    calls: 0, // postflop calls
    faced: 0, // postflop bets and raises faced
    folds: 0, // postflop folds to them
    sawFlop: 0,
    showdowns: 0, // went to showdown (having seen the flop)
    wonShowdowns: 0, // won chips at showdown
    net: 0, // chips
    netBB: 0, // in big blinds
  };
}

// Counts for each seat from one finished hand. `state` is the BotTable state
// once the hand is complete: events, seats, showdown, big_blind.
export function countHand(state) {
  const n = state.seats.length;
  const c = state.seats.map(() => ({...emptyCounts(), hands: 1}));
  let street = 'preflop';
  let current = 0; // the street's bet to match
  let raises = 0; // preflop raises so far
  const bets = new Array(n).fill(0); // each seat's chips in this street
  const folded = new Array(n).fill(false);
  const vpip = new Array(n).fill(false);
  const pfr = new Array(n).fill(false);
  const chance = new Array(n).fill(false); // faced a single preflop raise
  const threeBet = new Array(n).fill(false);

  // A preflop decision facing exactly one raise is a 3-bet chance; a raise
  // there takes it.
  const preflopTurn = (seat, raised) => {
    if (street !== 'preflop' || raises !== 1 || chance[seat]) return;
    chance[seat] = true;
    threeBet[seat] = raised;
  };

  for (const e of state.events) {
    const seat = e.seat;
    const facing = seat != null && current > bets[seat];
    switch (e.type) {
      case 'small_blind':
      case 'big_blind':
        bets[seat] += num(e.amount);
        current = Math.max(current, bets[seat]);
        break;
      case 'board':
        if (e.street === 'flop') folded.forEach((f, i) => { if (!f) c[i].sawFlop = 1; });
        street = e.street;
        bets.fill(0);
        current = 0;
        break;
      case 'fold':
        preflopTurn(seat, false);
        folded[seat] = true;
        if (street !== 'preflop' && facing) { c[seat].faced++; c[seat].folds++; }
        break;
      case 'check':
        preflopTurn(seat, false);
        break;
      case 'call':
        preflopTurn(seat, false);
        if (street === 'preflop') vpip[seat] = true;
        else { c[seat].faced++; c[seat].calls++; }
        bets[seat] += num(e.amount);
        break;
      case 'bet':
      case 'raise':
        if (street === 'preflop') {
          preflopTurn(seat, true);
          vpip[seat] = pfr[seat] = true;
          raises++;
        } else {
          c[seat].aggressive++;
          if (facing) c[seat].faced++;
        }
        bets[seat] = num(e.to);
        current = Math.max(current, bets[seat]);
        break;
      default: // ante, award
    }
  }

  const bb = num(state.big_blind) || 1;
  state.seats.forEach((s, i) => {
    const x = c[i];
    x.vpip = +vpip[i];
    x.pfr = +pfr[i];
    x.threeBet = +threeBet[i];
    x.threeBetChances = +chance[i];
    x.showdowns = +(state.showdown && !s.folded && x.sawFlop === 1);
    x.wonShowdowns = +(x.showdowns === 1 && num(s.won) > 0);
    x.net = num(s.net);
    x.netBB = num(s.net) / bb;
  });
  return c;
}

export function addCounts(a, b) {
  const out = emptyCounts();
  for (const k of Object.keys(out)) out[k] = ((a && a[k]) || 0) + ((b && b[k]) || 0);
  return out;
}

// Adds a finished hand to `book` ({game: {id: counts}}) under each seat's id.
export function record(book, game, state) {
  const g = (book[game] ||= {});
  countHand(state).forEach((x, i) => {
    const id = state.seats[i].id;
    g[id] = addCounts(g[id], x);
  });
  return book;
}

export function countsFor(book, game, id) {
  return (book[game] && book[game][id]) || emptyCounts();
}

// count / total, or null with no sample.
export const ratio = (count, total) => (total > 0 ? count / total : null);

// Each stat as [count, total] (a raw rate with its sample), or a plain number.
export function rates(c) {
  return {
    hands: c.hands,
    vpip: [c.vpip, c.hands],
    pfr: [c.pfr, c.hands],
    threeBet: [c.threeBet, c.threeBetChances],
    af: [c.aggressive, c.calls],
    afq: [c.aggressive, c.aggressive + c.calls + c.folds],
    foldToBet: [c.folds, c.faced],
    wtsd: [c.showdowns, c.sawFlop],
    wsd: [c.wonShowdowns, c.showdowns],
    net: c.net,
    netBB: c.netBB,
    bb100: c.hands ? (c.netBB / c.hands) * 100 : null,
  };
}

export function loadStats() {
  try {
    const s = JSON.parse(localStorage.getItem(STATS_KEY) || 'null');
    if (s && typeof s === 'object' && !Array.isArray(s)) return s;
  } catch {}
  return {};
}

export function saveStats(book) {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(book)); } catch {}
}
