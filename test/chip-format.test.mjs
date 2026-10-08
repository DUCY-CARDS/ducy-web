// Cash-game chips are kept in hundredths and shown divided by 100
// (chip-format.js); tournament chips are shown whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chipText, chipInput, parseChips } from '../src/chip-format.js';

test('amounts are shown divided by 100, with cents only when there are any', () => {
  assert.equal(chipText(20000), '200');
  assert.equal(chipText(25), '0.25');
  assert.equal(chipText(1250), '12.50');
  assert.equal(chipText(-50), '-0.50');
  assert.equal(chipText(0), '0');
  assert.equal(chipText(undefined), '0');
  assert.equal(chipText(123456700), (1234567).toLocaleString());
});

test('tournament chips are whole', () => {
  assert.equal(chipText(1500, {whole: true}), (1500).toLocaleString());
});

test('typed amounts are read into hundredths', () => {
  assert.equal(parseChips('12'), 1200);
  assert.equal(parseChips('12.5'), 1250);
  assert.equal(parseChips('0.25'), 25);
  assert.equal(parseChips('.5'), 50);
  assert.equal(parseChips(' 1,000 '), 100000);
  assert.equal(parseChips('0.1'), 10, 'no floating-point drift');
  assert.equal(parseChips('1.005'), NaN, 'at most two decimals');
  for (const bad of ['', 'abc', '-1', '1e3', '1.2.3']) assert.ok(Number.isNaN(parseChips(bad)), bad);
});

test('an input value round-trips', () => {
  for (const n of [1, 25, 1250, 20000, 99999]) assert.equal(parseChips(chipInput(n)), n);
});
