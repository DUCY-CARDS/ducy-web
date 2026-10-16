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

test('$500 at 2/5: a stack of reds and the rest in green, the preferred chip', () => {
  assert.deepEqual(counts(breakdown($(500), $(5))), {green: 16, red: 20});
});

test('a stack of whites, two of reds (the preferred chip), then bigger chips fill up', () => {
  assert.deepEqual(counts(breakdown($(400), $(2))), {green: 8, red: 36, white: 20});
  // Never all one colour: $484 at 1/2 is whites, reds and greens.
  assert.deepEqual(counts(breakdown($(484), $(2))), {green: 11, red: 38, white: 19});
  // Greens fit in five stacks, so nothing colours up into a purple.
  assert.deepEqual(counts(breakdown($(1047), $(2))), {green: 34, red: 36, white: 17});
  assert.deepEqual(counts(breakdown($(2000), $(2))), {black: 13, green: 20, red: 36, white: 20});
});

test('a deep stack keeps the small chips, the rest on one stack of big ones', () => {
  // Five stacks would not hold it: the rest colours up only as far as it
  // takes to fit one stack.
  assert.deepEqual(counts(breakdown($(5000), $(2))), {black: 3, green: 20, purple: 8, red: 36, white: 20});
  assert.deepEqual(counts(breakdown($(10000), $(2))), {black: 3, green: 20, red: 36, white: 20, yellow: 9});
  // Tournament chips: $100k blue, $500k red and $1M green, past the $25k orange.
  const t = counts(breakdown($(27_500_000), $(100_000)));
  assert.ok(t['green-1m'] > 0 && t.blue > 0, JSON.stringify(t));
  assert.equal(total(breakdown($(27_500_000), $(100_000))), $(27_500_000));
});

test('small amounts stay in small chips, and cents are left over', () => {
  assert.deepEqual(counts(breakdown($(57), $(2))), {red: 8, white: 17});
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
  // $400 at 1/2 is 20 whites, 36 reds and 8 greens: an $11 bet is two reds
  // and a white, from those.
  const s = seatChips($(389), $(11), $(2));
  assert.deepEqual(counts({chips: s.bet}), {red: 2, white: 1});
  assert.deepEqual(counts({chips: s.stack}), {green: 8, red: 34, white: 19});
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
  assert.equal(row.length, 5);
  assert.ok(row.every(s => (s.mix ? s.mix.reduce((n, m) => n + m.count, 0) : s.count) <= 20));
  // A deep stack's loose big chips share one stack, the highest on top.
  assert.deepEqual(row[0], {mix: [{color: 'yellow', count: 9}, {color: 'black', count: 3}]});
  assert.deepEqual(row.slice(1).map(s => s.color), ['green', 'red', 'red', 'white']);
  assert.match(chipsHtml($(10000), $(2)), /ch-mix/);
  assert.deepEqual(stacks($(484), $(2), 5).map(s => s.color), ['green', 'red', 'red', 'white']);
  assert.match(chipsHtml($(500), $(5)), /ch-green/);
  assert.equal(chipsHtml(0, $(5)), '');
});

test('the chips bet are the chips in the pot: greens stay green', () => {
  // Blinds 1/2, both $400 deep (20 white, 36 red, 8 green). Seat 0 raises
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
