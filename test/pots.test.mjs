// The pots as they form (pots.js; ducy_play::hands works them out, with
// side pots and splitting tested there). Needs the wasm build in wasm/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { returnUncalled, shownPots } from '../src/pots.js';

const seat = (o = {}) => ({stack: 0, street_bet: 0, folded: false, all_in: false, ...o});

// You (seat 0) shove $500 at 1/2; a $200 stack calls all-in.
const shove = [
  {type: 'small_blind', seat: 1, amount: 100}, {type: 'big_blind', seat: 0, amount: 200},
  {type: 'raise', seat: 1, to: 600, all_in: false}, {type: 'raise', seat: 0, to: 50000, all_in: true},
  {type: 'call', seat: 1, amount: 19400, all_in: true},
];

test('a shove a shorter stack calls: the pot is what was called, the rest goes back', () => {
  const seats = [seat({street_bet: 50000, all_in: true}), seat({street_bet: 20000, all_in: true})];
  assert.deepEqual(shownPots(seats, shove), {pots: [{amount: 40000, eligible: [0, 1]}], uncalled: {seat: 0, amount: 30000}});
});

test('one pot and nothing uncalled: shown as usual', () => {
  const events = [{type: 'small_blind', seat: 0, amount: 100}, {type: 'big_blind', seat: 1, amount: 200}, {type: 'call', seat: 0, amount: 100, all_in: false}, {type: 'board', street: 'flop', cards: []}];
  assert.equal(shownPots([seat(), seat()], events), null);
});

test('an uncalled all-in goes straight back: the bettor has it again, and their bet and the pot are what was called', () => {
  const state = {complete: false, pot: 70000, events: shove, seats: [seat({street_bet: 50000, all_in: true}), seat({street_bet: 20000, all_in: true})]};
  const s = returnUncalled(state);
  assert.equal(s.seats[0].stack, 30000);
  assert.equal(s.seats[0].street_bet, 20000);
  assert.equal(s.pot, 40000);
  assert.equal(s.seats[0].all_in, false);
  assert.equal(s.seats[1], state.seats[1]);
  // Nothing uncalled, or the hand over: as it is.
  const done = {...state, complete: true};
  assert.equal(returnUncalled(done), done);
  const plain = {complete: false, pot: 400, events: shove.slice(0, 2), seats: [seat({street_bet: 200}), seat({street_bet: 100})]};
  assert.equal(returnUncalled(plain), plain);
});
