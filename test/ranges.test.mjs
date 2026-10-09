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

test('the heads-up GTO presets are the ranges ducy-gto’s preflop_ranges printed', () => {
  // Each range's share of all hands, as the example printed it (range_share).
  const share = {
    'hu-btn-open': 0.4766, 'hu-btn-limp': 0.4600, 'hu-bb-defend': 0.5566 + 0.0965, 'hu-bb-call': 0.5566,
    'hu-bb-3bet': 0.0965, 'hu-btn-4bet': 0.0302, 'hu-btn-call-3bet': 0.3786, 'hu-bb-5bet': 0.0573,
    'hu-bb-call-4bet': 0.1373, 'hu-bb-iso': 0.2941, 'hu-btn-3bet-iso': 0.0618, 'hu-btn-call-iso': 0.6486,
  };
  const hu = Object.fromEntries(RANGE_PRESETS.filter(p => p.spot === 'hu').map(p => [p.id, parseRange(p.value)]));
  assert.deepEqual(Object.keys(hu).sort(), Object.keys(share).sort());
  for (const [id, want] of Object.entries(share)) {
    assert.ok(Math.abs(comboCount(hu[id]) / 1326 - want) < 0.0006, `${id}: ${(comboCount(hu[id]) / 1326).toFixed(4)} vs ${want}`);
  }
  // Each spot's actions split the hands: no hand in two of them.
  const apart = (...ids) => {
    const seen = new Set();
    for (const id of ids) for (const c of hu[id]) { assert.ok(!seen.has(c), `${c} in two of ${ids}`); seen.add(c); }
  };
  apart('hu-btn-open', 'hu-btn-limp');
  apart('hu-bb-call', 'hu-bb-3bet');
  apart('hu-btn-4bet', 'hu-btn-call-3bet');
  apart('hu-bb-5bet', 'hu-bb-call-4bet');
  apart('hu-btn-3bet-iso', 'hu-btn-call-iso');
  assert.deepEqual(sorted(hu['hu-bb-defend']), sorted(new Set([...hu['hu-bb-call'], ...hu['hu-bb-3bet']])));
});

test('every preset reads cleanly', () => {
  for (const p of RANGE_PRESETS) {
    for (const t of [p.value, p.bluff].filter(Boolean)) {
      assert.deepEqual(rangeErrors(t), [], `${p.id}: ${t}`);
      assert.ok(parseRange(t).size > 0, p.id);
    }
  }
});
