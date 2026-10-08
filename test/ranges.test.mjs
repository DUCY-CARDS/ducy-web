// Range text as the equity calculator and trainer read it: ducy's notation
// (holdemRangeReport) plus the page's "top N%". Needs the wasm build in wasm/.
// Run with: node --test test/ranges.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { parseRange, rangeErrors, comboCount, topRange } from '../src/ranges.js';
import { RANGE_PRESETS } from '../src/presets.js';

const sorted = s => [...s].sort();

test('pairs, plus, dash and both suits', () => {
  assert.deepEqual(sorted(parseRange('QQ+, A5s-A3s, KQ')),
    sorted(['AA', 'KK', 'QQ', 'A5s', 'A4s', 'A3s', 'KQs', 'KQo']));
  assert.deepEqual(sorted(parseRange('88-JJ')), sorted(['JJ', 'TT', '99', '88']));
  assert.equal(comboCount(parseRange('AKs, AKo, 22')), 4 + 12 + 6);
});

test('"top N%" is the page\'s ranking, added to the rest', () => {
  const top = topRange(10);
  const sel = parseRange('top 10%, 22');
  for (const c of top) assert.ok(sel.has(c), c);
  assert.ok(sel.has('22'));
});

test('a bad term is skipped and named; the rest still reads', () => {
  assert.deepEqual(sorted(parseRange('AK, junk, 22')), sorted(['AKs', 'AKo', '22']));
  const errors = rangeErrors('AK, junk, 22');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /junk/);
  assert.deepEqual(rangeErrors('QQ+'), []);
  assert.equal(parseRange('').size, 0);
});

test('every preset reads cleanly', () => {
  for (const p of RANGE_PRESETS) {
    for (const t of [p.value, p.bluff].filter(Boolean)) {
      assert.deepEqual(rangeErrors(t), [], `${p.id}: ${t}`);
      assert.ok(parseRange(t).size > 0, p.id);
    }
  }
});
