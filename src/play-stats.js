// Player stats for the bot table at #play: VPIP, PFR, 3-bet, aggression,
// showdowns and winnings, counted from each finished hand's event history.
// The counting rules mirror ducy-play's OpponentModel (stats.rs), so the
// page and the bots' own reads agree; the page shows the raw rates, not the
// smoothed ones the bots use.
//
// Counts are kept by player id: "you" for the person, the personality id for
// a bot, so a bot's stats follow it across seats and tables.

// Every counter one player has, all zero.
export function emptyCounts() {
  return {
    hands: 0,
    vpip: 0, // hands with a voluntary preflop call or raise
    pfr: 0, // hands with a preflop raise
    threeBetChances: 0, // hands where it faced exactly one preflop raise
    threeBets: 0, // ... and re-raised it
    aggressive: 0, // postflop bets and raises
    calls: 0, // postflop calls
    folds: 0, // postflop folds
    facedBets: 0, // postflop bets or raises faced
    foldsToBets: 0, // ... and folded to
    sawFlop: 0,
    showdowns: 0,
    showdownsWon: 0,
    net: 0, // chips
    netBB: 0, // big blinds, so tables with different blinds add up
  };
}

const num = v => Number(v); // serde sends u64 as numbers (or BigInt for very large)

// Counts for one finished hand, one entry per seat: {id, counts}. `state` is
// the table state BotTable returns (events, seats with id/folded/won/net,
// showdown, big_blind).
export function countHand(state) {
  const n = state.seats.length;
  const c = state.seats.map(() => ({...emptyCounts(), hands: 1}));
  const bb = num(state.big_blind) || 1;
  let preflop = true;
  let streetBets = new Array(n).fill(0);
  let current = 0;
  let raises = 0; // preflop bets and raises so far (blinds aren't raises)
  const folded = new Array(n).fill(false);
  const vpip = new Array(n).fill(false);
  const pfr = new Array(n).fill(false);
  const chance = new Array(n).fill(false);
  const threeBet = new Array(n).fill(false);
  const facing = seat => current > streetBets[seat];

  // A preflop decision facing exactly one raise is a 3-bet chance, unless
  // the call put the seat all-in (it couldn't have raised).
  const preflopDecision = (seat, raised, allInCall = false) => {
    if (raises === 1 && !chance[seat] && !allInCall) {
      chance[seat] = true;
      threeBet[seat] = raised;
    }
  };

  for (const e of state.events) {
    const s = e.seat;
    switch (e.type) {
      case 'small_blind':
      case 'big_blind':
        streetBets[s] += num(e.amount);
        current = Math.max(current, streetBets[s]);
        break;
      case 'board':
        if (preflop) for (let i = 0; i < n; i++) if (!folded[i]) c[i].sawFlop = 1;
        preflop = false;
        streetBets = new Array(n).fill(0);
        current = 0;
        break;
      case 'fold':
        if (preflop) preflopDecision(s, false);
        else {
          c[s].folds++;
          if (facing(s)) { c[s].facedBets++; c[s].foldsToBets++; }
        }
        folded[s] = true;
        break;
      case 'check':
        break;
      case 'call':
        if (preflop) {
          preflopDecision(s, false, e.all_in);
          vpip[s] = true;
        } else {
          c[s].facedBets++;
          c[s].calls++;
        }
        streetBets[s] += num(e.amount);
        break;
      case 'bet':
      case 'raise':
        if (preflop) {
          preflopDecision(s, true);
          vpip[s] = pfr[s] = true;
          raises++;
        } else {
          if (facing(s)) c[s].facedBets++;
          c[s].aggressive++;
        }
        streetBets[s] = num(e.to);
        current = Math.max(current, streetBets[s]);
        break;
      default: // ante, award
        break;
    }
  }

  return state.seats.map((seat, i) => {
    const x = c[i];
    x.vpip = +vpip[i];
    x.pfr = +pfr[i];
    x.threeBetChances = +chance[i];
    x.threeBets = +threeBet[i];
    const out = folded[i] || seat.folded;
    if (state.showdown && !out) {
      x.showdowns = 1;
      x.showdownsWon = +(num(seat.won) > 0);
    }
    x.net = num(seat.net);
    x.netBB = x.net / bb;
    return {id: seat.id || (i === 0 ? 'you' : seat.name), counts: x};
  });
}

// Adds `b` into `a` (both counts) and returns `a`.
export function addCounts(a, b) {
  for (const k of Object.keys(emptyCounts())) a[k] = (a[k] || 0) + (b[k] || 0);
  return a;
}

// Adds one hand's per-seat counts into `book` ({id: counts}).
export function recordHand(book, perSeat) {
  for (const {id, counts} of perSeat) book[id] = addCounts(book[id] || emptyCounts(), counts);
  return book;
}

// A rate as {n, d}: count over sample size (d is 0 when there's no sample).
const rate = (n, d) => ({n, d, v: d ? n / d : null});

// Display rates for one player's counts. Every rate is raw (no smoothing).
export function rates(c = emptyCounts()) {
  const postflop = c.aggressive + c.calls + c.folds;
  return {
    hands: c.hands,
    vpip: rate(c.vpip, c.hands),
    pfr: rate(c.pfr, c.hands),
    threeBet: rate(c.threeBets, c.threeBetChances),
    // Bets and raises per call; infinite when it never called.
    af: {n: c.aggressive, d: c.calls, v: c.calls ? c.aggressive / c.calls : c.aggressive ? Infinity : null},
    afq: rate(c.aggressive, postflop),
    foldToBet: rate(c.foldsToBets, c.facedBets),
    wtsd: rate(c.showdowns, c.sawFlop),
    wsd: rate(c.showdownsWon, c.showdowns),
    net: c.net,
    netBB: c.netBB,
    bb100: c.hands ? (c.netBB / c.hands) * 100 : null,
  };
}

// "23% (48)": the rate and its sample size, or "—" with no sample.
export function pct(r) {
  return r.d ? `${Math.round(r.v * 100)}% (${r.d})` : '—';
}

export function afText(r) {
  if (r.v == null) return '—';
  return r.v === Infinity ? '∞' : r.v.toFixed(1);
}

// VPIP / PFR for each personality in no-limit Hold'em, as measured in
// ducy-play's README (6-handed, 1,500 hands), for comparison.
export const ADVERTISED = {
  doug_poker: [23, 16],
  old_man_coffee: [11, 3],
  mister_cheating: [44, 33],
  milk_king: [60, 3],
  phil_bigmouth: [17, 12],
  rampart: [44, 34],
  danny_smallball: [36, 22],
  chris_moneybags: [55, 7],
  uncle_gary: [47, 3],
  gus_bluffsen: [33, 23],
  lady_luck_linda: [37, 6],
  michael_miserable: [23, 18],
  brad_owned: [33, 5],
  nik_airbag: [65, 46],
  bungleman: [55, 29],
};
