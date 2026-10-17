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

test('up to $100 at 1/2 is all reds, the favored chip, and whites only for odd dollars', () => {
  for (const d of [40, 100]) assert.deepEqual(counts(breakdown($(d), $(2))), {red: d / 5}, `$${d}`);
  assert.deepEqual(counts(breakdown($(57), $(2))), {red: 11, white: 2});
});

test('one stack of reds at most, as full as the greens allow; greens for the rest', () => {
  assert.deepEqual(counts(breakdown($(250), $(2))), {green: 6, red: 20});
  assert.deepEqual(counts(breakdown($(389), $(2))), {green: 12, red: 17, white: 4});
  assert.deepEqual(counts(breakdown($(484), $(2))), {green: 16, red: 16, white: 4});
  assert.deepEqual(counts(breakdown($(750), $(2))), {green: 26, red: 20});
  assert.deepEqual(counts(breakdown($(1047), $(2))), {green: 38, red: 19, white: 2});
  assert.deepEqual(counts(breakdown($(2000), $(2))), {green: 76, red: 20});
});

test('when the greens can’t fit, blacks come in, then bigger chips', () => {
  assert.deepEqual(counts(breakdown($(2047), $(2))), {black: 10, green: 38, red: 19, white: 2});
  assert.deepEqual(counts(breakdown($(3000), $(2))), {black: 14, green: 60, red: 20});
  assert.deepEqual(counts(breakdown($(5000), $(2))), {black: 39, green: 40, red: 20});
  // A seat always keeps some of the favored chip, and never more than a stack.
  for (const d of [250, 2000, 10000, 12345, 30000, 33333]) {
    const red = counts(breakdown($(d), $(2))).red;
    assert.ok(red >= 15 && red <= 20, `$${d}: ${red} reds`);
  }
});

test('the favored chip at other stakes: red at 2/5, green at 5/10', () => {
  assert.deepEqual(counts(breakdown($(500), $(5))), {green: 16, red: 20});
  assert.deepEqual(counts(breakdown($(1000), $(5))), {green: 36, red: 20});
  assert.deepEqual(counts(breakdown($(1000), $(10))), {black: 5, green: 20});
  // Cents, and amounts under the smallest chip in play, are left over.
  const b = breakdown(1250, 50);
  assert.deepEqual(counts(b), {white: 12});
  assert.equal(b.rest, 50);
  assert.deepEqual(breakdown($(3), $(5)).chips, []);
});

test('a seat shows at most five stacks; one too big for that puts the rest on a mixed stack', () => {
  for (const d of [484, 1047, 2047, 6789, 10000, 33333]) {
    assert.ok(stacks($(d), $(2), 9).length <= 5, `$${d}`);
  }
  // Tournament chips: $100k blue, $500k red and $1M green, past the $25k orange.
  const t = breakdown($(27_500_000), $(100_000));
  assert.equal(total(t), $(27_500_000));
  const huge = breakdown($(900_000_000), $(2));
  assert.equal(total(huge), $(900_000_000));
  assert.ok(huge.chips.some(c => c.loose), 'a mixed stack');
});

test('a bet is paid with the highest-valued chips first', () => {
  assert.deepEqual(counts(pay($(11))), {red: 2, white: 1});
  assert.deepEqual(counts(pay($(137))), {black: 1, green: 1, red: 2, white: 2});
  assert.equal(total(pay(1250)), 1250);
  assert.deepEqual(stacks($(11), $(2), 4, true), [{color: 'red', count: 2}, {color: 'white', count: 1}]);
});

test('a player bets with chips they have, and the stack shows what is left', () => {
  // $400 at 1/2 is 20 reds and 12 greens: an $11 bet breaks a red, two reds
  // and a white go in, and four whites of change stay.
  const s = seatChips($(389), $(11), $(2));
  assert.deepEqual(counts({chips: s.bet}), {red: 2, white: 1});
  assert.deepEqual(counts({chips: s.stack}), {green: 12, red: 17, white: 4});
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
  const row = stacks($(33333), $(2), 5);
  assert.equal(row.length, 5);
  assert.ok(row.every(s => (s.mix ? s.mix.reduce((n, m) => n + m.count, 0) : s.count) <= 20));
  // A deep stack's loose big chips share one stack, the highest on top.
  assert.deepEqual(row[0], {mix: [{color: 'pink', count: 6}, {color: 'yellow', count: 2}, {color: 'black', count: 3}]});
  assert.deepEqual(row.slice(1).map(s => s.color), ['green', 'green', 'red', 'white']);
  assert.match(chipsHtml($(33333), $(2)), /ch-mix/);
  assert.deepEqual(stacks($(10000), $(2), 5).map(s => s.color), ['purple', 'green', 'green', 'green', 'red']);
  assert.deepEqual(stacks($(1047), $(2), 5).map(s => s.color), ['green', 'green', 'red', 'white']);
  assert.match(chipsHtml($(500), $(5)), /ch-red/);
  assert.equal(chipsHtml(0, $(5)), '');
});

test('the chips bet are the chips in the pot: nothing colours up', () => {
  // Blinds 1/2, both $400 deep (20 reds and 12 greens each). Seat 0 raises
  // to $50, seat 1 calls, the flop comes.
  const events = [
    {type: 'small_blind', seat: 0, amount: $(1)},
    {type: 'big_blind', seat: 1, amount: $(2)},
    {type: 'raise', seat: 0, to: $(50)},
    {type: 'call', seat: 1, amount: $(48)},
  ];
  const before = handChips([{stack: $(350), street_bet: $(50)}, {stack: $(350), street_bet: $(50)}], events, $(2));
  // The raise is a green, four reds, and the white blind plus four more.
  assert.deepEqual(counts({chips: before.bets[0]}), {green: 1, red: 4, white: 5});
  assert.equal(total({chips: before.stacks[0], rest: 0}), $(350));
  const flop = [...events, {type: 'board', street: 'flop', cards: ['2c', '7d', '9h']}];
  const after = handChips([{stack: $(350), street_bet: 0}, {stack: $(350), street_bet: 0}], flop, $(2));
  // Both bets are in the pot chip for chip, not coloured up into greens.
  assert.deepEqual(counts({chips: after.pot}), {green: 2, red: 8, white: 10});
  assert.equal(total({chips: after.pot, rest: 0}), $(100));
  assert.deepEqual(after.bets, [[], []]);
  // And amounts that don't add up give no chips (the page then draws from
  // amounts).
  assert.equal(handChips([{stack: $(350), street_bet: $(40)}, {stack: $(350), street_bet: $(50)}], events, $(2)), null);
});
