import test from 'node:test';
import assert from 'node:assert/strict';
import { breakdown, chipsHtml, handChips, pay, payFrom, seatChips, stacks } from '../src/chips.js';

// Amounts are in hundredths: $1 is 100.
const $ = d => d * 100;
const total = b => b.chips.reduce((s, c) => s + c.value * c.count, 0) + b.rest;
const counts = b => Object.fromEntries(b.chips.map(c => [c.color, c.count]));

test('the chips always add up to the amount', () => {
  for (const [amount, bb] of [[$(500), $(5)], [$(400), $(2)], [$(57), $(2)], [$(10000), $(2)], [1250, 50], [$(3), $(5)], [0, $(2)]]) {
    assert.equal(total(breakdown(amount, bb)), amount, `${amount} at ${bb}`);
  }
});

test('the stack chip is green at 1/2 and 2/5, black at 5/10', () => {
  assert.deepEqual(counts(breakdown($(500), $(5))), {green: 20});
  assert.deepEqual(counts(breakdown($(1000), $(10))), {black: 10});
});

test('two stacks of the stack chip first, change in smaller chips, bigger chips above', () => {
  // $1,047 at 1/2: two stacks of green, 9 red and 2 white.
  assert.deepEqual(counts(breakdown($(1047), $(2))), {green: 40, red: 9, white: 2});
  assert.deepEqual(counts(breakdown($(400), $(2))), {green: 16});
  assert.deepEqual(counts(breakdown($(484), $(2))), {green: 19, red: 1, white: 4});
  // Past two stacks of green, blacks.
  assert.deepEqual(counts(breakdown($(2000), $(2))), {black: 10, green: 40});
  assert.deepEqual(counts(breakdown($(2047), $(2))), {black: 10, green: 40, red: 9, white: 2});
});

test('a deep stack: bigger chips fill up to five stacks, the rest on one stack of big ones', () => {
  assert.deepEqual(counts(breakdown($(5000), $(2))), {black: 40, green: 40});
  assert.deepEqual(counts(breakdown($(10000), $(2))), {black: 40, green: 40, purple: 10});
  assert.deepEqual(counts(breakdown($(30000), $(2))), {black: 40, green: 40, pink: 5});
  // Five stacks would not hold it beside the change: the rest colours up
  // only as far as it takes to fit one stack.
  const deep = breakdown($(6789), $(2));
  assert.deepEqual(counts(deep), {purple: 11, black: 2, green: 40, red: 17, white: 4});
  assert.ok(deep.chips.filter(c => c.loose).map(c => c.color).join() === 'purple,black');
  // Tournament chips: $100k blue, $500k red and $1M green, past the $25k orange.
  const t = counts(breakdown($(27_500_000), $(100_000)));
  assert.deepEqual(t, {'green-1m': 27, 'red-500k': 1});
  assert.equal(total(breakdown($(27_500_000), $(100_000))), $(27_500_000));
});

test('small amounts: the biggest chips that pay them, and cents are left over', () => {
  assert.deepEqual(counts(breakdown($(57), $(2))), {green: 2, red: 1, white: 2});
  const b = breakdown(1250, 50);
  assert.deepEqual(counts(b), {red: 2, white: 2});
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
  // $400 at 1/2 is 16 greens: an $11 bet breaks one, two reds and a white
  // go in, and the change (two reds, four whites) stays.
  const s = seatChips($(389), $(11), $(2));
  assert.deepEqual(counts({chips: s.bet}), {red: 2, white: 1});
  assert.deepEqual(counts({chips: s.stack}), {green: 15, red: 2, white: 4});
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
  const row = stacks($(6789), $(2), 5);
  assert.equal(row.length, 5);
  assert.ok(row.every(s => (s.mix ? s.mix.reduce((n, m) => n + m.count, 0) : s.count) <= 20));
  // A deep stack's loose big chips share one stack, the highest on top.
  assert.deepEqual(row[0], {mix: [{color: 'purple', count: 11}, {color: 'black', count: 2}]});
  assert.deepEqual(row.slice(1).map(s => s.color), ['green', 'green', 'red', 'white']);
  assert.match(chipsHtml($(6789), $(2)), /ch-mix/);
  assert.deepEqual(stacks($(10000), $(2), 5).map(s => s.color), ['purple', 'black', 'black', 'green', 'green']);
  assert.deepEqual(stacks($(1047), $(2), 5).map(s => s.color), ['green', 'green', 'red', 'white']);
  assert.match(chipsHtml($(500), $(5)), /ch-green/);
  assert.equal(chipsHtml(0, $(5)), '');
});

test('the chips bet are the chips in the pot: greens stay green', () => {
  // Blinds 1/2, both $400 deep (16 greens each). Seat 0 raises
  // to $50, seat 1 calls, the flop comes.
  const events = [
    {type: 'small_blind', seat: 0, amount: $(1)},
    {type: 'big_blind', seat: 1, amount: $(2)},
    {type: 'raise', seat: 0, to: $(50)},
    {type: 'call', seat: 1, amount: $(48)},
  ];
  const before = handChips([{stack: $(350), street_bet: $(50)}, {stack: $(350), street_bet: $(50)}], events, $(2));
  // The raise is a green, four reds and the white blind plus four more.
  assert.deepEqual(counts({chips: before.bets[0]}), {green: 1, red: 4, white: 5});
  assert.equal(total({chips: before.stacks[0], rest: 0}), $(350));
  const flop = [...events, {type: 'board', street: 'flop', cards: ['2c', '7d', '9h']}];
  const after = handChips([{stack: $(350), street_bet: 0}, {stack: $(350), street_bet: 0}], flop, $(2));
  // Both greens are in the pot, not coloured up into a black.
  assert.equal(counts({chips: after.pot}).green, 2);
  assert.equal(counts({chips: after.pot}).black, undefined);
  assert.equal(total({chips: after.pot, rest: 0}), $(100));
  assert.deepEqual(after.bets, [[], []]);
  // And amounts that don't add up give no chips (the page then draws from
  // amounts).
  assert.equal(handChips([{stack: $(350), street_bet: $(40)}, {stack: $(350), street_bet: $(50)}], events, $(2)), null);
});
