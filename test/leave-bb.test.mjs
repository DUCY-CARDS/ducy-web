// "Leave before my big blind": who posts the next big blind (leave-bb.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { nextBigBlind } from '../src/leave-bb.js';

const seat = (stack = 100, more = {}) => ({stack, empty: false, sitting_out: false, ...more});
const six = () => [seat(), seat(), seat(), seat(), seat(), seat()];

test('six-handed: the button moves one seat, the big blind is two after it', () => {
  assert.equal(nextBigBlind(six(), 3), 0);
  assert.equal(nextBigBlind(six(), 4), 1);
  assert.equal(nextBigBlind(six(), 0), 3);
});

test('heads-up the button posts the small blind, the other player the big', () => {
  // The button moves to seat 1, which posts the small blind; seat 0 the big.
  assert.equal(nextBigBlind([seat(), seat()], 0), 0);
  assert.equal(nextBigBlind([seat(), seat()], 1), 1);
});

test('empty seats and players sitting out are skipped', () => {
  const seats = [seat(), seat(0, {empty: true}), seat(), seat(100, {sitting_out: true}), seat()];
  // Dealt in: 0, 2 and 4. The button goes to 2, the small blind 4, the big 0.
  assert.equal(nextBigBlind(seats, 0), 0);
  // From the button on 4: it goes to 0, the small blind 2, the big 4.
  assert.equal(nextBigBlind(seats, 4), 4);
});

test('a seat with no chips plays only where bots are topped up', () => {
  const seats = [seat(), seat(0), seat(), seat()];
  // Without seat 1: from the button on 1, it goes to 2, the blinds 3 and 0.
  assert.equal(nextBigBlind(seats, 1), 0);
  // From the button on 3: it goes to 0, then the blinds are 2 and 3; with
  // seat 1 dealt in (a Regulars table), 1 and 2.
  assert.equal(nextBigBlind(seats, 3), 3);
  assert.equal(nextBigBlind(seats, 3, true), 2);
});

test('fewer than two players: no big blind', () => {
  assert.equal(nextBigBlind([seat(), seat(0, {empty: true})], 0), -1);
});
