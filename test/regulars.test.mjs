import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BANKROLL_BUY_INS, LEAVE_CHANCE, betweenHands, pickRegulars, startBank } from '../src/regulars.js';

const ALL = ['doug_poker', 'milk_king', 'jen_silly', 'phil_bigmouth', 'nik_airbag', 'tom_collins', 'rampart'];
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };
// The bankroll rules alone: nobody leaves on a whim.
const stay = {leaveChance: 0};

test('each Regular brings three buy-ins: one on the table, two behind', () => {
  assert.equal(BANKROLL_BUY_INS, 3);
  assert.deepEqual(startBank(['a', 'b'], 100), [0, 200, 200]);
});

test('Regulars are picked at random, all different', () => {
  const p = pickRegulars(ALL, 5, seq(0.5, 0.1, 0.9, 0.3, 0.7));
  assert.equal(p.length, 5);
  assert.equal(new Set(p).size, 5);
  for (const id of p) assert.ok(ALL.includes(id));
  // More seats than Regulars: repeats rather than empty seats.
  assert.equal(pickRegulars(['a', 'b'], 3, seq(0)).length, 3);
});

test('a Regular above half a buy-in is left alone', () => {
  const r = betweenHands({stacks: [100, 50, 400], bank: [0, 200, 200], bots: ['a', 'b'], buyIn: 100, all: ALL, ...stay});
  assert.deepEqual(r.sets, []);
  assert.deepEqual(r.swaps, []);
  assert.deepEqual(r.bank, [0, 200, 200]);
});

test('below half a buy-in, a Regular tops up to a full buy-in from the bankroll', () => {
  const r = betweenHands({stacks: [100, 30, 0], bank: [0, 200, 200], bots: ['a', 'b'], buyIn: 100, all: ALL, ...stay});
  assert.deepEqual(r.sets, [{seat: 1, chips: 100}, {seat: 2, chips: 100}]);
  assert.deepEqual(r.bank, [0, 130, 100]);
});

test('with buy-ins by seat, each Regular tops up to their own', () => {
  // A short buyer (40) at 25 stays: over half their buy-in. A deep one
  // (400) at 150 tops up to 400; a newcomer takes the table's buy-in.
  const r = betweenHands({stacks: [100, 25, 150, 0], bank: [0, 80, 800, 0], bots: ['a', 'b', 'c'], buyIn: 100,
    buyIns: [0, 40, 400, 200], all: ALL, rng: seq(0), ...stay});
  assert.deepEqual(r.sets, [{seat: 2, chips: 400}]);
  assert.equal(r.swaps.length, 1);
  assert.equal(r.swaps[0].chips, 100);
  assert.deepEqual(r.buyIns, [0, 40, 400, 100]);
  // Without them, nothing changes: no buyIns comes back.
  assert.equal(betweenHands({stacks: [100, 60], bank: [0, 200], bots: ['a'], buyIn: 100, all: ALL, ...stay}).buyIns, undefined);
});

test('the last of a bankroll tops up only what is left', () => {
  const r = betweenHands({stacks: [100, 10], bank: [0, 40], bots: ['a'], buyIn: 100, all: ALL, ...stay});
  assert.deepEqual(r.sets, [{seat: 1, chips: 50}]);
  assert.deepEqual(r.bank, [0, 0]);
});

test('with chips left and nothing behind, a Regular plays them out', () => {
  const r = betweenHands({stacks: [100, 20], bank: [0, 0], bots: ['a'], buyIn: 100, all: ALL, ...stay});
  assert.deepEqual(r.sets, []);
  assert.deepEqual(r.swaps, []);
});

test('broke with nothing behind, a Regular leaves and a new one sits down', () => {
  const r = betweenHands({stacks: [100, 0, 300], bank: [0, 0, 200], bots: ['doug_poker', 'milk_king'], buyIn: 100, all: ALL, rng: seq(0), ...stay});
  assert.equal(r.swaps.length, 1);
  const [s] = r.swaps;
  assert.equal(s.seat, 1);
  assert.equal(s.from, 'doug_poker');
  assert.ok(!['doug_poker', 'milk_king'].includes(s.id), 'someone not already at the table');
  assert.equal(s.chips, 100);
  assert.equal(r.bank[1], 200, 'with a fresh bankroll');
  assert.deepEqual(r.bots, [s.id, 'milk_king']);
});

test('your own stack is never topped up', () => {
  const r = betweenHands({stacks: [0, 100], bank: [0, 200], bots: ['a'], buyIn: 100, all: ALL, ...stay});
  assert.deepEqual(r.sets, []);
  assert.deepEqual(r.swaps, []);
});

test('after any hand a Regular may get up and go, whatever their stack', () => {
  assert.ok(LEAVE_CHANCE >= 0.01 && LEAVE_CHANCE <= 0.02, 'about 1–2% a hand');
  // Seat 1 draws under the chance and leaves with a big stack; seat 2 doesn't.
  const r = betweenHands({stacks: [100, 900, 300], bank: [0, 200, 200], bots: ['doug_poker', 'milk_king'], buyIn: 100, all: ALL, rng: seq(0.001, 0, 0.5)});
  assert.equal(r.swaps.length, 1);
  const [s] = r.swaps;
  assert.equal(s.seat, 1);
  assert.equal(s.from, 'doug_poker');
  assert.ok(!['doug_poker', 'milk_king'].includes(s.id));
  assert.equal(s.chips, 100, 'the newcomer buys in for one buy-in');
  assert.equal(r.bank[1], 200, 'with a fresh bankroll behind');
  assert.deepEqual(r.bots, [s.id, 'milk_king']);
  // Broke Regulars aren't asked: they leave by the bankroll rules.
  const broke = betweenHands({stacks: [100, 0], bank: [0, 200], bots: ['a'], buyIn: 100, all: ALL, rng: seq(0)});
  assert.deepEqual(broke.swaps, []);
  assert.deepEqual(broke.sets, [{seat: 1, chips: 100}]);
});

test('over many hands about LEAVE_CHANCE of Regulars leave', () => {
  let x = 7;
  const rng = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  let left = 0;
  const hands = 20000;
  for (let h = 0; h < hands; h++) {
    const r = betweenHands({stacks: [100, 200, 200, 200, 200, 200], bank: [0, 200, 200, 200, 200, 200], bots: ['a', 'b', 'c', 'd', 'e'], buyIn: 200, all: ALL, rng});
    left += r.swaps.length;
  }
  const rate = left / (hands * 5);
  assert.ok(Math.abs(rate - LEAVE_CHANCE) < 0.003, `rate ${rate}`);
});

test('never two of the same player at a table: with no one else free, the seat keeps its player', () => {
  // Everyone in the pool is already seated: the broke Regular buys in again.
  const broke = betweenHands({stacks: [100, 0, 300], bank: [0, 0, 200], bots: ['a', 'b'], buyIn: 100, all: ['a', 'b'], leaveChance: 0});
  assert.deepEqual(broke.swaps, []);
  assert.deepEqual(broke.sets, [{seat: 1, chips: 100}]);
  assert.equal(broke.bank[1], 200);
  // Leaving with chips, and no one to take the seat: they stay.
  const stays = betweenHands({stacks: [100, 80, 300], bank: [0, 200, 200], bots: ['a', 'b'], buyIn: 100, all: ['a', 'b'], leaveChance: 1, rng: () => 0});
  assert.deepEqual(stays.swaps, []);
  assert.deepEqual(stays.bots, ['a', 'b']);
  // Over many hands nobody is ever seated twice, and nobody with the same name.
  let bots = ['a', 'b', 'c'], stacks = [100, 0, 0, 0];
  const nameOf = id => id.replace(/\d$/, '');
  for (let h = 0; h < 200; h++) {
    const r = betweenHands({stacks, bank: [0, 0, 0, 0], bots, buyIn: 100, all: ['a', 'b', 'c', 'd', 'a2', 'e'], leaveChance: 0.3, nameOf});
    bots = r.bots;
    assert.equal(new Set(bots.map(nameOf)).size, bots.length, bots.join());
    stacks = [100, ...bots.map(() => (Math.random() < 0.5 ? 0 : 100))];
  }
});
