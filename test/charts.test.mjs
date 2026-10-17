// Pre-flop charts (charts.js): the grid's hands, and the chart data files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cellHand } from '../src/charts.js';

const read = name => JSON.parse(readFileSync(new URL(`../charts/${name}`, import.meta.url), 'utf8'));

test('the grid: aces first, pairs on the diagonal, suited above, offsuit below', () => {
  assert.equal(cellHand(0), 'AA');
  assert.equal(cellHand(1), 'AKs');
  assert.equal(cellHand(12), 'A2s');
  assert.equal(cellHand(13), 'AKo');
  assert.equal(cellHand(14), 'KK');
  assert.equal(cellHand(156), 'A2o');
  assert.equal(cellHand(168), '22');
  const all = new Set(Array.from({length: 169}, (_, i) => cellHand(i)));
  assert.equal(all.size, 169);
});

test('every listed chart file has whole spots: 169 cells, each mix adding up', () => {
  const index = read('index.json');
  for (const bb of index.ducybot) {
    const d = read(`ducybot-${bb}.json`);
    assert.equal(d.bb, bb);
    assert.ok(d.spots.length >= 30, `${bb} BB has its spots`);
    for (const s of d.spots) {
      assert.equal(s.cells.length, 169, s.id);
      for (const c of s.cells) assert.ok(Math.abs(c.reduce((a, b) => a + b, 0) - 100) <= 3, `${s.id}: ${c}`);
      assert.ok(Math.abs(s.overall.reduce((a, b) => a + b, 0) - 100) < 0.5, s.id);
    }
    // GTO never folds aces first in.
    const utg = d.spots.find(s => s.id === 'open-UTG');
    assert.ok(utg.cells[0][0] <= 1, `${bb} BB: UTG folds AA ${utg.cells[0][0]}%`);
  }
  for (const bb of index.ducybotHu || []) {
    const d = read(`ducybot-hu-${bb}.json`);
    assert.equal(d.bb, bb);
    assert.equal(d.format, 'hu');
    assert.ok(d.spots.length >= 5, `heads-up ${bb} BB has its spots`);
    for (const s of d.spots) {
      assert.equal(s.cells.length, 169, s.id);
      for (const c of s.cells) assert.ok(Math.abs(c.reduce((a, b) => a + b, 0) - 100) <= 3, `${s.id}: ${c}`);
    }
    // The button never folds aces.
    const btn = d.spots.find(s => s.id === 'hu-open-BTN');
    assert.ok(btn.cells[0][0] <= 1, `heads-up ${bb} BB: the button folds AA ${btn.cells[0][0]}%`);
  }
  for (const bb of index.regulars) {
    const d = read(`regulars-${bb}.json`);
    assert.ok(d.bots.length >= 10);
    for (const b of d.bots) for (const s of b.spots) assert.equal(s.cells.length, 169, `${b.id} ${s.id}`);
  }
});
