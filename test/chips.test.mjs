import test from 'node:test';
import assert from 'node:assert/strict';
import { breakdown, chipsHtml, pay, payFrom, seatChips, stacks } from '../src/chips.js';

// Amounts are in hundredths: $1 is 100.
const $ = d => d * 100;
const total = b => b.chips.reduce((s, c) => s + c.value * c.count, 0) + b.rest;
const counts = b => Object.fromEntries(b.chips.map(c => [c.color, c.count]));

test('the chips always add up to the amount', () => {
  for (const [amount, bb] of [[$(500), $(5)], [$(400), $(2)], [$(57), $(2)], [$(10000), $(2)], [1250, 50], [$(3), $(5)], [0, $(2)]]) {
    assert.equal(total(breakdown(amount, bb)), amount, `${amount} at ${bb}`);
  }
});

test('$500 at 2/5: two red stacks and the rest in green', () => {
  assert.deepEqual(counts(breakdown($(500), $(5))), {green: 12, red: 40});
});

test('each chip keeps at most two stacks, then colours up', () => {
  assert.deepEqual(counts(breakdown($(400), $(2))), {green: 7, red: 37, white: 40});
  // Never all one colour: $484 at 1/2 is whites, reds and greens.
  assert.deepEqual(counts(breakdown($(484), $(2))), {green: 10, red: 39, white: 39});
});

test('a deep stack keeps a stack each of the small chips, the rest in big ones', () => {
  // Five stacks would not hold it: one stack each of white, red and green to
  // bet with, then the biggest chips.
  assert.deepEqual(counts(breakdown($(5000), $(2))), {black: 4, green: 20, red: 16, white: 20, yellow: 4});
  assert.deepEqual(counts(breakdown($(10000), $(2))), {black: 4, green: 20, pink: 1, red: 16, white: 20, yellow: 4});
  // Tournament chips: $100k blue, $500k red and $1M green, past the $25k orange.
  const t = counts(breakdown($(27_500_000), $(100_000)));
  assert.ok(t['green-1m'] > 0 && t.blue > 0, JSON.stringify(t));
  assert.equal(total(breakdown($(27_500_000), $(100_000))), $(27_500_000));
});

test('small amounts stay in small chips, and cents are left over', () => {
  assert.deepEqual(counts(breakdown($(57), $(2))), {red: 4, white: 37});
  const b = breakdown(1250, 50);
  assert.deepEqual(counts(b), {white: 12});
  assert.equal(b.rest, 50);
  // Under the smallest chip in play: no chips at all.
  assert.deepEqual(breakdown($(3), $(5)).chips, []);
});

test('a bet is paid with the highest-valued chips first', () => {
  assert.deepEqual(counts(pay($(11))), {red: 2, white: 1});
  assert.deepEqual(counts(pay($(137))), {black: 1, green: 1, red: 2, white: 2});
  assert.equal(total(pay(1250)), 1250);
  assert.deepEqual(stacks($(11), $(2), 4, true), [{color: 'red', count: 2}, {color: 'white', count: 1}]);
});

test('a player bets with chips they have, and the stack shows what is left', () => {
  // $400 at 1/2 is 40 whites, 37 reds and 7 greens: an $11 bet is two reds
  // and a white, from those.
  const s = seatChips($(389), $(11), $(2));
  assert.deepEqual(counts({chips: s.bet}), {red: 2, white: 1});
  assert.deepEqual(counts({chips: s.stack}), {green: 7, red: 35, white: 39});
  // With only reds, a $7 bet breaks one: a red and two whites go in, and
  // three whites come back to the stack.
  const broke = payFrom($(7), [{value: 500, color: 'red', count: 4}]);
  assert.deepEqual(counts({chips: broke.bet}), {red: 1, white: 2});
  assert.deepEqual(counts({chips: broke.stack}), {red: 2, white: 3});
  // A $30 bet with only blacks: a black breaks into four greens.
  const black = payFrom($(30), [{value: 10000, color: 'black', count: 2}]);
  assert.equal(total({chips: black.bet, rest: 0}), $(30));
  assert.equal(total({chips: black.stack, rest: 0}), $(170));
  // The stack and bet always add up to what the seat had.
  for (const [stack, bet] of [[$(390), $(10)], [$(150), $(250)], [$(0), $(400)], [$(377), $(23)]]) {
    const {stack: a, bet: b} = seatChips(stack, bet, $(2));
    assert.equal(total({chips: a, rest: 0}), stack, `stack ${stack}`);
    assert.equal(total({chips: b, rest: 0}), bet, `bet ${bet}`);
  }
});

test('at most `max` stacks of up to 20, biggest chips first', () => {
  const row = stacks($(10000), $(2), 5);
  assert.equal(row.length, 4);
  assert.ok(row.every(s => (s.mix ? s.mix.reduce((n, m) => n + m.count, 0) : s.count) <= 20));
  // A deep stack's loose big chips share one stack, the highest on top.
  assert.deepEqual(row[0], {mix: [{color: 'pink', count: 1}, {color: 'yellow', count: 4}, {color: 'black', count: 4}]});
  assert.deepEqual(row.slice(1).map(s => s.color), ['green', 'red', 'white']);
  assert.match(chipsHtml($(10000), $(2)), /ch-mix/);
  assert.deepEqual(stacks($(484), $(2), 5).map(s => s.color), ['green', 'red', 'red', 'white', 'white']);
  assert.match(chipsHtml($(500), $(5)), /ch-green/);
  assert.equal(chipsHtml(0, $(5)), '');
});
