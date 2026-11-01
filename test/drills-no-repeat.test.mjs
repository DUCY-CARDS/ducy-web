import { test } from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { handKind } from '../src/trainer.js';
import { training } from '../wasm/ducy_wasm.js';
import { readFileSync } from 'node:fs';
import { DEFAULT_BB, chartFile, pickCell } from '../src/chart-skills.js';

test('the same hand in other suits is the same hand; suited and offsuit differ', () => {
  assert.equal(handKind(['As', 'Ks']), handKind(['Kh', 'Ah']));
  assert.notEqual(handKind(['As', 'Ks']), handKind(['As', 'Kd']));
  assert.equal(handKind(['7c', '7d']), handKind(['7h', '7s']));
  assert.equal(handKind(['Ah', 'Kh', 'Qd', '2c']), handKind(['As', 'Ks', 'Qc', '2d']));
});

test('a drill never deals the hand just played again, even in other suits', () => {
  for (const cards of [2, 4]) {
    for (let seed = 0; seed < 100; seed++) {
      // The same dice would deal the same hand first: it's dealt again.
      const prev = training({op: 'dealTop', cards, seed});
      assert.notEqual(handKind(training({op: 'dealTop', cards, seed, prev})), handKind(prev));
      // Nothing to avoid: the first deal.
      assert.deepEqual(training({op: 'dealTop', cards, seed, prev: null}), prev);
    }
  }
  // A practice deal too.
  let pr = {cards: 2, pct: 20, score: 0, history: [], tagStats: {}, current: null};
  for (let seed = 0; seed < 50; seed++) {
    const next = training({op: 'practiceNext', pr, seed});
    if (pr.current) assert.notEqual(handKind(next.cards), handKind(pr.current.cards));
    pr = {...pr, current: next};
  }
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
