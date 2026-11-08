// Made-up weeks at a six-handed club, for the check for real-time assistance
// (#591, relay/src/assist.js): honest players modelled as noisy versions of
// ducy's own strategy, and cheaters who play it. test/assist.test.mjs and
// scripts/assist-calibrate.mjs use them to check the thresholds.
//
// Only the preflop is played (the check reads nothing after it): the hand
// ends when the betting does, and a random player still in wins the pot.
//
// Players (makePlayer):
//   human    plays a chart of their own: ducy's ranges, each spot a little
//            wider or tighter than ducy's (SKILL's `leak`, the spread), one
//            fixed play per hand where ducy mixes, now and then a slip
//            (`slip`, a random play), raise sizes of their own habit, quick
//            on clear decisions and slower on close ones
//   solver   a cheater: ducy's strategy, mixed as ducy mixes ('sample') or
//            always its top play ('top'), on `share` of decisions (the rest
//            as a human of skill `base`), at ducy's sizes, about the same
//            time on every decision, often with the page hidden
//   memorizer  an honest player who learned ducy's public charts: its top
//            play, its sizes, a human's pace, slips of `slip`
//   switch   plays as `before` until hand `at`, then as `after`

import { decisionsOf, sixmaxSizes } from '../relay/src/assist.js';

// A small seeded random number generator (mulberry32).
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const normal = R => Math.sqrt(-2 * Math.log(R() || 1e-12)) * Math.cos(2 * Math.PI * R());
const pick = (R, ws) => {
  let x = R() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < ws.length; i++) if ((x -= ws[i]) < 0) return i;
  return ws.length - 1;
};
const oneOf = (R, xs) => xs[Math.floor(R() * xs.length)];
const top = probs => probs.indexOf(Math.max(...probs));

// Hands in each chart cell: 6 for a pair, 4 suited, 12 offsuit.
const combos = cls => {
  const r = Math.floor(cls / 13), c = cls % 13;
  return r === c ? 6 : r < c ? 4 : 12;
};

// Humans by skill: the spread of their range leaks, and how often they slip.
export const SKILL = {
  elite: {leak: 0.08, slip: 0.005},
  strong: {leak: 0.15, slip: 0.01},
  average: {leak: 0.25, slip: 0.02},
  weak: {leak: 0.4, slip: 0.04},
};

// A player: {type, act(d) → 0–3 (fold, call, raise, all-in), size(kind,
// facing, model) → big blinds, time(d) → ms, away() → bool}. `d` is the
// decision as decisionsOf gives it (spot, cls, cells, probs).
export function makePlayer(R, spec) {
  if (spec.type === 'switch') return switcher(R, spec);
  if (spec.type === 'solver') return solver(R, spec);
  if (spec.type === 'memorizer') return memorizer(R, spec);
  return human(R, spec);
}

// A human's pace: quick on clear decisions, slower on close ones.
function pace(R) {
  const speed = 0.7 + R() * 0.8;
  return d => {
    const close = 1 - Math.max(...d.probs);
    return Math.max(300, Math.round((900 + 9000 * Math.pow(close, 0.7)) * speed * Math.exp(0.5 * normal(R))));
  };
}

function human(R, {skill = 'average'} = {}) {
  const {leak, slip} = SKILL[skill];
  const ranges = new Map(), plays = new Map();
  const habit = {open: oneOf(R, [2.5, 2.5, 3, 3, 2.2, 2, 2.75]), three: oneOf(R, [3, 3, 3.5, 4, 2.8]), four: oneOf(R, [2.2, 2.3, 2.5, 2.5])};
  const awayRate = R() * 0.06;
  // Their range at a spot: ducy's continuing hands, ranked, to `1 + shift`
  // times as many.
  const rangeAt = d => {
    if (ranges.has(d.spot)) return ranges.get(d.spot);
    const passive = /vs-limp/.test(d.spot) ? 1 : 0;
    const cont = c => 1 - d.cells[c][passive];
    const order = Array.from({length: 169}, (_, i) => i).sort((a, b) => cont(b) - cont(a) || a - b);
    const want = order.reduce((s, c) => s + combos(c) * cont(c), 0) * (1 + normal(R) * leak);
    const set = new Set();
    let have = 0;
    for (const c of order) {
      if (have >= want) break;
      set.add(c);
      have += combos(c);
    }
    // What they do with a hand ducy never plays on: ducy's most common play there.
    const usual = [0, 1, 2, 3].filter(a => a !== passive).sort((a, b) => order.reduce((s, c) => s + d.cells[c][b] * combos(c), 0) - order.reduce((s, c) => s + d.cells[c][a] * combos(c), 0))[0];
    const r = {set, passive, usual};
    ranges.set(d.spot, r);
    return r;
  };
  return {
    type: `human-${skill}`,
    act(d) {
      if (R() < slip) return Math.floor(R() * 4);
      const key = `${d.spot}|${d.cls}`;
      if (!plays.has(key)) {
        const r = rangeAt(d);
        let a = r.passive;
        if (r.set.has(d.cls)) {
          // One play with this hand, drawn once from ducy's other plays.
          const w = d.probs.map((p, i) => (i === r.passive ? 0 : p));
          a = w.some(x => x > 0) ? pick(R, w) : r.usual;
        }
        plays.set(key, a);
      }
      return plays.get(key);
    },
    size(kind, facing) {
      if (kind === 'open') return habit.open;
      if (kind === 'limp') return habit.open + 1;
      return Math.round(facing * (kind === 'three' ? habit.three : habit.four) * 2) / 2;
    },
    time: pace(R),
    away: () => R() < awayRate,
  };
}

function solver(R, {mode = 'sample', share = 1, base = 'average'} = {}) {
  const fallback = human(R, {skill: base});
  const mid = 4000 + R() * 5000, awayRate = R() * 0.8;
  let using = false;
  return {
    type: `solver-${mode}${share < 1 ? `-${Math.round(share * 100)}%` : ''}`,
    act(d) {
      using = R() < share;
      if (!using) return fallback.act(d);
      return mode === 'top' ? top(d.probs) : pick(R, d.probs);
    },
    size: (kind, facing, model) => (using && model != null ? model : fallback.size(kind, facing)),
    time: d => (using ? Math.round(mid * Math.exp(0.15 * normal(R))) : fallback.time(d)),
    away: () => (using ? R() < awayRate : fallback.away()),
  };
}

// Plays as `before` until hand `at`, then as `after` (a player who starts
// using a solver).
function switcher(R, {at, before, after}) {
  const a = makePlayer(R, before), b = makePlayer(R, after);
  let now = a;
  return {
    type: `${a.type} then ${b.type}`,
    act(d) { now = d.ref.hand < at ? a : b; return now.act(d); },
    size: (...x) => now.size(...x),
    time: d => now.time(d),
    away: () => now.away(),
  };
}

function memorizer(R, {slip = 0.005} = {}) {
  const awayRate = R() * 0.06;
  return {
    type: 'memorizer',
    act: d => (R() < slip ? Math.floor(R() * 4) : top(d.probs)),
    size: (kind, facing, model) => model ?? 2.5,
    time: pace(R),
    away: () => R() < awayRate,
  };
}

// The model's raise size at decision `d`, in big blinds, or null.
function modelSize(d) {
  if (!d.spot.startsWith('hu-')) return sixmaxSizes(d.spot)[0] ?? null;
  return null;
}

const DECK = [...'23456789TJQKA'].flatMap(r => [...'shdc'].map(s => r + s));

// `hands` hands at a six-seat table, `players` (makePlayer) by seat, as full
// records (hand-records.js), one a minute from `start`. Stacks start each
// hand between 0.9 and 1.15 times `depth` big blinds.
export function playWeek({players, hands, seed, depth = 100, start = 1_000_000, names = null}) {
  const R = random(seed);
  const n = players.length, sb = 1, bb = 2;
  const name = i => names?.[i] || `P${i}`;
  const recs = [];
  for (let h = 1; h <= hands; h++) {
    const deck = [...DECK];
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    const cards = players.map((_, i) => [deck[2 * i], deck[2 * i + 1]]);
    const button = h % n, sbSeat = (button + 1) % n, bbSeat = (button + 2) % n;
    const stack = players.map(() => Math.round(depth * bb * (0.9 + R() * 0.25)));
    const put = Array(n).fill(0), folded = new Set();
    put[sbSeat] = sb; put[bbSeat] = bb;
    const rec = {
      id: `S:${h}`, at: start + h * 60_000, club: 'SIM', table: 't1', tableName: 'Main', game: 'nlhe', hand: h, sb, bb, button,
      seats: players.map((_, i) => ({seat: i, id: `id-${name(i)}`, name: name(i), cards: cards[i], folded: false, net: 0, won: 0, stackEnd: stack[i]})),
      actions: [{type: 'small_blind', seat: sbSeat, amount: sb}, {type: 'big_blind', seat: bbSeat, amount: bb}],
      times: [0, 0], how: [null, null], away: [null, null], board: [], board2: [], pot: 0, showdown: false, pots: [], deal: null,
    };
    let clock = 0, bet = bb, raises = 0, lastRaise = bb;
    // Seats to act, in order: UTG first, then after each raise everyone
    // else still in, from the raiser's left.
    let toAct = Array.from({length: n}, (_, i) => (button + 3 + i) % n);
    while (toAct.length && n - folded.size > 1) {
      const seat = toAct.shift();
      const p = players[seat];
      // What the check makes of this decision: score it as a fold, then play.
      rec.actions.push({type: 'fold', seat});
      rec.times.push(0); rec.how.push('player'); rec.away.push(false);
      // (A player who folded doesn't act again, so a fold of theirs is this one.)
      const d = decisionsOf(rec).find(x => x.id === `id-${name(seat)}` && x.act === 0);
      rec.actions.pop(); rec.times.pop(); rec.how.pop(); rec.away.pop();
      const facing = bet > put[seat];
      // Off the charts: fold to a raise most of the time, else call; check when free.
      let a = d ? p.act(d) : facing ? (R() < 0.75 ? 0 : 1) : 1;
      if (raises >= 4 && a >= 2) a = 1;
      if (a === 0 && !facing) a = 1;
      clock += d ? p.time(d) : 1500;
      let e;
      if (a === 0) { e = {type: 'fold', seat}; folded.add(seat); }
      else {
        let to = a === 3 ? stack[seat] : a === 2 ? Math.round(p.size(raises === 0 ? (rec.actions.some(x => x.type === 'call') ? 'limp' : 'open') : raises === 1 ? 'three' : 'four', bet / bb, d ? modelSize(d) : null) * bb) : 0;
        to = Math.min(Math.max(to, a >= 2 ? bet + lastRaise : 0), stack[seat]);
        if (a >= 2 && to > bet) {
          e = {type: 'raise', seat, to, all_in: to >= stack[seat]};
          lastRaise = Math.max(lastRaise, to - bet);
          bet = to; put[seat] = to; raises++;
          toAct = Array.from({length: n - 1}, (_, i) => (seat + 1 + i) % n).filter(s => !folded.has(s) && put[s] < stack[s]);
        } else if (!facing) e = {type: 'check', seat};
        else {
          const add = Math.min(bet, stack[seat]) - put[seat];
          e = {type: 'call', seat, amount: add, all_in: put[seat] + add >= stack[seat]};
          put[seat] += add;
        }
      }
      rec.actions.push(e);
      rec.times.push(clock);
      rec.how.push('player');
      rec.away.push(d ? p.away() : false);
    }
    const live = players.map((_, i) => i).filter(i => !folded.has(i));
    const winner = live[Math.floor(R() * live.length)];
    const pot = put.reduce((x, y) => x + y, 0);
    rec.actions.push({type: 'award', seat: winner, pot: 0, amount: pot});
    rec.times.push(clock); rec.how.push(null); rec.away.push(null);
    rec.seats = rec.seats.map((s, i) => {
      const won = i === winner ? pot : 0;
      return {...s, folded: folded.has(i), net: won - put[i], won, stackEnd: stack[i] - put[i] + won};
    });
    rec.pot = pot;
    recs.push(rec);
  }
  return recs;
}
