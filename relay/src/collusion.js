// ducy's collusion check (#582): for each pair of players at an always-on
// club, how they play against each other compared with how they play against
// everyone else, from the full hand records the club's room keeps
// (hand-records.js, #580). It runs on the relay (club-room.js schedules it)
// and is the only reader of those records besides hand-records.js itself.
//
// Hole cards stay here. They're read to tell strong hands from weak ones,
// and what comes out is only counts, chips and hand numbers ("Main #212"):
// never a card. The owner sees the report (club-server.js sends it with
// their view); a flag means "look into it", not proof.
//
// What it compares, per pair (Ava, Bo):
//   raises     Ava's hands heads-up with Bo after the flop in which she bet
//              or raised, against her heads-up hands with anyone else
//   enters     Ava's hands entered after Bo entered first, against after
//              someone else did
//   folds      Ava's folds to Bo's bets and raises, against to other people's
//   checks     Ava's strong hands heads-up after the flop with Bo, played
//              without a bet or raise, against with anyone else
//   dumps      of the big pots (BIG_LOSS_BB or more) Ava lost mostly to Bo,
//              how many with a weak hand, against those lost to others
//   contest    pots both played (each put chips in by choice), against what
//              their own rates of playing hands would give
//   chips      chips that went from one to the other over the window
// and, once #581 is built, the seat and location signals (proximityFlags).
// The records also hold signals nothing here reads yet (when each action
// came, whether the player's tab was in view, each seat's connection);
// later checks about one player (#591) add their flags with addFlagged.
//
// Every comparison needs enough hands (MIN_*), a big difference (ODDS_RATIO)
// and one that luck alone would rarely give: its chance under "no
// difference" must be under FAMILY_ALPHA divided by the number of
// comparisons made in the run (a Bonferroni correction), so the whole club's
// run raises a false alarm about 1% of the time at most.

import { fullHands } from './hand-records.js';
import { handWords } from '../../wasm/ducy_wasm.js';

// ---- the thresholds, all here ----
export const LIMITS = {
  // The hands looked at: the last week, or as far back as the club keeps
  // them (Rules, Keep hands), if that's less.
  WINDOW_DAYS: 7,
  // A pair is compared only once they've been dealt in together this often:
  // below that, a handful of hands swings every rate.
  MIN_SHARED: 100,
  // Each comparison also needs this many chances against the other player
  // (hands heads-up, bets faced, strong hands, ...) and this many elsewhere,
  // so neither rate rests on a few hands.
  MIN_WITH: 20,
  MIN_ELSEWHERE: 40,
  // The chance, over a whole run, that luck alone raises a flag (it's split
  // between every comparison made, Bonferroni).
  FAMILY_ALPHA: 0.01,
  // How big a difference counts: the odds against the other player at least
  // this many times higher (or lower) than elsewhere. 4 is far beyond the
  // swing between ordinary styles and moods, so a flag needs a real change.
  ODDS_RATIO: 4,
  // A losing hand counts toward chip dumping once the loser put in this many
  // big blinds, with a weak hand (weakHand), the other player taking most of it.
  BIG_LOSS_BB: 10,
  // ... and needs at least this many such hands.
  MIN_DUMPS: 3,
  // Pots never contested: what their rates of playing hands would give
  // together must be at least this many pots, and what they played at most
  // this share of it.
  MIN_EXPECTED_CONTESTS: 8,
  CONTEST_SHARE: 0.25,
  // Chips one way, net, flagged on their own: at this many big blinds
  // (beyond what luck gives, like every comparison), when it's at least this
  // share of what the loser lost overall and of what the winner won, over
  // at least this many hands (one big pot, a cooler, isn't a pattern). Any
  // pair, however few hands they shared. High, because a good player's edge
  // over a poor one moves chips one way too: in made-up weeks of 3,000 hands
  // with players of very different skill, 300 big blinds flagged about one
  // honest table in 75. Every flagged pair's report says what moved between
  // them anyway (`flow`).
  FLOW_BB: 1000,
  FLOW_SHARE: 0.6,
  FLOW_MIN_HANDS: 10,
  // Hands listed per flag, the newest; and pairs in the report.
  MAX_HANDS_LISTED: 10,
  MAX_PAIRS: 20,
};

// When it runs (club-room.js): once play stops for QUIET_MS (a session's
// end), and every EVERY_MS while play goes on, counted from the first hand
// not yet checked. Never while no hands are played.
export const SCHEDULE = {
  QUIET_MS: 30 * 60_000,
  EVERY_MS: 3 * 3600_000,
};

// ---- hand strength, from hole cards (never reported) ----

const RANKS = '23456789TJQKA';
const rankOf = c => RANKS.indexOf(String(c)[0]);
const suitOf = c => String(c)[1];

// A made hand's category from ducy's words for it (handWords): 0 high card,
// 1 pair, 2 two pair, 3 trips, 4 straight, 5 flush, 6 full house, 7 quads,
// 8 straight flush; -1 unknown.
export function category(words) {
  const w = String(words || '');
  if (/^(Royal flush|Straight flush)/.test(w)) return 8;
  if (/^Four of a kind/.test(w)) return 7;
  if (/^Full house/.test(w)) return 6;
  if (/^Flush/.test(w)) return 5;
  if (/^Straight/.test(w)) return 4;
  if (/^Three of a kind/.test(w)) return 3;
  if (/^Two pair/.test(w)) return 2;
  if (/^Pair/.test(w)) return 1;
  if (/ high$/.test(w)) return 0;
  return -1;
}

// What the board makes by itself (same scale), so a hand counts only for
// what its own cards add.
export function boardCategory(board) {
  const counts = {};
  for (const c of board) counts[rankOf(c)] = (counts[rankOf(c)] || 0) + 1;
  const n = Object.values(counts).sort((a, b) => b - a);
  let cat = 0;
  if (n[0] >= 4) cat = 7;
  else if (n[0] === 3 && n[1] >= 2) cat = 6;
  else if (n[0] === 3) cat = 3;
  else if (n[0] === 2 && n[1] === 2) cat = 2;
  else if (n[0] === 2) cat = 1;
  if (board.length === 5) {
    if (new Set(board.map(suitOf)).size === 1) cat = Math.max(cat, 5);
    if (straightIn(new Set(board.map(rankOf)))) cat = Math.max(cat, 4);
  }
  return cat;
}

// Five ranks in a row among `ranks` (a set of rank indexes), the wheel too.
function straightIn(ranks) {
  const has = r => ranks.has(r) || (r === -1 && ranks.has(12));
  for (let lo = -1; lo <= 8; lo++) if ([0, 1, 2, 3, 4].every(i => has(lo + i))) return true;
  return false;
}

const omaha = hole => hole.length > 2;
const madeCat = (hole, board) => {
  try { return category(handWords(hole, board)); } catch { return -1; }
};

// Strong: a hand worth betting for value after the flop that its own cards
// make. Hold'em: two pair or better, beyond what the board shows; Omaha
// (where two pair is ordinary): a straight or better.
export function strongHand(hole, board) {
  if (!hole?.length || board.length < 3) return false;
  const cat = madeCat(hole, board);
  return cat > boardCategory(board) && cat >= (omaha(hole) ? 4 : 2);
}

// Weak: nothing a player would put many chips in with. Before the flop
// (hold'em only; Omaha's starting hands aren't judged): no pair, nothing
// higher than a 9, and not suited and close together. After: nothing beyond
// the board, and no flush or straight draw.
export function weakHand(hole, board) {
  if (!hole?.length) return false;
  if (board.length < 3) {
    if (omaha(hole) || hole.length !== 2) return false;
    const [a, b] = hole.map(rankOf);
    if (a === b || Math.max(a, b) >= rankOf('T')) return false;
    return !(suitOf(hole[0]) === suitOf(hole[1]) && Math.abs(a - b) <= 2);
  }
  const cat = madeCat(hole, board);
  if (cat < 0 || cat > boardCategory(board)) return false;
  return board.length === 5 || !drawing(hole, board);
}

// A flush or straight draw (four to one, a hole card in it).
function drawing(hole, board) {
  const all = [...hole, ...board];
  for (const s of new Set(hole.map(suitOf))) if (all.filter(c => suitOf(c) === s).length >= 4) return true;
  const ranks = new Set(all.map(rankOf)), mine = new Set(hole.map(rankOf));
  const has = r => ranks.has(r) || (r === -1 && ranks.has(12));
  const isMine = r => mine.has(r) || (r === -1 && mine.has(12));
  for (let lo = -1; lo <= 8; lo++) {
    const run = [0, 1, 2, 3, 4].map(i => lo + i);
    if (run.filter(has).length >= 4 && run.some(r => has(r) && isMine(r))) return true;
  }
  return false;
}

// ---- odds ----

// log Γ(x), Lanczos.
function lgamma(x) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
const logChoose = (n, k) => lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
const binom = (i, n, p) => Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));

// The chance of k or fewer (lower) or k or more (upper) in n at rate p.
export function binomTail(k, n, p, upper) {
  let s = 0;
  if (upper) for (let i = k; i <= n; i++) s += binom(i, n, p);
  else for (let i = 0; i <= k; i++) s += binom(i, n, p);
  return Math.min(1, s);
}

// The chance of k or fewer at a Poisson mean of `mean`.
export function poissonLower(k, mean) {
  let s = 0;
  for (let i = 0; i <= k; i++) s += Math.exp(i * Math.log(mean) - mean - lgamma(i + 1));
  return Math.min(1, s);
}

// The chance of z or more on a standard normal (Abramowitz and Stegun
// 7.1.26 for erfc, to about 1e-7).
export function normalUpper(z) {
  if (z < 0) return 1 - normalUpper(-z);
  const x = z / Math.SQRT2, u = 1 / (1 + 0.3275911 * x);
  const erfc = u * (0.254829592 + u * (-0.284496736 + u * (1.421413741 + u * (-1.453152027 + u * 1.061405429)))) * Math.exp(-x * x);
  return erfc / 2;
}

// ---- reading the hands ----

// Counts of chances (n) and hits (k), with the newest hands of each.
const counter = () => ({n: 0, k: 0, all: [], hits: []});
const keep = (list, ref) => {
  list.push(ref);
  if (list.length > 2 * LIMITS.MAX_HANDS_LISTED) list.splice(0, LIMITS.MAX_HANDS_LISTED);
};
const note = (c, ref, hit) => {
  c.n++;
  keep(c.all, ref);
  if (hit) { c.k++; keep(c.hits, ref); }
};

// One hand: what each seat did, and against whom. `t` collects the counts.
function readHand(rec, t) {
  const seats = (rec.seats || []).filter(s => s.id);
  if (seats.length < 2) return;
  const bb = Number(rec.bb) || 1;
  const ref = {table: rec.tableName || '', hand: rec.hand, at: rec.at};
  const idAt = new Map(seats.map(s => [s.seat, s.id]));
  const ids = seats.map(s => s.id);
  for (const s of seats) t.name.set(s.id, s.name || t.name.get(s.id) || '');
  for (const id of ids) t.hands.set(id, (t.hands.get(id) || 0) + 1);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const p = t.pair(ids[i], ids[j]);
      p.shared++;
      keep(p.recent, ref);
    }
  }

  const folded = new Set();
  const board = [];
  let preflop = true, aggressor = null, firstIn = null, flopLive = null;
  const entered = new Set(), postAgg = new Set(), lastBoard = new Map();
  const huSeen = new Map(), huAgg = new Map(); // `${a}|${b}` → true, this hand
  const facedOpen = new Set(); // seats that acted after firstIn entered
  const faced = new Map(); // `${a}|${b}` → folded? (the first bet from b that a faced)
  for (const e of rec.actions || []) {
    if (e.type === 'board') {
      if (preflop) flopLive = ids.filter(id => !folded.has(id));
      preflop = false;
      aggressor = null;
      board.push(...(e.cards || []));
      continue;
    }
    const id = idAt.get(e.seat);
    if (!id || !['fold', 'check', 'call', 'bet', 'raise'].includes(e.type)) continue;
    const live = ids.filter(x => !folded.has(x));
    if (!preflop && live.length === 2 && live.includes(id)) {
      const other = live.find(x => x !== id);
      huSeen.set(`${id}|${other}`, true);
      if (e.type === 'bet' || e.type === 'raise') huAgg.set(`${id}|${other}`, true);
    }
    if (preflop && firstIn && firstIn !== id && !entered.has(id)) facedOpen.add(id);
    if (aggressor && aggressor !== id && !faced.has(`${id}|${aggressor}`)) faced.set(`${id}|${aggressor}`, e.type === 'fold');
    if (e.type === 'fold') { folded.add(id); continue; }
    if (e.type === 'check') continue;
    lastBoard.set(id, board.length);
    if (preflop) { entered.add(id); firstIn ||= id; }
    if (e.type === 'bet' || e.type === 'raise') {
      aggressor = id;
      if (!preflop) postAgg.add(id);
    }
  }

  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      const d = t.dir(a, b), k = `${a}|${b}`;
      if (huSeen.has(k)) note(d.raises, ref, huAgg.has(k));
      if (facedOpen.has(a) && firstIn === b) note(d.enters, ref, entered.has(a));
      if (faced.has(k)) note(d.folds, ref, faced.get(k));
    }
  }

  // Pots both played.
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (entered.has(ids[i]) && entered.has(ids[j])) t.pair(ids[i], ids[j]).contested++;
    }
  }
  for (const id of entered) t.entered.set(id, (t.entered.get(id) || 0) + 1);

  // Strong hands heads-up after the flop, and whether they were bet.
  if (flopLive?.length === 2) {
    for (const [a, b] of [flopLive, [...flopLive].reverse()]) {
      const s = seats.find(x => x.id === a);
      if (folded.has(a) || !strongHand(s.cards, board.slice(0, 5))) continue;
      note(t.dir(a, b).checks, ref, !postAgg.has(a));
    }
  }

  // Who lost what to whom: each loser's loss shared among the winners, by
  // what they won.
  const winners = seats.filter(s => Number(s.net) > 0);
  const won = winners.reduce((x, s) => x + Number(s.net), 0);
  for (const s of seats) t.net.set(s.id, (t.net.get(s.id) || 0) + Number(s.net || 0) / bb);
  for (const l of seats.filter(s => Number(s.net) < 0)) {
    const lost = -Number(l.net);
    let main = null;
    for (const w of winners) {
      const share = lost * Number(w.net) / won;
      const f = t.dir(l.id, w.id).flow;
      f.chips += share;
      f.bb += share / bb;
      f.sq += (share / bb) ** 2;
      f.n++;
      // The biggest hands, for the report.
      f.hands.push({...ref, bb: share / bb});
      if (f.hands.length > 2 * LIMITS.MAX_HANDS_LISTED) f.hands = f.hands.sort((x, y) => y.bb - x.bb).slice(0, LIMITS.MAX_HANDS_LISTED);
      if (share * 2 > lost) main = w.id;
    }
    // A big loss, most of it to one player, and whether it was with a weak
    // hand (as it stood when the loser last put chips in).
    if (lost / bb >= LIMITS.BIG_LOSS_BB && main && lastBoard.has(l.id)) {
      t.bigLosses.push({from: l.id, to: main, weak: weakHand(l.cards, board.slice(0, lastBoard.get(l.id))), ref});
    }
  }
}

// The counts for every pair, from records `recs`.
function tally(recs) {
  const pairs = new Map(), dirs = new Map();
  const t = {
    name: new Map(), hands: new Map(), entered: new Map(), net: new Map(), bigLosses: [],
    pair(a, b) {
      const [x, y] = a < b ? [a, b] : [b, a];
      const k = `${x}|${y}`;
      if (!pairs.has(k)) pairs.set(k, {a: x, b: y, shared: 0, contested: 0, recent: []});
      return pairs.get(k);
    },
    dir(a, b) {
      const k = `${a}|${b}`;
      if (!dirs.has(k)) dirs.set(k, {raises: counter(), enters: counter(), folds: counter(), checks: counter(), flow: {chips: 0, bb: 0, sq: 0, n: 0, hands: []}});
      return dirs.get(k);
    },
    pairs, dirs,
  };
  for (const rec of recs) readHand(rec, t);
  return t;
}

// Player `a`'s counts of `what` against everyone but `b`. With three or
// more others, the one who makes `b` stand out most is left out too (for
// an `upper` comparison, the one with the lowest rate; else the highest):
// one other odd pair (a second partner, or a player `a` happens to play
// oddly against) mustn't make an ordinary one look odd.
function elsewhere(t, a, b, what, upper) {
  const each = [];
  for (const [k, d] of t.dirs) {
    const [x, y] = k.split('|');
    if (x === a && y !== b && d[what].n) each.push(d[what]);
  }
  if (each.length >= 3) {
    each.sort((p, q) => odds(p.k, p.n) - odds(q.k, q.n));
    if (upper) each.shift(); else each.pop();
  }
  return each.reduce((out, c) => ({n: out.n + c.n, k: out.k + c.k}), {n: 0, k: 0});
}

// Hands `a` was dealt in with anyone but `b` (counted once per other player).
function withOthers(t, a, b) {
  let n = 0;
  for (const p of t.pairs.values()) if ((p.a === a || p.b === a) && p.a !== b && p.b !== b) n += p.shared;
  return n;
}

// Odds, nudged off 0 and 1 (half a hand each way) so a clean sheet compares.
const odds = (k, n) => (k + 0.5) / (n - k + 0.5);

// ---- the check ----

// The report from records `recs` (fullHands), at `now`: {at, since, hands,
// players, compared, flagged: [{ids: [a, b], names, shared, contested,
// flow, flags: [{kind, who, other, with: {k, n}, elsewhere: {k, n}, hands:
// [{table, hand}]}]}]}, the flagged pairs only, most flags first. No cards.
export function collusionReport(recs, {now = Date.now(), since = 0} = {}) {
  const t = tally(recs);
  const L = LIMITS;
  const tests = [];
  const lastRefs = hs => hs.slice(-L.MAX_HANDS_LISTED).map(({table, hand}) => ({table, hand}));

  const flowOf = (a, b) => t.dirs.get(`${a}|${b}`)?.flow || {chips: 0, bb: 0, sq: 0, n: 0, hands: []};

  for (const p of t.pairs.values()) {
    // Chips one way, net, checked for every pair (dumping can be quick):
    // luck makes them swing by about the root of the sum of each hand's
    // share squared. A flow far beyond that and big, that's most of what
    // the loser lost overall and most of what the winner won, is flagged: a
    // good player beating the whole table, or a poor one losing to it,
    // isn't. Both must have played others too (two friends playing only
    // each other move chips only between them).
    for (const [a, b] of [[p.a, p.b], [p.b, p.a]]) {
      const f = flowOf(a, b), back = flowOf(b, a);
      const net = f.bb - back.bb, spread = Math.sqrt(f.sq + back.sq);
      const lost = -(t.net.get(a) || 0), won = t.net.get(b) || 0;
      if (net <= 0 || f.n < L.FLOW_MIN_HANDS || !spread || withOthers(t, a, b) < L.MIN_ELSEWHERE || withOthers(t, b, a) < L.MIN_ELSEWHERE) continue;
      const biggest = [...f.hands].sort((x, y) => y.bb - x.bb).slice(0, L.MAX_HANDS_LISTED).sort((x, y) => x.at - y.at);
      tests.push({
        pair: p, kind: 'chips', who: a, other: b, chips: Math.round(f.chips - back.chips), bb: Math.round(net), hands: lastRefs(biggest),
        big: net >= L.FLOW_BB && lost > 0 && won > 0 && net >= L.FLOW_SHARE * lost && net >= L.FLOW_SHARE * won,
        chance: normalUpper(net / spread),
      });
    }
    if (p.shared < L.MIN_SHARED) continue;
    for (const [a, b] of [[p.a, p.b], [p.b, p.a]]) {
      const d = t.dir(a, b);
      // Lower against the other player: raises, entering pots.
      // Higher: folding to their bets, checking strong hands.
      for (const [what, upper] of [['raises', false], ['enters', false], ['folds', true], ['checks', true]]) {
        const w = d[what], e = elsewhere(t, a, b, what, upper);
        if (w.n < L.MIN_WITH || e.n < L.MIN_ELSEWHERE) continue;
        const ratio = odds(w.k, w.n) / odds(e.k, e.n);
        const p0 = (e.k + 0.5) / (e.n + 1);
        tests.push({
          pair: p, kind: what, who: a, other: b, with: {k: w.k, n: w.n}, elsewhere: {k: e.k, n: e.n},
          big: upper ? ratio >= L.ODDS_RATIO : ratio <= 1 / L.ODDS_RATIO,
          chance: binomTail(w.k, w.n, p0, upper),
          hands: lastRefs(upper ? w.hits : w.all),
        });
      }
      // Of the big pots `a` lost to `b`, how many with a weak hand; against
      // the big pots `a` lost to anyone else.
      const mine = t.bigLosses.filter(x => x.from === a);
      const to = mine.filter(x => x.to === b), notTo = mine.filter(x => x.to !== b);
      const w = {k: to.filter(x => x.weak).length, n: to.length}, e = {k: notTo.filter(x => x.weak).length, n: notTo.length};
      if (w.k >= L.MIN_DUMPS && e.n >= L.MIN_WITH) {
        const p0 = (e.k + 0.5) / (e.n + 1);
        tests.push({
          pair: p, kind: 'dumps', who: a, other: b, with: w, elsewhere: e,
          big: odds(w.k, w.n) / odds(e.k, e.n) >= L.ODDS_RATIO,
          chance: binomTail(w.k, w.n, p0, true),
          hands: lastRefs(to.filter(x => x.weak).map(x => x.ref)),
        });
      }
    }
    // Pots both played, against what each one's rate of playing hands gives.
    const ra = (t.entered.get(p.a) || 0) / (t.hands.get(p.a) || 1), rb = (t.entered.get(p.b) || 0) / (t.hands.get(p.b) || 1);
    const expected = p.shared * ra * rb;
    if (expected >= L.MIN_EXPECTED_CONTESTS) {
      tests.push({
        pair: p, kind: 'contest', who: p.a, other: p.b, with: {k: p.contested, n: p.shared}, expected: Math.round(expected),
        big: p.contested <= expected * L.CONTEST_SHARE,
        chance: poissonLower(p.contested, expected),
        hands: lastRefs(p.recent),
      });
    }
  }

  // Bonferroni: each comparison's share of the run's false-alarm chance.
  const cut = L.FAMILY_ALPHA / Math.max(1, tests.length);
  const flagged = new Map();
  const flagOf = p => {
    if (!flagged.has(p)) flagged.set(p, []);
    return flagged.get(p);
  };
  for (const x of tests) {
    if (!x.big || x.chance >= cut) continue;
    const {pair: _p, big: _b, chance: _c, ...flag} = x;
    flagOf(x.pair).push(flag);
  }

  // Seat and location flags (#581), for every pair that shared a hand.
  for (const p of t.pairs.values()) {
    const more = proximityFlags(p.a, p.b, t);
    if (more.length) flagOf(p).push(...more);
  }

  const entries = [...flagged].map(([p, flags]) => ({
    ids: [p.a, p.b], names: {[p.a]: t.name.get(p.a) || '', [p.b]: t.name.get(p.b) || ''},
    shared: p.shared, contested: p.contested,
    // Net chips between them: above 0, the first lost that much to the second.
    flow: Math.round(flowOf(p.a, p.b).chips - flowOf(p.b, p.a).chips),
    flags,
  }));
  return {at: now, since, hands: recs.length, players: t.hands.size, compared: tests.length, flagged: sortFlagged(entries)};
}

// The report's `flagged` list, most flags first, at most MAX_PAIRS. Each is
// about a pair (`ids` [a, b]) or one player (`ids` [a]): later checks
// about one player (#591, play too close to ducy's own) add theirs with
// addFlagged, and the owner's page shows both alike (club-fair-play.js).
const sortFlagged = list => [...list].sort((x, y) => y.flags.length - x.flags.length || (y.shared || 0) - (x.shared || 0)).slice(0, LIMITS.MAX_PAIRS);

// Report `report` with more flagged players or pairs, `more`: [{ids,
// names: {id: name}, flags: [{kind, who, ...}]}], merged into any entry
// for the same people.
export function addFlagged(report, more) {
  const list = (report.flagged || []).map(e => ({...e, flags: [...e.flags]}));
  for (const m of more) {
    const key = [...m.ids].sort().join('|');
    const at = list.find(e => [...e.ids].sort().join('|') === key);
    if (at) at.flags.push(...m.flags);
    else list.push({...m, flags: [...m.flags]});
  }
  return {...report, flagged: sortFlagged(list)};
}

// Seat and location flags (#581): players who always sit together, or play
// from the same place. Not built yet: when it is, its flags for the pair
// (a, b) come back from here in the same shape ({kind, who, other, ...};
// `t`, this run's counts, if it needs them), and the owner's page words
// them (club-fair-play.js flagText).
export function proximityFlags(_a, _b, _t) {
  return [];
}

// The check over the club's kept hands (storage: the club room's), at
// `now`, for the last WINDOW_DAYS (or `days`, the club's Keep hands, if
// fewer).
export async function checkClub(storage, {now = Date.now(), days = LIMITS.WINDOW_DAYS} = {}) {
  const since = now - Math.min(LIMITS.WINDOW_DAYS, Math.max(1, Number(days) || 1)) * 864e5;
  return collusionReport(await fullHands(storage, {since}), {now, since});
}
