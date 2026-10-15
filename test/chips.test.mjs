import test from 'node:test';
import assert from 'node:assert/strict';
import { breakdown, chipsHtml, stacks } from '../src/chips.js';

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

test('the smallest chip keeps two stacks; bigger chips colour up past five', () => {
  assert.deepEqual(counts(breakdown($(400), $(2))), {red: 72, white: 40});
  const deep = counts(breakdown($(10000), $(2)));
  assert.equal(deep.white, 40);
  assert.ok(deep.red <= 100 && deep.green <= 100, JSON.stringify(deep));
  assert.ok(deep.black > 0);
});

test('small amounts stay in small chips, and cents are left over', () => {
  assert.deepEqual(counts(breakdown($(57), $(2))), {red: 4, white: 37});
  const b = breakdown(1250, 50);
  assert.deepEqual(counts(b), {white: 12});
  assert.equal(b.rest, 50);
  // Under the smallest chip in play: no chips at all.
  assert.deepEqual(breakdown($(3), $(5)).chips, []);
});

test('at most `max` stacks of up to 20, biggest chips first', () => {
  const row = stacks($(10000), $(2), 5);
  assert.equal(row.length, 5);
  assert.ok(row.every(s => s.count >= 1 && s.count <= 20));
  assert.equal(row[0].color, 'black');
  assert.match(chipsHtml($(500), $(5)), /ch-green/);
  assert.equal(chipsHtml(0, $(5)), '');
});
