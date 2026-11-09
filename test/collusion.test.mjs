// The collusion check (#582, relay/src/collusion.js): hands made up here,
// played by honest players, and by a pair that soft-plays each other and
// dumps chips one way. Honest play raises no flag; the pair is flagged for
// what they did, with plain counts and hand numbers, never a card.
// Needs the wasm build in wasm/.
// Run with: node --test test/collusion.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import {
  addFlagged, binomTail, boardCategory, category, checkClub, collusionReport, LIMITS, normalUpper, poissonLower, proximityFlags, strongHand, weakHand,
} from '../relay/src/collusion.js';
import { keepFullHand } from '../relay/src/hand-records.js';
import { entryTitle, fairPlayNotices, flagText, flowText } from '../src/club-fair-play.js';

// A small seeded random number generator (mulberry32).
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DECK = [...'23456789TJQKA'].flatMap(r => [...'shdc'].map(s => r + s));
const NAMES = ['Ava', 'Bo', 'Cy', 'Dee', 'Eli', 'Flo'];

// `hands` hands of hold'em at a six-seat table, as full records
// (hand-records.js). Each player has a style of their own (how often they
// play a hand, bet, fold to a bet), the same against everyone. `pair`
// [a, b] (indexes) colludes: they never bet into each other heads-up after
// the flop; with `fold`, they mostly fold to each other's raises; and b now
// and then raises big with a weak hand for a to take (`dump`, the share of
// hands it's tried in).
function play({hands, seed, pair = null, fold = false, dump = 0, start = 1_000_000}) {
  const R = random(seed);
  const n = NAMES.length;
  const style = NAMES.map(() => ({play: 0.2 + R() * 0.25, bet: 0.35 + R() * 0.3, fold: 0.3 + R() * 0.3}));
  const partner = s => (pair ? (s === pair[0] ? pair[1] : s === pair[1] ? pair[0] : -1) : -1);
  const recs = [];
  for (let h = 1; h <= hands; h++) {
    const deck = [...DECK];
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    const cards = NAMES.map((_, i) => [deck[2 * i], deck[2 * i + 1]]);
    const board = deck.slice(2 * n, 2 * n + 5);
    const button = h % n, sb = (button + 1) % n, bb = (button + 2) % n;
    const put = Array(n).fill(0), folded = new Set(), actions = [];
    const act = (type, seat, extra = {}) => actions.push({type, seat, ...extra});
    actions.push({type: 'small_blind', seat: sb, amount: 1}, {type: 'big_blind', seat: bb, amount: 2});
    put[sb] = 1; put[bb] = 2;
    const order = Array.from({length: n}, (_, i) => (button + 3 + i) % n);
    const dumping = pair && R() < dump && weakHand(cards[pair[1]], []);
    if (dumping) {
      // b raises big with a weak hand; a calls; a bets the flop; b folds.
      const [a, b] = pair;
      for (const s of order) if (s !== a && s !== b) { act('fold', s); folded.add(s); }
      act('raise', b, {to: 30, all_in: false}); put[b] = 30;
      act('call', a, {amount: 30 - put[a], all_in: false}); put[a] = 30;
      actions.push({type: 'board', street: 'flop', cards: board.slice(0, 3)});
      act('bet', a, {to: 20, all_in: false}); put[a] += 20;
      act('fold', b); folded.add(b);
    } else {
      let raiser = -1;
      for (const s of order) {
        const st = style[s];
        if (raiser < 0) {
          if (R() < st.play) { act('raise', s, {to: 6, all_in: false}); put[s] = 6; raiser = s; } else if (s === bb) act('check', s);
          else { act('fold', s); folded.add(s); }
        } else {
          const soft = fold && partner(s) === raiser;
          if (R() < (soft ? 0.25 : 1) * Math.min(0.9, st.play * 1.6)) { act('call', s, {amount: 6 - put[s], all_in: false}); put[s] = 6; } else { act('fold', s); folded.add(s); }
        }
      }
      // After the flop: each street, whoever's first may bet; the rest call or fold.
      for (const [street, cut] of [['flop', 3], ['turn', 4], ['river', 5]]) {
        const live = order.filter(s => !folded.has(s));
        if (live.length < 2) break;
        actions.push({type: 'board', street, cards: board.slice(street === 'flop' ? 0 : cut - 1, cut)});
        let bettor = -1;
        const size = 8;
        const respond = s => {
          const soft = partner(s) === bettor && live.length === 2;
          if (soft || R() < style[s].fold) { act('fold', s); folded.add(s); } else { act('call', s, {amount: size, all_in: false}); put[s] += size; }
        };
        for (const s of live) {
          if (bettor >= 0) { respond(s); continue; }
          const hu = live.length === 2 && partner(s) === live.find(x => x !== s);
          if (!hu && R() < style[s].bet) { act('bet', s, {to: size, all_in: false}); put[s] += size; bettor = s; } else act('check', s);
        }
        if (bettor >= 0) for (const s of live.slice(0, live.indexOf(bettor))) if (!folded.has(s)) respond(s);
      }
    }
    const live = order.filter(s => !folded.has(s));
    const winner = live[Math.floor(R() * live.length)];
    const pot = put.reduce((x, y) => x + y, 0);
    act('award', winner, {pot: 0, amount: pot});
    const dealt = board.slice(0, Math.max(0, ...actions.filter(e => e.type === 'board').map(e => ({flop: 3, turn: 4, river: 5})[e.street])));
    recs.push({
      // Unique per made-up game: the partner's-cards check remembers hands by id.
      id: `T:${seed}:${pair}:${fold}:${dump}:${start}:${h}`, at: start + h * 60_000, club: 'TEST-CLUB', table: 't1', tableName: 'Main', game: 'nlhe', hand: h, sb: 1, bb: 2, button,
      seats: NAMES.map((name, i) => ({seat: i, id: `id-${name}`, name, cards: cards[i], folded: folded.has(i), net: (i === winner ? pot : 0) - put[i], won: i === winner ? pot : 0, stackEnd: 200})),
      actions, board: dealt, board2: [], pot, showdown: live.length > 1, pots: [], deal: null,
    });
  }
  return recs;
}

test('hand strength: what a player’s own cards make, beyond the board', () => {
  assert.equal(category('Two pair, Kings and 8s'), 2);
  assert.equal(category('Royal flush'), 8);
  assert.equal(category('Ace high'), 0);
  assert.equal(boardCategory(['Ks', 'Kd', '2c']), 1);
  assert.equal(boardCategory(['2s', '5s', '9s', 'Js', 'Ks']), 5);
  // Two pair with the board's help is strong; the board's own two pair isn't.
  assert.equal(strongHand(['Ks', '8s'], ['Kd', '2d', 'Ah', 'Jh', '8c']), true);
  assert.equal(strongHand(['3s', '4h'], ['Kd', 'Kc', 'Ah', 'Ac', '8c']), false);
  // Omaha needs a straight or better.
  assert.equal(strongHand(['Ks', '8s', '7d', '2c'], ['Kd', '8d', 'Ah', 'Jh', '3c']), false);
  assert.equal(strongHand(['Ts', '9s', '7d', '2c'], ['Qd', '8d', 'Jh', '4h', '3c']), true);
  // Weak: junk before the flop; nothing, and no draw, after.
  assert.equal(weakHand(['7c', '2d'], []), true);
  assert.equal(weakHand(['8s', '7s'], []), false);
  assert.equal(weakHand(['Ah', '2d'], []), false);
  assert.equal(weakHand(['7c', '2d'], ['Kd', 'Qs', '9h']), true);
  assert.equal(weakHand(['7c', '2c'], ['Kc', 'Qc', '9h']), false, 'a flush draw');
  assert.equal(weakHand(['7c', '2d'], ['Kd', '7s', '9h']), false, 'a pair');
});

test('the odds: tails as expected', () => {
  assert.ok(Math.abs(binomTail(0, 10, 0.5, false) - 1 / 1024) < 1e-9);
  assert.ok(Math.abs(binomTail(10, 10, 0.5, true) - 1 / 1024) < 1e-9);
  assert.ok(Math.abs(binomTail(5, 10, 0.5, false) - 0.623046875) < 1e-9);
  assert.ok(Math.abs(poissonLower(0, 3) - Math.exp(-3)) < 1e-12);
  assert.ok(Math.abs(normalUpper(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalUpper(3) - 0.0013499) < 1e-6);
});

// HONEST_SEEDS=200 tries more tables (each one a busy week of 3,000 hands).
test('honest play raises no flag, across many hands and tables', () => {
  for (let seed = 1; seed <= (Number(process.env.HONEST_SEEDS) || 5); seed++) {
    const r = collusionReport(play({hands: 3000, seed}));
    assert.ok(r.compared > 50, `seed ${seed}: ${r.compared} comparisons made`);
    assert.deepEqual(r.flagged, [], `seed ${seed}: ${JSON.stringify(r.flagged.map(p => p.flags.map(f => [f.kind, f.with, f.elsewhere])))}`);
  }
});

// The one pair flagged in report `r`, Ava and Bo, and what for.
function flaggedPair(r) {
  assert.equal(r.flagged.length, 1, JSON.stringify(r.flagged.map(p => [p.names, p.flags.map(f => f.kind)])));
  const p = r.flagged[0];
  assert.deepEqual(new Set(p.ids), new Set(['id-Ava', 'id-Bo']));
  return {p, kinds: new Set(p.flags.map(f => f.kind))};
}

test('a pair that never bets into each other is flagged', () => {
  const {p, kinds} = flaggedPair(collusionReport(play({hands: 9000, seed: 7, pair: [0, 1]})));
  for (const k of ['raises', 'checks']) assert.ok(kinds.has(k), `${k}: ${[...kinds]}`);
  const lines = p.flags.map(f => flagText(f, {'id-Ava': 'Ava', 'id-Bo': 'Bo'}));
  assert.ok(lines.some(l => /^(Ava|Bo) rarely bets or raises against (Ava|Bo): 0 of [\d,]+ hands heads-up, against [\d,]+ of [\d,]+ with others$/.test(l)), lines.join('\n'));
  assert.ok(lines.some(l => /^(Ava|Bo) checks strong hands against (Ava|Bo): ([\d,]+) of \3 heads-up, against [\d,]+ of [\d,]+ with others$/.test(l)), lines.join('\n'));
});

test('a pair that folds to each other and dumps chips is flagged, with counts and hand numbers only', () => {
  const recs = play({hands: 3000, seed: 7, pair: [0, 1], fold: true, dump: 0.3});
  const r = collusionReport(recs);
  const {p, kinds} = flaggedPair(r);
  for (const k of ['enters', 'folds', 'dumps', 'chips']) assert.ok(kinds.has(k), `${k}: ${[...kinds]}`);
  const dumps = p.flags.find(f => f.kind === 'dumps');
  assert.equal(dumps.who, 'id-Bo');
  assert.equal(dumps.other, 'id-Ava');
  const chips = p.flags.find(f => f.kind === 'chips');
  assert.equal(chips.who, 'id-Bo', 'Bo’s chips went to Ava');
  assert.ok(chips.chips > 0 && chips.bb >= LIMITS.FLOW_BB);
  for (const f of p.flags) {
    assert.ok(f.hands.length > 0 && f.hands.length <= LIMITS.MAX_HANDS_LISTED);
    for (const h of f.hands) assert.deepEqual(Object.keys(h).sort(), ['hand', 'table']);
  }
  // No card leaves: no cards, boards or deals, and none of the hole cards.
  const text = JSON.stringify(r);
  assert.ok(!/cards|board|deal|seed/.test(text), text.slice(0, 300));
  for (const c of DECK) assert.ok(!text.includes(`"${c}"`), c);
  // The owner's page words it plainly.
  const names = {'id-Ava': 'Ava', 'id-Bo': 'Bo'};
  assert.equal(entryTitle(p, names), 'Ava and Bo');
  const lines = p.flags.map(f => flagText(f, names));
  assert.ok(lines.some(l => /^Bo lost [\d,.]+ to Ava \([\d,]+ big blinds\)$/.test(l)), lines.join('\n'));
  assert.ok(lines.some(l => /^Bo lost big pots to Ava with weak hands: [\d,]+ of [\d,]+, against [\d,]+ of [\d,]+ to others$/.test(l)), lines.join('\n'));
  assert.ok(lines.some(l => /^(Ava|Bo) folds to (Ava|Bo)’s bets: [\d,]+ of [\d,]+, against [\d,]+ of [\d,]+ to others$/.test(l)), lines.join('\n'));
  assert.match(flowText(p, names), /^Bo lost [\d,.]+ to Ava$/);
  // One notice for the pair in Needs you, until it's cleared.
  const notes = fairPlayNotices(r, {names});
  assert.equal(notes.length, 1);
  assert.equal(notes[0].name, 'Ava and Bo');
  assert.deepEqual(fairPlayNotices(r, {names, cleared: new Set([notes[0].key])}), []);
});

test('flags about one player sit beside the pairs (for later checks, #591)', () => {
  const r = collusionReport(play({hands: 3000, seed: 7, pair: [0, 1], fold: true, dump: 0.3}));
  const more = addFlagged(r, [{ids: ['id-Cy'], names: {'id-Cy': 'Cy'}, flags: [{kind: 'later', who: 'id-Cy', text: 'Cy plays like a solver'}]}]);
  assert.equal(more.flagged.length, 2);
  const cy = more.flagged.find(e => e.ids.length === 1);
  assert.equal(entryTitle(cy), 'Cy');
  assert.equal(flowText(cy), '');
  assert.equal(flagText(cy.flags[0], {}), 'Cy plays like a solver');
  assert.deepEqual(fairPlayNotices(more).map(n => n.name).sort(), ['Ava and Bo', 'Cy']);
  // More for the same pair joins its entry.
  const again = addFlagged(more, [{ids: ['id-Bo', 'id-Ava'], names: {}, flags: [{kind: 'seat', who: 'id-Ava', other: 'id-Bo', text: 'x'}]}]);
  assert.equal(again.flagged.length, 2);
  assert.equal(r.flagged[0].flags.length + 1, again.flagged.find(e => e.ids.length === 2).flags.length);
});

test('too few hands together: no flag', () => {
  const recs = play({hands: 80, seed: 9, pair: [0, 1], dump: 0});
  assert.deepEqual(collusionReport(recs).flagged, []);
});

test('the seat and location flags (#581): none without records that carry them', () => {
  assert.deepEqual(proximityFlags('a', 'b'), []);
  // Honest play with no such flags in its records: none added (test/proximity.test.mjs has the rest).
  assert.ok(!collusionReport(play({hands: 300, seed: 3})).flagged.some(e => e.flags.some(f => ['near', 'network', 'vpn', 'fake'].includes(f.kind))));
});

test('the check reads the club’s kept hands for the last week; the partner’s-cards check, all of them up to 30 days', async () => {
  const store = new Map();
  const storage = {get: async k => structuredClone(store.get(k)), put: async (k, v) => { store.set(k, structuredClone(v)); }, delete: async k => { store.delete(k); }};
  const day = 864e5, now = 400 * day;
  // Two weeks of dumping: only the last 7 days count.
  const recs = play({hands: 1400, seed: 11, pair: [0, 1], dump: 0.1, start: now - 14 * day});
  for (const r of recs) r.at = now - 14 * day + Math.floor((r.hand / recs.length) * 14 * day) - 1;
  for (const r of recs) await keepFullHand(storage, r, {days: 30}, now);
  const week = await checkClub(storage, {now, days: 30});
  assert.equal(week.since, now - 7 * day);
  assert.ok(week.hands > 600 && week.hands < 800, `${week.hands} hands in the week`);
  // The partner's-cards check (#600) reads all two weeks kept.
  assert.equal(week.partnerSince, now - 30 * day);
  assert.equal(week.partnerHands, 1400);
  const day1 = await checkClub(storage, {now, days: 1});
  assert.ok(day1.hands < 120, 'a club keeping hands a day: just that day');
  assert.equal(day1.partnerHands, day1.hands, 'and the partner’s-cards check that day too');
});
