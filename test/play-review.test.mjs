// Totals and labels for GTO hand reviews, on a real review from ducy-wasm's
// BotTable.reviewLastHand() (test/fixtures/review.json).
// Run with: node --test test/play-review.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  emptyTotals, addReview, addTotals, per100, bbText, mixText, mixCost, worstIndex, isVariant, FLAGGED, GRADE_LABEL,
} from '../src/play-review.js';

const review = JSON.parse(readFileSync(new URL('./fixtures/review.json', import.meta.url)));

test('the fixture has the shape the panel reads', () => {
  for (const k of ['hole', 'board', 'decisions', 'bb_lost', 'worst', 'result', 'note']) assert.ok(k in review, k);
  for (const d of review.decisions) {
    for (const k of ['street', 'board', 'pot', 'to_call', 'action', 'gto', 'frequency', 'main', 'best', 'ev', 'ev_loss', 'bb_lost', 'stderr', 'grade', 'note']) {
      assert.ok(k in d, k);
    }
    assert.ok(d.grade in GRADE_LABEL, d.grade);
  }
});

test('a review adds its decisions, grades and bb lost', () => {
  const t = addReview(emptyTotals(), review);
  assert.equal(t.hands, 1);
  assert.equal(t.decisions, review.decisions.length);
  const sum = review.decisions.reduce((a, d) => a + d.bb_lost, 0);
  assert.ok(Math.abs(t.bbLost - sum) < 1e-9);
  assert.ok(Math.abs(t.bbLost - review.bb_lost) < 1e-9);
  const graded = t.fine + t.inaccuracies + t.mistakes + t.blunders + t.deviations + t.unknown;
  assert.equal(graded, t.decisions);
  assert.equal(t.mistakes, review.decisions.filter(d => d.grade === 'mistake').length);
  assert.equal(t.deviations, review.decisions.filter(d => d.grade === 'deviation').length);
  assert.equal(t.variants, review.decisions.filter(isVariant).length);
  assert.ok(t.variants > 0, 'the fixture has a less common mixed play');
});

test('totals add up across hands and sessions', () => {
  const a = addReview(addReview(emptyTotals(), review), review);
  const b = addReview(emptyTotals(), review);
  const all = addTotals(addTotals(emptyTotals(), a), b);
  assert.equal(all.hands, 3);
  assert.equal(all.decisions, 3 * review.decisions.length);
  assert.ok(Math.abs(all.bbLost - 3 * review.bb_lost) < 1e-9);
  assert.ok(Math.abs(per100(all) - 100 * review.bb_lost) < 1e-6);
  assert.equal(per100(emptyTotals()), null);
});

test('a review with no decisions still counts the hand', () => {
  const t = addReview(emptyTotals(), {decisions: [], bb_lost: 0});
  assert.equal(t.hands, 1);
  assert.equal(t.decisions, 0);
});

test('the worst decision is the costliest', () => {
  const i = worstIndex(review);
  assert.equal(i, review.worst);
  assert.equal(worstIndex({decisions: [{bb_lost: 0}]}), -1);
});

test('mixes read most frequent first and skip rare plays', () => {
  const mix = mixText([
    {action: 'check', frequency: 0.3},
    {action: 'bet 75% pot', frequency: 0.695},
    {action: 'all-in', frequency: 0.005},
  ]);
  assert.equal(mix, 'bet 75% pot 70% · check 30%');
  assert.equal(mixText([]), '');
});

test('bb amounts read cleanly', () => {
  assert.equal(bbText(0), '0');
  assert.equal(bbText(0.04), '0.04');
  assert.equal(bbText(1.76), '1.8');
  assert.equal(bbText(12), '12');
  assert.equal(bbText(-2.45), '-2.5');
});

test('flagged grades are the ones worth pointing out', () => {
  assert.deepEqual(FLAGGED, ['blunder', 'mistake', 'inaccuracy', 'deviation']);
  assert.ok(!FLAGGED.includes('fine'));
});

test('an uncharged mixed play still shows what it gave up against the best play', () => {
  const d = {grade: 'fine', bb_lost: 0, action: 'call', best: 'raise to 9bb', ev_loss: 0.6, stderr: 0.05};
  assert.deepEqual(mixCost(d), {loss: 0.6, best: 'raise to 9bb', close: false});
  // Within the estimate's error: about as good.
  assert.equal(mixCost({...d, ev_loss: 0.08}).close, true);
  // Not for the best play, a charged one, an unvalued one, or a worse grade.
  assert.equal(mixCost({...d, best: 'call'}), null);
  assert.equal(mixCost({...d, bb_lost: 0.6}), null);
  assert.equal(mixCost({...d, ev_loss: null}), null);
  assert.equal(mixCost({...d, ev_loss: 0}), null);
  assert.equal(mixCost({...d, grade: 'mistake'}), null);
  // Every one the fixture has is a fine, uncharged play worth less than its best.
  for (const r of review.decisions) {
    const c = mixCost(r);
    if (c) assert.ok(r.grade === 'fine' && r.bb_lost === 0 && r.ev_loss > 0 && r.best !== r.action);
  }
});

test('totals add up what mixed plays gave up, apart from bb lost', () => {
  const mixed = {grade: 'fine', bb_lost: 0, action: 'call', best: 'raise to 9bb', ev_loss: 0.6, stderr: 0.05, note: 'a less common choice: …'};
  const close = {...mixed, ev_loss: 0.05};
  const t = addReview(emptyTotals(), {decisions: [mixed, close, {...mixed, grade: 'mistake', bb_lost: 1.2, ev_loss: 1.2}]});
  assert.ok(Math.abs(t.mixLoss - 0.6) < 1e-9, 'only the uncharged one, outside the error');
  assert.ok(Math.abs(t.bbLost - 1.2) < 1e-9);
  const both = addTotals(addTotals(emptyTotals(), t), t);
  assert.ok(Math.abs(both.mixLoss - 1.2) < 1e-9);
});
