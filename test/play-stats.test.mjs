// Counting rules for the #play stats tracker, on hand-written histories.
// Run with: node --test test/play-stats.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { countHand, recordHand, rates, pct, afText, emptyCounts } from '../src/play-stats.js';

const SB = (seat, amount = 1) => ({type: 'small_blind', seat, amount});
const BB = (seat, amount = 2) => ({type: 'big_blind', seat, amount});
const fold = seat => ({type: 'fold', seat});
const check = seat => ({type: 'check', seat});
const call = (seat, amount, all_in = false) => ({type: 'call', seat, amount, all_in});
const bet = (seat, to, all_in = false) => ({type: 'bet', seat, to, all_in});
const raise = (seat, to, all_in = false) => ({type: 'raise', seat, to, all_in});
const board = street => ({type: 'board', street, cards: []});
const award = (seat, amount, pot = 0) => ({type: 'award', seat, pot, amount});

// A finished hand: `seats` gives each seat's id, folded, won and net.
function hand(events, seats, {showdown = false, big_blind = 2} = {}) {
  return {
    events,
    showdown,
    big_blind,
    seats: seats.map(([id, folded, won, net]) => ({id, name: id, folded, won, net})),
  };
}

const byId = state => Object.fromEntries(countHand(state).map(({id, counts}) => [id, counts]));

test('limp is VPIP but not PFR; blinds and a BB check are neither', () => {
  // Seat 0 (button) limps, SB completes, BB checks; flop checks around, BB wins.
  const s = hand([
    SB(1), BB(2), call(0, 2), call(1, 1), check(2),
    board('flop'), check(1), check(2), check(0),
    board('turn'), check(1), check(2), check(0),
    board('river'), check(1), check(2), check(0),
    award(2, 6),
  ], [['you', false, 0, -2], ['a', false, 0, -2], ['b', false, 6, 4]], {showdown: true});
  const c = byId(s);
  assert.equal(c.you.vpip, 1);
  assert.equal(c.you.pfr, 0);
  assert.equal(c.a.vpip, 1, 'completing the small blind is voluntary');
  assert.equal(c.b.vpip, 0, 'checking the big blind is not');
  assert.equal(c.b.pfr, 0);
  for (const id of ['you', 'a', 'b']) {
    assert.equal(c[id].hands, 1);
    assert.equal(c[id].sawFlop, 1);
    assert.equal(c[id].showdowns, 1);
    assert.equal(c[id].threeBetChances, 0, 'no raise, no 3-bet chance');
  }
  assert.equal(c.b.showdownsWon, 1);
  assert.equal(c.you.showdownsWon, 0);
});

test('preflop raise counts as VPIP and PFR; folding blinds are not VPIP', () => {
  // Seat 0 raises, both blinds fold: a steal, no flop.
  const s = hand([SB(1), BB(2), raise(0, 6), fold(1), fold(2), award(0, 9)],
    [['you', false, 9, 3], ['a', true, 0, -1], ['b', true, 0, -2]]);
  const c = byId(s);
  assert.deepEqual([c.you.vpip, c.you.pfr], [1, 1]);
  assert.deepEqual([c.a.vpip, c.a.pfr, c.b.vpip], [0, 0, 0]);
  // The blinds faced one raise: each had a 3-bet chance and passed.
  assert.deepEqual([c.a.threeBetChances, c.a.threeBets], [1, 0]);
  assert.deepEqual([c.b.threeBetChances, c.b.threeBets], [1, 0]);
  assert.equal(c.you.threeBetChances, 0);
  // Folds preflop never count as folds to a bet.
  assert.equal(c.a.facedBets + c.b.facedBets, 0);
  // No flop: nobody saw it or went to showdown.
  for (const id of ['you', 'a', 'b']) assert.deepEqual([c[id].sawFlop, c[id].showdowns], [0, 0]);
});

test('3-bet: re-raising one raise; the opener facing it gets a 4-bet spot, not a 3-bet chance', () => {
  const s = hand([SB(1), BB(2), raise(0, 6), raise(1, 18), fold(2), call(0, 12),
    board('flop'), bet(1, 20), fold(0), award(1, 58)],
  [['you', true, 0, -18], ['a', false, 58, 20], ['b', true, 0, -2]]);
  const c = byId(s);
  assert.deepEqual([c.a.threeBetChances, c.a.threeBets], [1, 1]);
  assert.deepEqual([c.a.vpip, c.a.pfr], [1, 1]);
  // The big blind faced two raises when it acted: not a 3-bet chance.
  assert.equal(c.b.threeBetChances, 0);
  assert.equal(c.you.threeBetChances, 0);
  assert.deepEqual([c.you.vpip, c.you.pfr], [1, 1]);
});

test('fold to a c-bet counts postflop only', () => {
  // Seat 0 raises, BB calls; BB checks, seat 0 c-bets, BB folds.
  const s = hand([SB(1), BB(2), raise(0, 6), fold(1), call(2, 4),
    board('flop'), check(2), bet(0, 8), fold(2), award(0, 21)],
  [['you', false, 21, 8], ['a', true, 0, -1], ['b', true, 0, -6]]);
  const c = byId(s);
  assert.deepEqual([c.b.facedBets, c.b.foldsToBets, c.b.folds], [1, 1, 1]);
  assert.deepEqual([c.you.aggressive, c.you.facedBets, c.you.calls], [1, 0, 0]);
  assert.equal(c.b.sawFlop, 1);
  assert.equal(c.a.sawFlop, 0);
  assert.equal(c.b.showdowns, 0, 'no showdown');
  const r = rates(c.b);
  assert.equal(pct(r.foldToBet), '100% (1)');
  assert.equal(afText(rates(c.you).af), '∞');
});

test('check-raise: the raise faced a bet and is aggressive; the call faced a raise', () => {
  const s = hand([SB(0), BB(1), call(0, 1), check(1),
    board('flop'), check(1), bet(0, 2), raise(1, 8), call(0, 6),
    board('turn'), check(1), check(0),
    board('river'), bet(1, 10), call(0, 10),
    award(1, 40)],
  [['you', false, 0, -20], ['a', false, 40, 20]], {showdown: true});
  const c = byId(s);
  assert.deepEqual([c.a.aggressive, c.a.calls, c.a.facedBets], [2, 0, 1]);
  assert.deepEqual([c.you.aggressive, c.you.calls, c.you.facedBets, c.you.foldsToBets], [1, 2, 2, 0]);
  assert.equal(c.a.vpip, 0, 'BB checked its option');
  assert.equal(c.you.vpip, 1, 'SB completed');
  const r = rates(c.you);
  assert.equal(afText(r.af), '0.5');
  assert.equal(pct(r.afq), '33% (3)');
  assert.deepEqual([c.a.showdowns, c.a.showdownsWon, c.you.showdowns, c.you.showdownsWon], [1, 1, 1, 0]);
});

test('all-in preflop: everyone saw the flop and showdown; side pots count as a win', () => {
  // Short stack (seat 2) shoves; two callers. Seat 2 wins the main pot,
  // seat 0 the side pot.
  const s = hand([SB(1), BB(2), raise(0, 50), call(1, 49), raise(2, 20, true),
    board('flop'), check(1), check(0), board('turn'), check(1), check(0), board('river'), check(1), check(0),
    award(2, 60, 0), award(0, 60, 1)],
  [['you', false, 60, 10], ['a', false, 0, -50], ['b', false, 60, 40]], {showdown: true});
  const c = byId(s);
  for (const id of ['you', 'a', 'b']) assert.deepEqual([c[id].sawFlop, c[id].showdowns], [1, 1]);
  assert.equal(c.you.showdownsWon, 1);
  assert.equal(c.b.showdownsWon, 1);
  assert.equal(c.a.showdownsWon, 0);
});

test('an all-in call is not a 3-bet chance', () => {
  const s = hand([SB(1), BB(2), raise(0, 6), call(1, 3, true), fold(2), award(0, 10)],
    [['you', false, 10, 4], ['a', false, 0, -4], ['b', true, 0, -2]]);
  const c = byId(s);
  assert.equal(c.a.threeBetChances, 0);
  assert.equal(c.a.vpip, 1);
});

test('walk: the big blind wins, nobody plays', () => {
  const s = hand([SB(0), BB(1), fold(0), award(1, 3)],
    [['you', true, 0, -1], ['a', false, 3, 1]]);
  const c = byId(s);
  assert.deepEqual([c.you.hands, c.you.vpip, c.a.hands, c.a.vpip], [1, 0, 1, 0]);
  assert.deepEqual([c.a.sawFlop, c.a.showdowns], [0, 0]);
});

test('net and bb/100 add up across hands; stats follow the id, not the seat', () => {
  const book = {};
  // Hand 1: "a" in seat 1 wins 4; hand 2: "a" moved to seat 2 and loses 2,
  // at blinds 5/10.
  recordHand(book, countHand(hand([SB(0), BB(1), fold(0), award(1, 3)],
    [['you', true, 0, -4], ['a', false, 3, 4]])));
  recordHand(book, countHand(hand([SB(2, 5), BB(0, 10), fold(1), fold(2), award(0, 15)],
    [['you', false, 15, 5], ['b', true, 0, 0], ['a', true, 0, -5]], {big_blind: 10})));
  assert.equal(book.a.hands, 2);
  assert.equal(book.a.net, -1);
  assert.equal(book.a.netBB, 4 / 2 - 5 / 10);
  assert.equal(book.you.net, 1);
  assert.equal(rates(book.a).bb100, (1.5 / 2) * 100);
  assert.equal(book.b.hands, 1);
});

test('rates with no sample show a dash', () => {
  const r = rates(emptyCounts());
  assert.equal(pct(r.vpip), '—');
  assert.equal(afText(r.af), '—');
  assert.equal(r.bb100, null);
});
