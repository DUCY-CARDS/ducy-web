// Counting rules for the #play stats (src/play-stats.js), on hand-written
// event histories. Run with `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { countHand, record, countsFor, rates, ratio, emptyCounts } from '../src/play-stats.js';

// Event builders, shaped like ducy-play's serde output.
const sb = (seat, amount = 1) => ({type: 'small_blind', seat, amount});
const bb = (seat, amount = 2) => ({type: 'big_blind', seat, amount});
const fold = seat => ({type: 'fold', seat});
const check = seat => ({type: 'check', seat});
const call = (seat, amount) => ({type: 'call', seat, amount, all_in: false});
const bet = (seat, to) => ({type: 'bet', seat, to, all_in: false});
const raise = (seat, to) => ({type: 'raise', seat, to, all_in: false});
const board = street => ({type: 'board', street, cards: []});
const award = (seat, amount) => ({type: 'award', seat, pot: 0, amount});

// A finished hand: `results` gives each seat's [won, net] and whether it folded.
function hand(events, results, {showdown = false, bigBlind = 2} = {}) {
  return {
    events,
    showdown,
    big_blind: bigBlind,
    seats: results.map(([won, net, folded], i) => ({id: `p${i}`, name: `P${i}`, won, net, folded: !!folded})),
  };
}

test('a limp is VPIP but not PFR; blinds are not VPIP', () => {
  // Seat 0 is the button, 1 the SB, 2 the BB. Button limps, SB folds, BB checks.
  const c = countHand(hand([
    sb(1), bb(2), call(0, 2), fold(1), check(2),
    board('flop'), check(2), check(0), board('turn'), check(2), check(0),
    board('river'), check(2), bet(0, 4), fold(2), award(0, 9),
  ], [[9, 4], [0, -1, true], [0, -2, true]]));
  assert.deepEqual([c[0].vpip, c[0].pfr], [1, 0]);
  assert.deepEqual([c[1].vpip, c[1].pfr], [0, 0]);
  assert.deepEqual([c[2].vpip, c[2].pfr], [0, 0]);
  assert.equal(c[0].threeBetChances, 0); // no raise to re-raise
  assert.equal(c[2].sawFlop, 1);
  assert.deepEqual([c[2].faced, c[2].folds], [1, 1]);
  assert.equal(c[0].aggressive, 1);
});

test('a preflop raise is VPIP and PFR', () => {
  const c = countHand(hand([sb(1), bb(2), raise(0, 6), fold(1), fold(2), award(0, 9)],
    [[9, 3], [0, -1, true], [0, -2, true]]));
  assert.deepEqual([c[0].hands, c[0].vpip, c[0].pfr], [1, 1, 1]);
  // The blinds faced one raise and folded: 3-bet chances not taken.
  assert.deepEqual([c[1].threeBet, c[1].threeBetChances], [0, 1]);
  assert.deepEqual([c[2].threeBet, c[2].threeBetChances], [0, 1]);
  // Preflop folds aren't folds to a bet.
  assert.deepEqual([c[1].faced, c[1].folds], [0, 0]);
  assert.equal(c[0].sawFlop, 0);
});

test('a 3-bet takes the chance; a 4-bet is not a 3-bet', () => {
  // Button opens, SB 3-bets, BB folds, button 4-bets, SB calls; no flop for the test.
  const c = countHand(hand([
    sb(1), bb(2), raise(0, 6), raise(1, 18), fold(2), raise(0, 50), call(1, 32),
    board('flop'), check(1), check(0), board('turn'), check(1), check(0),
    board('river'), check(1), check(0), award(0, 102),
  ], [[102, 52], [0, -50], [0, -2, true]], {showdown: true}));
  assert.deepEqual([c[1].threeBet, c[1].threeBetChances, c[1].pfr], [1, 1, 1]);
  // The BB and the opener only acted facing two raises: no 3-bet chance.
  assert.deepEqual([c[2].threeBet, c[2].threeBetChances], [0, 0]);
  assert.deepEqual([c[0].threeBet, c[0].threeBetChances], [0, 0]);
  // Preflop calls and raises don't count toward AF.
  assert.deepEqual([c[1].calls, c[0].aggressive], [0, 0]);
});

test('folding to a c-bet', () => {
  // Same history as stats.rs's test_record: seat 0 raises, seat 1 calls,
  // seat 2 folds; flop: seat 1 checks, seat 0 bets, seat 1 folds.
  const c = countHand(hand([
    sb(1), bb(2), raise(0, 6), call(1, 5), fold(2),
    board('flop'), check(1), bet(0, 8), fold(1), award(0, 14),
  ], [[14, 8], [0, -6, true], [0, -2, true]]));
  assert.deepEqual([c[0].vpip, c[0].pfr, c[0].aggressive, c[0].faced], [1, 1, 1, 0]);
  assert.deepEqual([c[1].vpip, c[1].pfr, c[1].faced, c[1].folds], [1, 0, 1, 1]);
  assert.deepEqual([c[2].vpip, c[2].faced], [0, 0]);
  assert.deepEqual([c[0].sawFlop, c[1].sawFlop, c[2].sawFlop], [1, 1, 0]);
  assert.deepEqual([c[0].showdowns, c[1].showdowns], [0, 0]);
});

test('a check-raise is aggression facing a bet', () => {
  // Heads-up: seat 0 is button and SB.
  const c = countHand(hand([
    sb(0), bb(1), call(0, 1), check(1),
    board('flop'), check(1), bet(0, 2), raise(1, 8), call(0, 6),
    board('turn'), bet(1, 10), fold(0), award(1, 30),
  ], [[0, -10, true], [30, 20]]));
  assert.deepEqual([c[1].aggressive, c[1].calls, c[1].faced, c[1].folds], [2, 0, 1, 0]);
  assert.deepEqual([c[0].aggressive, c[0].calls, c[0].faced, c[0].folds], [1, 1, 2, 1]);
  // The BB checking its option isn't VPIP; the SB completing is.
  assert.deepEqual([c[0].vpip, c[1].vpip], [1, 0]);
  const r = rates(c[0]);
  assert.equal(ratio(...r.af), 1); // 1 bet / 1 call
  assert.equal(ratio(...r.afq), 1 / 3); // 1 / (1 + 1 call + 1 fold)
  assert.equal(ratio(...r.foldToBet), 1 / 2);
});

test('showdown win and loss', () => {
  const c = countHand(hand([
    sb(0), bb(1), call(0, 1), check(1),
    board('flop'), check(1), check(0), board('turn'), bet(1, 4), call(0, 4),
    board('river'), check(1), check(0), award(1, 12),
  ], [[0, -6], [12, 6]], {showdown: true, bigBlind: 2}));
  assert.deepEqual([c[0].sawFlop, c[0].showdowns, c[0].wonShowdowns], [1, 1, 0]);
  assert.deepEqual([c[1].sawFlop, c[1].showdowns, c[1].wonShowdowns], [1, 1, 1]);
  assert.deepEqual([c[0].net, c[0].netBB, c[1].net, c[1].netBB], [-6, -3, 6, 3]);
});

test('an all-in preflop runs out the board and still goes to showdown', () => {
  const c = countHand(hand([
    sb(0), bb(1), {type: 'raise', seat: 0, to: 200, all_in: true}, {type: 'call', seat: 1, amount: 198, all_in: true},
    board('flop'), board('turn'), board('river'), award(0, 200), award(1, 200),
  ], [[200, 0], [200, 0]], {showdown: true}));
  // A split pot is a showdown won by both.
  for (const x of c) assert.deepEqual([x.sawFlop, x.showdowns, x.wonShowdowns, x.faced], [1, 1, 1, 0]);
  assert.deepEqual([c[1].threeBetChances, c[1].threeBet], [1, 0]);
});

test('a walk: the big blind wins without acting', () => {
  const c = countHand(hand([sb(1), bb(2), fold(0), fold(1), award(2, 3)],
    [[0, 0, true], [0, -1, true], [3, 1]]));
  assert.deepEqual(c.map(x => x.hands), [1, 1, 1]);
  assert.deepEqual(c.map(x => x.vpip), [0, 0, 0]);
  assert.deepEqual(c.map(x => x.threeBetChances), [0, 0, 0]);
  assert.deepEqual(c.map(x => x.sawFlop), [0, 0, 0]);
  assert.equal(c[2].net, 1);
});

test('record adds hands by player id, per game', () => {
  const h = hand([sb(1), bb(2), raise(0, 6), fold(1), fold(2), award(0, 9)],
    [[9, 3], [0, -1, true], [0, -2, true]]);
  const book = {};
  record(book, 'nlhe', h);
  record(book, 'nlhe', h);
  record(book, 'plo4', h);
  const p0 = countsFor(book, 'nlhe', 'p0');
  assert.deepEqual([p0.hands, p0.vpip, p0.pfr, p0.net, p0.netBB], [2, 2, 2, 6, 3]);
  assert.equal(countsFor(book, 'plo4', 'p0').hands, 1);
  assert.deepEqual(countsFor(book, 'plo5', 'p0'), emptyCounts());
  assert.equal(rates(p0).bb100, 150);
  assert.equal(ratio(...rates(emptyCounts()).vpip), null);
});
