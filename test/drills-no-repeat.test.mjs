import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dealNotAgain, handKind } from '../src/trainer.js';
import { readFileSync } from 'node:fs';
import { DEFAULT_BB, chartFile, pickCell } from '../src/chart-skills.js';

test('the same hand in other suits is the same hand; suited and offsuit differ', () => {
  assert.equal(handKind(['As', 'Ks']), handKind(['Kh', 'Ah']));
  assert.notEqual(handKind(['As', 'Ks']), handKind(['As', 'Kd']));
  assert.equal(handKind(['7c', '7d']), handKind(['7h', '7s']));
  assert.equal(handKind(['Ah', 'Kh', 'Qd', '2c']), handKind(['As', 'Ks', 'Qc', '2d']));
});

test('a drill never deals the hand just played again, even in other suits', () => {
  // A deal that would repeat AK suited twice, then give something else.
  const queue = [['Ah', 'Kh'], ['Ad', 'Kd'], ['Qs', 'Js']];
  assert.deepEqual(dealNotAgain(() => queue.shift(), ['As', 'Ks']), ['Qs', 'Js']);
  // {cards} results too.
  const q2 = [{cards: ['7c', '7d']}, {cards: ['8c', '8d']}];
  assert.deepEqual(dealNotAgain(() => q2.shift(), ['7h', '7s']).cards, ['8c', '8d']);
  // Nothing to avoid: the first deal.
  assert.deepEqual(dealNotAgain(() => ['2c', '3d'], null), ['2c', '3d']);
});

test('chart drills never pick the hand just played', () => {
  const spot = JSON.parse(readFileSync(new URL(`../charts/${chartFile('6max', DEFAULT_BB)}`, import.meta.url), 'utf8')).spots.find(s => s.id === 'open-UTG');
  // The same dice every time would pick the same hand: not twice in a row.
  for (const r of [0, 0.3, 0.7, 0.999]) {
    const rand = () => r;
    for (const probe of [false, true]) {
      const first = pickCell(spot, {rand, probe});
      assert.notEqual(pickCell(spot, {rand, probe, avoid: first}), first);
    }
  }
});
