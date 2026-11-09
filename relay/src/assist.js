// ducy's check for real-time assistance (#591): players whose play is too
// close to ducy's own GTO model, as if a solver were telling them what to
// play. It reads the club's full hand records (hand-records.js) on the relay,
// in the same scheduled run as the collusion check (fair-play.js), and its
// flags go in the same report, about one player each.
//
// What it scores: preflop Hold'em decisions in the spots ducy's charts cover
// (gto-charts.js): six-handed with six dealt in, or heads-up, at a depth
// within DEPTH_TOLERANCE of one the model was solved for, on a line the
// model's tree has (standard raise sizes, no antes, straddles, limps it
// doesn't play, or all-ins before the decision). Anything else, after the
// flop included, is skipped, not guessed: the relay has no GTO engine to
// value those (its wasm is the clubs-only build, #463), and the charts give
// how often the model plays each action, not what each is worth, so "EV
// lost" is counted as plays the model never makes (as ducy's own hand
// review grades preflop plays, "off-strategy").
//
// Per player, over their scored decisions:
//   top      how often they took the model's most frequent play
//   off      how often they made a play the model never makes (0% in its chart)
//   mix      in spots the model splits, how often they took the less common
//            play, against how often the model would
//   sizes    raises at the model's exact size
//   pace     decision time on harder spots against clear ones; and how even
//            it is (spread against median)
//   away     their tab hidden while they decided
//   jump     the same player's later decisions against their earlier ones
// against the club's other players (each with MIN_BASELINE decisions or
// more) and the model itself on the same decisions (what it would score
// playing them).
//
// A player is flagged when, over MIN_DECISIONS or more, their play is as
// close to the model as the model's own: hardly ever a play it never makes
// (OFF_RATE) and its top play at least as often as it would take it
// (TOP_SLACK); or when their later decisions are that close and their
// earlier ones clearly weren't (jump). And, with NEED_BEHAVIOR, only when
// how they decided fits too (pace, even timing or the tab hidden): the
// charts are public (the site shows them), so a strong player who has
// learned them plays as close preflop. The other signals show as more lines
// about the same player. The thresholds were set by simulation
// (test/assist-sim.mjs, scripts/assist-calibrate.mjs): noisy human players
// (the model's ranges a little wide or tight, played without mixing, a few
// slips) against cheaters playing the model. A flag means "look into it",
// never proof.
//
// Output is counts, rates, seconds and hand numbers. Never a card.

import { MODEL } from './gto-charts.js';
import { binomTail } from './collusion.js';

// ---- the thresholds, all here ----
export const LIMITS = {
  // Decisions scored before a player is judged: below it, a few lucky
  // spots swing every rate.
  MIN_DECISIONS: 300,
  // A player counts toward the club's averages from this many.
  MIN_BASELINE: 100,
  // A stack depth is covered within this factor of a depth the model was
  // solved for (100 big blinds covers 80 to 125).
  DEPTH_TOLERANCE: 1.25,
  // A play the model never makes: under this share in its chart (shown 0%).
  OFF_P: 0.005,
  // As close as the model: at this share of such plays or fewer ...
  OFF_RATE: 0.01,
  // ... with the model's top play at least as often as the model itself
  // would take it on the same decisions, less this.
  TOP_SLACK: 0.02,
  // And flagged only with a sign of how they decided, too: timing that
  // doesn't follow how hard the spot is, very even timing, or the tab often
  // hidden (BEHAVIOR). Strong players who know the charts play as close
  // preflop; in the simulations, this keeps every honest player unflagged.
  NEED_BEHAVIOR: true,
  // Clear decisions: the model's top play at least this often. Close ones:
  // at most this often (the model splits them).
  CLEAR_TOP: 0.97,
  CLOSE_TOP: 0.8,
  // Jump: each half of the player's decisions needs this many, and the drop
  // in plays other than the model's top play must be beyond what luck gives
  // over the whole run (FAMILY_ALPHA split between the players checked).
  MIN_HALF: 200,
  FAMILY_ALPHA: 0.01,
  // The lines that come with a flag, each shown when it stands out:
  // mixing like the model, over this many close decisions;
  MIN_MIXED: 30,
  // raises at the model's exact size, at least this share of this many;
  SIZE_RATE: 0.9,
  MIN_SIZES: 20,
  // harder decisions (the top play under CLEAR_TOP) taking no longer than
  // clear ones (median, at most this ratio), with this many timed of each;
  PACE_RATIO: 1.2,
  MIN_TIMED: 20,
  // decision times this even (half the middle 50% spread over the median);
  EVEN_SPREAD: 0.25,
  // the tab hidden while deciding at least this share, and this many times
  // the club's.
  AWAY_RATE: 0.2,
  AWAY_TIMES: 3,
  // Hands listed per line, the newest.
  MAX_HANDS_LISTED: 10,
};

// ---- hands and spots ----

const RANKS = 'AKQJT98765432';
const POS6 = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
const PLAYER_ACTS = new Set(['fold', 'check', 'call', 'bet', 'raise']);

// A hold'em hand's cell in the charts (0–168: rows from aces down, pairs on
// the diagonal, suited above it, offsuit below), or -1.
export function handClass(cards) {
  if (cards?.length !== 2) return -1;
  const r = cards.map(c => RANKS.indexOf(String(c)[0]));
  if (r.some(x => x < 0)) return -1;
  const hi = Math.min(...r), lo = Math.max(...r);
  if (hi === lo) return hi * 13 + hi;
  return String(cards[0])[1] === String(cards[1])[1] ? hi * 13 + lo : lo * 13 + hi;
}

// Chips `chips` are `bbs` big blinds, to the chip (or half a percent).
const near = (chips, bbs, bb) => Math.abs(chips - bbs * bb) <= Math.max(0.5, 0.005 * bbs * bb);

// The chart for a depth (big blinds) from `tables` (by depth), or null when
// none is within DEPTH_TOLERANCE.
export function chartFor(tables, depth) {
  let best = null, gap = Infinity;
  for (const t of tables || []) {
    const g = Math.abs(Math.log(depth / t.bb));
    if (g < gap) { best = t; gap = g; }
  }
  return best && gap <= Math.log(LIMITS.DEPTH_TOLERANCE) + 1e-9 ? best : null;
}

// The six-handed model's raise sizes at spot `id`, in big blinds (ducy-gto's
// sixmax preflop tree): the open 2.5 (3 from the small blind; 3.5 over the
// small blind's limp), the 3-bet 3 times the open in position and 3.5 out
// of it, the 4-bet 2.3 times the 3-bet, each to the half big blind.
const halves = x => Math.round(x) / 2;
const postflop = pos => (POS6.indexOf(pos) + 2) % 6;
function openHalves(pos) { return pos === 'SB' ? 6 : 5; }
function threeBetHalves(hero, opener) {
  return Math.round(openHalves(opener) * (postflop(hero) < postflop(opener) ? 3.5 : 3));
}
export function sixmaxSizes(id) {
  if (!id) return [];
  const [kind, hero, villain] = id.startsWith('open-') ? ['open', id.slice(5)] : id.match(/^(vs-open|vs-3bet|vs-limp)-(\w+)-(\w+)$/)?.slice(1) || [];
  if (kind === 'open') return [openHalves(hero) / 2];
  if (kind === 'vs-limp') return [3.5];
  if (kind === 'vs-open') return [halves(threeBetHalves(hero, villain))];
  if (kind === 'vs-3bet') return [halves(threeBetHalves(villain, hero) * 2.3)];
  return [];
}
const sizesAt = (format, chart, id) => (format === 'sixmax' ? sixmaxSizes(id) : chart.spots.get(id)?.sizes || []);

// The table as the model sees it, or null when no chart can cover it:
// hold'em with six or two dealt in, one small blind of half the big blind
// and one big blind, no antes or posted blinds. {format, bb, pos (seat →
// position), start (seat → chips at the start)}.
function tableOf(rec) {
  if (rec.game && rec.game !== 'nlhe') return null;
  const seats = rec.seats || [];
  const n = seats.length, bb = Number(rec.bb);
  if ((n !== 6 && n !== 2) || !(bb > 0)) return null;
  const pre = [];
  for (const e of rec.actions || []) {
    if (e.type === 'board') break;
    pre.push(e);
  }
  if (pre.some(e => e.type === 'ante' || e.type === 'post')) return null;
  const sbs = pre.filter(e => e.type === 'small_blind'), bbs = pre.filter(e => e.type === 'big_blind');
  if (sbs.length !== 1 || bbs.length !== 1 || !near(Number(sbs[0].amount), 0.5, bb) || Number(bbs[0].amount) !== bb) return null;
  const order = seats.map(s => s.seat).sort((a, b) => a - b);
  const at = order.indexOf(bbs[0].seat);
  if (at < 0) return null;
  // Clockwise from the seat after the big blind: UTG … BTN, SB, BB.
  const round = order.map((_, i) => order[(at + 1 + i) % n]);
  if (round[n - 2] !== sbs[0].seat) return null;
  const pos = new Map(round.map((seat, i) => [seat, n === 6 ? POS6[i] : ['BTN', 'BB'][i]]));
  const start = new Map(seats.map(s => [s.seat, Number(s.stackEnd) - Number(s.net)]));
  if ([...start.values()].some(x => !Number.isFinite(x) || x <= 0)) return null;
  return {format: n === 6 ? 'sixmax' : 'hu', bb, pos, start, seats};
}

// The chart spot for `seat` to act, from the line so far (`line`: each
// voluntary action {seat, pos, act: 'fold'|'call'|'raise'|'allin', to}),
// by its structure only (sizes are checked against the chart later); null
// when the model's charts have no such spot.
function spotId(format, line, seat, pos, live) {
  if (line.some(a => a.act === 'allin')) return null;
  const v = line.filter(a => a.act !== 'fold');
  const raises = v.filter(a => a.act === 'raise'), calls = v.filter(a => a.act === 'call');
  const acted = line.some(a => a.seat === seat);
  if (format === 'hu') {
    const kinds = v.map(a => a.act).join(',');
    if (!kinds && pos === 'BTN') return 'hu-open-BTN';
    if (kinds === 'call' && pos === 'BB') return 'hu-vs-limp-BB-BTN';
    if (kinds === 'raise' && pos === 'BB') return 'hu-vs-open-BB-BTN';
    if (kinds === 'call,raise' && pos === 'BTN') return 'hu-vs-iso-BTN-BB';
    if (kinds === 'raise,raise' && pos === 'BTN') return 'hu-vs-3bet-BTN-BB';
    if (kinds === 'raise,raise,raise' && pos === 'BB') return 'hu-vs-4bet-BB-BTN';
    return null;
  }
  if (!raises.length && !calls.length) return pos === 'BB' ? null : `open-${pos}`;
  if (!raises.length && calls.length === 1 && calls[0].pos === 'SB' && pos === 'BB') return 'vs-limp-BB-SB';
  if (calls.length) return null;
  if (raises.length === 1 && !acted) return `vs-open-${pos}-${raises[0].pos}`;
  if (raises.length === 2 && raises[0].seat === seat && live === 2) return `vs-3bet-${pos}-${raises[1].pos}`;
  return null;
}

// Every scored decision in one full record (hand-records.js): [{id, name,
// at, ref: {table, hand}, spot, cls (the hand's chart cell; never leaves
// the relay), cells (the spot's chart), probs (fold, call, raise, all-in), act
// (0–3), sizeOk (a raise at the model's size: true/false; null otherwise),
// time (ms, or null), away (true/false/null)}]. `model`: gto-charts.js's.
export function decisionsOf(rec, model = MODEL()) {
  const table = tableOf(rec);
  if (!table) return [];
  const {format, bb, pos, start, seats} = table;
  const tables = model[format];
  const ref = {table: rec.tableName || '', hand: rec.hand};
  const line = [], folded = new Set(), out = [];
  const actions = rec.actions || [];

  // Seat `s`'s decision at event `i` (spot `id`, action `act`) against the
  // chart at their depth, if the line so far is on the model's tree there;
  // else null.
  const scored = (s, i, id, act) => {
    const cls = handClass(s.cards);
    if (!s.id || cls < 0 || rec.how?.[i] === 'clock') return null;
    const mine = start.get(s.seat);
    const others = seats.filter(x => x.seat !== s.seat && !folded.has(x.seat)).map(x => start.get(x.seat));
    const chart = chartFor(tables, Math.min(mine, Math.max(...others)) / bb);
    const spot = chart?.spots.get(id);
    if (!spot?.cells[cls]) return null;
    // Every raise before it at a size the model makes there.
    for (const a of line) {
      if (a.act === 'raise' && !sizesAt(format, chart, a.spot).some(x => near(a.to, x, bb))) return null;
    }
    const n = ['fold', 'call', 'raise', 'allin'].indexOf(act);
    const t0 = rec.times?.[i - 1], t1 = rec.times?.[i];
    return {
      id: s.id, name: s.name || '', at: Number(rec.at) || 0, ref, spot: id, cls, cells: spot.cells, probs: spot.cells[cls], act: n,
      sizeOk: n === 2 ? sizesAt(format, chart, id).some(x => near(Number(actions[i].to), x, bb)) : null,
      time: Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0 ? t1 - t0 : null,
      away: typeof rec.away?.[i] === 'boolean' ? rec.away[i] : null,
    };
  };

  for (let i = 0; i < actions.length; i++) {
    const e = actions[i];
    if (e.type === 'board') break;
    if (!PLAYER_ACTS.has(e.type) || !pos.has(e.seat)) continue;
    const s = seats.find(x => x.seat === e.seat), p = pos.get(e.seat);
    const act = e.type === 'fold' ? 'fold' : e.type === 'check' || e.type === 'call' ? 'call'
      : (e.all_in || Number(e.to) >= 0.9 * start.get(e.seat)) ? 'allin' : 'raise';
    const id = spotId(format, line, e.seat, p, seats.length - folded.size);
    const decision = id && scored(s, i, id, act);
    if (decision) out.push(decision);
    line.push({seat: e.seat, pos: p, act, to: Number(e.to) || 0, spot: id});
    if (act === 'fold') folded.add(e.seat);
  }
  return out;
}

// ---- adding up ----

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

// A player's numbers over decisions `ds`.
export function statsOf(ds) {
  const L = LIMITS;
  const st = {n: ds.length, top: 0, expTop: 0, off: 0, mixed: 0, minority: 0, expMinority: 0, varMinority: 0, sized: 0, sizeOk: 0, away: 0, awayKnown: 0, clear: [], hard: [], times: []};
  for (const d of ds) {
    const top = Math.max(...d.probs), p = d.probs[d.act];
    st.expTop += top;
    if (p >= top - 1e-9) st.top++;
    if (p < L.OFF_P) st.off++;
    if (top <= L.CLOSE_TOP) {
      st.mixed++;
      st.expMinority += 1 - top;
      st.varMinority += top * (1 - top);
      if (p < top - 1e-9) st.minority++;
    }
    if (d.sizeOk != null) { st.sized++; if (d.sizeOk) st.sizeOk++; }
    if (d.away != null) { st.awayKnown++; if (d.away) st.away++; }
    if (d.time != null) {
      st.times.push(d.time);
      if (top >= L.CLEAR_TOP) st.clear.push(d.time);
      else st.hard.push(d.time);
    }
  }
  return st;
}

// As close to the model as the model itself: few plays it never makes, and
// its top play at least as often as it would take it.
export function tooClose(st, min = LIMITS.MIN_DECISIONS) {
  return st.n >= min && st.off <= LIMITS.OFF_RATE * st.n && st.top >= st.expTop - LIMITS.TOP_SLACK * st.n;
}

// The lines about how a player decides, not what: one is needed for a flag
// (NEED_BEHAVIOR).
const BEHAVIOR = new Set(['gto-pace', 'gto-even', 'gto-away']);

const rate = (k, n) => (n ? k / n : null);
// The club's rate of `k` per `n` over everyone but `id` with enough decisions.
function clubRate(all, id, k, n) {
  let a = 0, b = 0;
  for (const [other, st] of all) {
    if (other === id || st.n < LIMITS.MIN_BASELINE) continue;
    a += k(st); b += n(st);
  }
  return rate(a, b);
}

const lastRefs = (ds, keep = () => true) => ds.filter(keep).slice(-LIMITS.MAX_HANDS_LISTED).map(d => ({...d.ref}));
const secs = ms => Math.round(ms / 100) / 10;

// The lines about player `id` (decisions `ds`, numbers `st`), with the
// club's numbers from `all` (id → stats).
function linesFor(id, ds, st, all) {
  const L = LIMITS;
  const close = d => Math.max(...d.probs) <= L.CLOSE_TOP;
  const flags = [{
    kind: 'gto-top', who: id, with: {k: st.top, n: st.n},
    solver: rate(st.expTop, st.n), club: clubRate(all, id, s => s.top, s => s.n),
    hands: lastRefs(ds, d => close(d) && d.probs[d.act] >= Math.max(...d.probs) - 1e-9),
  }, {
    kind: 'gto-off', who: id, with: {k: st.off, n: st.n}, club: clubRate(all, id, s => s.off, s => s.n),
  }];
  // Mixing as the model does: the less common play in close spots about as
  // often as it takes it (within two standard deviations).
  if (st.mixed >= L.MIN_MIXED && Math.abs(st.minority - st.expMinority) <= 2 * Math.sqrt(st.varMinority)) {
    flags.push({kind: 'gto-mix', who: id, with: {k: st.minority, n: st.mixed}, solver: rate(st.expMinority, st.mixed), club: clubRate(all, id, s => s.minority, s => s.mixed), hands: lastRefs(ds, d => close(d) && d.probs[d.act] < Math.max(...d.probs) - 1e-9)});
  }
  if (st.sized >= L.MIN_SIZES && st.sizeOk >= L.SIZE_RATE * st.sized) {
    flags.push({kind: 'gto-sizes', who: id, with: {k: st.sizeOk, n: st.sized}, club: clubRate(all, id, s => s.sizeOk, s => s.sized)});
  }
  const timed = s => s.clear.length >= L.MIN_TIMED && s.hard.length >= L.MIN_TIMED;
  if (timed(st)) {
    const clear = median(st.clear), hard = median(st.hard);
    if (hard <= L.PACE_RATIO * clear) {
      const others = [...all].filter(([o, s]) => o !== id && timed(s));
      flags.push({
        kind: 'gto-pace', who: id, clear: secs(clear), hard: secs(hard), n: st.clear.length + st.hard.length,
        club: others.length ? {clear: secs(median(others.flatMap(([, s]) => s.clear))), hard: secs(median(others.flatMap(([, s]) => s.hard)))} : null,
      });
    }
  }
  if (st.times.length >= 2 * L.MIN_TIMED) {
    const mid = median(st.times), spread = (quantile(st.times, 0.75) - quantile(st.times, 0.25)) / 2;
    if (mid > 0 && spread <= L.EVEN_SPREAD * mid) flags.push({kind: 'gto-even', who: id, median: secs(mid), spread: secs(spread), n: st.times.length});
  }
  if (st.awayKnown >= L.MIN_TIMED && st.away >= L.AWAY_RATE * st.awayKnown) {
    const club = clubRate(all, id, s => s.away, s => s.awayKnown);
    if (club == null || rate(st.away, st.awayKnown) >= L.AWAY_TIMES * club) {
      flags.push({kind: 'gto-away', who: id, with: {k: st.away, n: st.awayKnown}, club});
    }
  }
  return flags;
}

// The check over records `recs` (fullHands): {decisions, players, flagged:
// [{ids: [id], names, decisions, flags}]}, `decisions` scored in all,
// `players` with MIN_DECISIONS or more. Flags as linesFor, plus a jump
// ({kind: 'gto-jump', before, after: {top, off, n}}). No cards.
// `stats`: also `stats`, every player's numbers, judged or not, and the
// club's (playerStats), for ducy's admin.
export function assistReport(recs, {model = MODEL(), stats = false} = {}) {
  const by = new Map();
  let total = 0;
  for (const rec of recs) {
    for (const d of decisionsOf(rec, model)) {
      total++;
      if (!by.has(d.id)) by.set(d.id, []);
      by.get(d.id).push(d);
    }
  }
  const out = {decisions: total, ...assistFlags(by)};
  return stats ? {...out, stats: playerStats(by)} : out;
}

// One player's numbers in brief, from statsOf (`st`): {n (decisions), top
// (the model's top play), exp (how often the model itself would take it,
// on the same decisions), off (plays the model never makes), mixed,
// minority, expMinority (the less common play in close spots, and the
// model's), sized, sizeOk (raises, at its size), clear, hard (median
// seconds on clear and harder decisions), nClear, nHard, median, spread
// (seconds: median and half the middle 50%), timed, away, awayKnown (tab
// hidden while deciding)}. Rates and seconds only: nothing about a hand.
export function briefStats(st) {
  const r1 = v => Math.round(v * 10) / 10;
  const timed = st.times.length;
  return {
    n: st.n, top: st.top, exp: r1(st.expTop), off: st.off,
    mixed: st.mixed, minority: st.minority, expMinority: r1(st.expMinority),
    sized: st.sized, sizeOk: st.sizeOk,
    clear: st.clear.length ? secs(median(st.clear)) : null, hard: st.hard.length ? secs(median(st.hard)) : null,
    nClear: st.clear.length, nHard: st.hard.length,
    median: timed ? secs(median(st.times)) : null, spread: timed ? secs((quantile(st.times, 0.75) - quantile(st.times, 0.25)) / 2) : null, timed,
    away: st.away, awayKnown: st.awayKnown,
  };
}

// Timing ratio: harder decisions' median time over clear ones' (about 1
// means it doesn't follow how hard the spot is); null without MIN_TIMED of
// each.
export const paceOf = b => (b.nClear >= LIMITS.MIN_TIMED && b.nHard >= LIMITS.MIN_TIMED && b.clear > 0 ? Math.round((100 * b.hard) / b.clear) / 100 : null);
// Timing evenness: the spread over the median (small is very even); null
// under 2 × MIN_TIMED timed decisions.
export const evenOf = b => (b.timed >= 2 * LIMITS.MIN_TIMED && b.median > 0 ? Math.round((100 * b.spread) / b.median) / 100 : null);

// {players: [{id, name, ...briefStats}], club: {players, n, top, exp, off,
// away, awayKnown, pace, even}}: the club's from its players with
// MIN_BASELINE decisions or more (everyone, if no one has that many), with
// pace and evenness the median player's.
export function playerStats(by) {
  const players = [];
  for (const [id, ds] of by) players.push({id, name: ds[ds.length - 1]?.name || '', ...briefStats(statsOf(ds))});
  players.sort((a, b) => b.n - a.n);
  const base = players.some(p => p.n >= LIMITS.MIN_BASELINE) ? players.filter(p => p.n >= LIMITS.MIN_BASELINE) : players;
  const sum = k => base.reduce((s, p) => s + p[k], 0);
  const mid = xs => { const v = xs.filter(x => x != null); return v.length ? Math.round(100 * median(v)) / 100 : null; };
  const club = {
    players: base.length, n: sum('n'), top: sum('top'), exp: Math.round(10 * sum('exp')) / 10, off: sum('off'), away: sum('away'), awayKnown: sum('awayKnown'),
    pace: mid(base.map(paceOf)), even: mid(base.map(evenOf)),
  };
  return {players, club};
}

// {players, flagged} from each player's decisions (`by`: id → decisions).
export function assistFlags(by) {
  const L = LIMITS;
  const all = new Map();
  for (const [id, ds] of by) {
    ds.sort((a, b) => a.at - b.at);
    all.set(id, statsOf(ds));
  }
  // Jump: players with enough decisions in each half.
  const halves = new Map();
  for (const [id, ds] of by) {
    if (ds.length < 2 * L.MIN_HALF) continue;
    const m = ds.length >> 1;
    halves.set(id, [statsOf(ds.slice(0, m)), statsOf(ds.slice(m))]);
  }
  const cut = L.FAMILY_ALPHA / Math.max(1, halves.size);
  const flagged = [];
  for (const [id, ds] of by) {
    const st = all.get(id);
    const flags = [];
    const h = halves.get(id);
    let jump = null;
    if (h) {
      const [a, b] = h;
      // Plays other than the top play, before and after.
      const missA = a.n - a.top, missB = b.n - b.top, k = missA + missB;
      if (tooClose(b, L.MIN_HALF) && !tooClose(a, L.MIN_HALF) && k && binomTail(missB, k, b.n / (a.n + b.n), false) < cut) {
        jump = {kind: 'gto-jump', who: id, before: {top: a.top, off: a.off, n: a.n}, after: {top: b.top, off: b.off, n: b.n}};
      }
    }
    if (tooClose(st)) flags.push(...linesFor(id, ds, st, all));
    else if (jump) flags.push(...linesFor(id, ds.slice(ds.length >> 1), statsOf(ds.slice(ds.length >> 1)), all));
    if (jump) flags.push(jump);
    if (!flags.length || (L.NEED_BEHAVIOR && !flags.some(f => BEHAVIOR.has(f.kind)))) continue;
    flagged.push({ids: [id], names: {[id]: ds[ds.length - 1].name}, decisions: st.n, flags});
  }
  return {players: [...all.values()].filter(s => s.n >= L.MIN_DECISIONS).length, flagged};
}
