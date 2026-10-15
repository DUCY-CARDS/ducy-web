// A ladder game's review: its costliest decisions (#284).
// Run with: node --test test/ladder-review.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { LESSONS_KEPT, addHand, lessonsByHand, lessonsShare, newGameReview } from '../src/ladder-review.js';
import { STAKES_EVERY, answerStakes, blindsAt, buyInAt, finishGame, keepGame, loadProgress, newProgress, saveProgress, startGame, tableChipsAt } from '../src/ladder.js';

const RUNGS = ['a', 'b', 'c'];

const dec = (grade, bbLost, action = 'call 3bb') => ({street: 'flop', board: 'Ks 9d 4h', pot: 6, to_call: 3, action, gto: [], main: 'fold', best: 'fold', bb_lost: bbLost, stderr: 0, grade});
const hand = (...decisions) => ({hole: 'Ah Kd', board: 'Ks 9d 4h 2c 7s', decisions, bb_lost: decisions.reduce((a, d) => a + d.bb_lost, 0), result: -12.5, note: null});

test('a game review adds up every hand and keeps what cost something', () => {
  let g = addHand(null, hand(dec('fine', 0), dec('mistake', 1.5)), 1);
  g = addHand(g, hand(dec('fine', 0)), 2);
  g = addHand(g, hand(dec('blunder', 6), dec('deviation', 0, 'raise to 25bb')), 3);
  assert.equal(g.totals.hands, 3);
  assert.equal(g.totals.decisions, 5);
  assert.equal(g.totals.bbLost, 7.5);
  assert.equal(g.totals.blunders, 1);
  // Costliest first; the off-strategy play (not valued) after them.
  assert.deepEqual(g.lessons.map(x => [x.hand, x.d.grade]), [[3, 'blunder'], [1, 'mistake'], [3, 'deviation']]);
  assert.equal(g.lessons[0].hole, 'Ah Kd');
  assert.equal(g.lessons[0].result, -12.5);
  assert.deepEqual(lessonsShare(g), {all: 7.5, shown: 7.5});
});

test('only the costliest few are kept, the earlier hand first on a tie', () => {
  let g = newGameReview();
  // Odd hands cost 0.5 bb, even ones 0.3 bb a hand number: 0.6, 1.2, ...
  for (let i = 1; i <= 8; i++) g = addHand(g, hand(dec('inaccuracy', i % 2 ? 0.5 : 0.3 * i)), i);
  assert.equal(g.lessons.length, LESSONS_KEPT);
  assert.deepEqual(g.lessons.map(x => x.hand), [8, 6, 4, 2, 1]);
  const {all, shown} = lessonsShare(g);
  assert.ok(shown < all);
});

test('lessons are shown by hand, costliest hand first, in the order played', () => {
  let g = addHand(null, hand(dec('mistake', 2, 'call 2bb'), dec('fine', 0), dec('blunder', 5, 'call 9bb')), 1);
  g = addHand(g, hand(dec('blunder', 4)), 2);
  const byHand = lessonsByHand(g.lessons);
  assert.deepEqual(byHand.map(h => h.hand), [1, 2]);
  assert.deepEqual(byHand[0].items.map(x => [x.d.action, x.i, x.at]), [['call 2bb', 2, 0], ['call 9bb', 0, 2]]);
});

test('a hand with nothing to learn from adds to the totals only', () => {
  const g = addHand(newGameReview(), hand(dec('fine', 0)), 1);
  assert.equal(g.totals.hands, 1);
  assert.deepEqual(g.lessons, []);
  assert.deepEqual(lessonsShare(g), {all: 0, shown: 0});
});

test('a game in progress keeps its review as the chips change', () => {
  const p = startGame(newProgress(), RUNGS);
  const review = addHand(null, hand(dec('mistake', 2)), 1);
  const q = keepGame({...p, game: {...p.game, review}}, 300, 4);
  assert.deepEqual(q.game.review, review);
  assert.equal(q.game.hands, 4);
});

for (const level of [0, 2]) test(`a review survives raised stakes and a paused game resuming on rung ${level + 1}`, () => {
  const p = startGame({...newProgress(), level, chips: 2 * buyInAt(level)}, RUNGS);
  const review = addHand(null, hand(dec('mistake', 2)), 1);
  const q = answerStakes(keepGame({...p, game: {...p.game, review}}, 30000, STAKES_EVERY), true);
  const storage = {getItem() { return this.value; }, setItem(key, value) { this.value = value; }};
  saveProgress(keepGame(q, 28000, STAKES_EVERY + 1), storage);
  const resumed = startGame(loadProgress(storage), RUNGS);
  assert.deepEqual(resumed.game.review, review);
  assert.deepEqual(resumed.game.blinds, blindsAt(level).map(n => n * 2));
  assert.equal(resumed.game.offerAt, STAKES_EVERY * 2);
  assert.equal(resumed.game.hands, STAKES_EVERY + 1);
  assert.deepEqual(resumed.game.stacks, [28000, tableChipsAt(level) - 28000]);
  const lastReview = {at: 1, opp: RUNGS[level], won: true, hands: resumed.game.hands, ...review};
  const finished = {...finishGame(resumed, RUNGS, true).progress, lastReview};
  assert.equal(finished.chips, p.chips + buyInAt(level));
  assert.equal(finished.game, null);
  saveProgress(finished, storage);
  assert.deepEqual(loadProgress(storage).lastReview, lastReview);
});
