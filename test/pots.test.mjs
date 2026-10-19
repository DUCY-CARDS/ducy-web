import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bettingClosed, contributions, shownPots, splitPots } from '../src/pots.js';

const seat = (o = {}) => ({stack: 0, street_bet: 0, folded: false, all_in: false, ...o});

test('a shove a shorter stack calls: the pot is what was called, the rest goes back', () => {
  // You (seat 0) shove $500; a $200 stack calls all-in. Blinds 1/2.
  const events = [
    {type: 'small_blind', seat: 1, amount: 100}, {type: 'big_blind', seat: 0, amount: 200},
    {type: 'raise', seat: 1, to: 600}, {type: 'raise', seat: 0, to: 50000, all_in: true},
    {type: 'call', seat: 1, amount: 19400, all_in: true},
  ];
  assert.deepEqual(contributions(events, 2), [50000, 20000]);
  const seats = [seat({street_bet: 50000, all_in: true}), seat({street_bet: 20000, all_in: true})];
  assert.ok(bettingClosed(seats));
  assert.deepEqual(shownPots(seats, events), {pots: [{amount: 40000, eligible: [0, 1]}], uncalled: {seat: 0, amount: 30000}});
});

test('side pots: one for each all-in level, folded chips in the pots they reached', () => {
  // A all-in 20, B all-in 50, C and D put in 100; E folded after putting in 30.
  const {pots, uncalled} = splitPots([20, 50, 100, 100, 30], [false, false, false, false, true]);
  assert.deepEqual(pots, [
    {amount: 100, eligible: [0, 1, 2, 3]}, // 20 from each of five
    {amount: 100, eligible: [1, 2, 3]}, // 30 more from each of B, C, D, and E's last 10
    {amount: 100, eligible: [2, 3]}, // 50 more each from C and D
  ]);
  assert.equal(uncalled, null);
  // The biggest stack's extra, that nobody matched, isn't a pot.
  const r = splitPots([20, 50, 150], [false, false, false]);
  assert.deepEqual(r.pots, [{amount: 60, eligible: [0, 1, 2]}, {amount: 60, eligible: [1, 2]}]);
  assert.deepEqual(r.uncalled, {seat: 2, amount: 100});
});

test('one pot and nothing uncalled: shown as usual', () => {
  const events = [{type: 'small_blind', seat: 0, amount: 100}, {type: 'big_blind', seat: 1, amount: 200}, {type: 'call', seat: 0, amount: 100}, {type: 'board', street: 'Flop', cards: []}];
  assert.equal(shownPots([seat(), seat()], events), null);
});

test('while betting goes on, a bet not yet answered stays in front of the bettor', () => {
  // Seat 2 is all-in for $50 on an earlier street; now seat 0 bets $100 and seat 1 hasn't acted.
  const events = [
    {type: 'call', seat: 0, amount: 5000}, {type: 'call', seat: 1, amount: 5000}, {type: 'call', seat: 2, amount: 5000, all_in: true},
    {type: 'board', street: 'Flop', cards: []},
    {type: 'bet', seat: 0, to: 10000},
  ];
  const seats = [seat({street_bet: 10000}), seat(), seat({all_in: true})];
  assert.ok(!bettingClosed(seats));
  // Only the gathered $150 is split: one pot, nothing uncalled yet.
  assert.equal(shownPots(seats, events), null);
});
