// Pre-flop charts (charts.js): the grid's hands, and the chart data files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cellHand, sizedVerbs, facingText } from '../src/charts.js';

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
    // At 5 BB nearly every open is all-in, so nobody faces a 3-bet: the
    // opens, the replies to them and the limped pot only.
    assert.ok(d.spots.length >= (bb <= 5 ? 20 : 30), `${bb} BB has its spots`);
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

test('heads-up charts say how much Ducybot raises, and what he faces', () => {
  const index = read('index.json');
  for (const bb of index.ducybotHu) {
    const d = read(`ducybot-hu-${bb}.json`);
    const open = d.spots.find(s => s.id === 'hu-open-BTN');
    assert.ok(open.sizes.length >= 1 || bb <= 10, `heads-up ${bb} BB: the open has a size`);
    for (const s of d.spots) {
      assert.ok(Array.isArray(s.sizes), s.id);
      for (const z of s.sizes) assert.ok(z.to > 1 && z.to < bb, `${s.id}: raise to ${z.to}`);
      if (s.kind === 'vs-open' || s.kind === 'vs-3bet') assert.ok(s.facing > 1, `${s.id} faces a raise`);
    }
  }
  const verbs = ['Fold', 'Call', '3-bet', 'All-in'];
  assert.deepEqual(sizedVerbs({sizes: [{to: 7.5, pct: 14}]}, verbs), ['Fold', 'Call', '3-bet to 7.5 BB', 'All-in']);
  assert.equal(sizedVerbs({sizes: [{to: 7.5}, {to: 10}]}, verbs)[2], '3-bet to 7.5 or 10 BB');
  assert.deepEqual(sizedVerbs({}, verbs), verbs);
  assert.equal(facingText({facing: 2.5}), ' to 2.5 BB');
  assert.equal(facingText({facing: null}), '');
});
