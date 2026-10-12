// The heads-up ladder's rules and record (#212).
// Run with: node --test test/ladder.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLINDS, CHAMPION, ORDER, TOTAL_CHIPS, finishGame, keepGame, loadProgress, newProgress, pausedGame,
  opponentOf, rungsFor, saveProgress, startGame,
} from '../src/ladder.js';

const RUNGS = ['a', 'b', 'c'];

// Plays a series: true is a game won.
function series(p, games) {
  let out = null;
  for (const won of games) ({progress: p, outcome: out} = finishGame(startGame(p), RUNGS, won));
  return {p, out};
}

test('the ladder runs from the easiest ranked bot to the GTO bot', () => {
  assert.ok(ORDER.length >= 19, 'every personality is ranked');
  assert.equal(new Set(ORDER).size, ORDER.length);
  assert.ok(!ORDER.includes(CHAMPION));
  const rungs = rungsFor([...ORDER].reverse(), true);
  assert.deepEqual(rungs, [...ORDER, CHAMPION]);
  // No GTO bot here: the hardest personality is the top.
  assert.deepEqual(rungsFor(ORDER, false), ORDER);
  // A bot that isn't ranked yet goes just under the GTO bot.
  assert.deepEqual(rungsFor([ORDER[1], 'newbot', ORDER[0]], true), [ORDER[0], ORDER[1], 'newbot', CHAMPION]);
});

test('two wins take the series and move you up a rung', () => {
  let p = newProgress();
  assert.equal(opponentOf(p, RUNGS), 'a');
  let r = finishGame(startGame(p), RUNGS, true);
  assert.equal(r.outcome, 'game');
  assert.deepEqual([r.progress.wins, r.progress.losses, r.progress.playing], [1, 0, false]);
  r = finishGame(startGame(r.progress), RUNGS, true);
  assert.equal(r.outcome, 'up');
  p = r.progress;
  assert.deepEqual([p.level, p.best, p.wins, p.losses], [1, 1, 0, 0]);
  assert.deepEqual(p.record.a, {won: 1, lost: 0});
  assert.equal(opponentOf(p, RUNGS), 'b');
});

test('losing a series drops one rung, but not below the first', () => {
  let {p, out} = series(newProgress(), [false, true, false]);
  assert.equal(out, 'stay');
  assert.equal(p.level, 0);
  assert.deepEqual(p.record.a, {won: 0, lost: 1});
  ({p} = series(p, [true, true]));
  ({p} = series(p, [true, false, true]));
  assert.equal(p.level, 2);
  ({p, out} = series(p, [false, false]));
  assert.equal(out, 'down');
  assert.equal(p.level, 1);
  assert.equal(p.best, 2, 'your best rung stays');
});

test('beating the top bot makes you champion, and you stay up there', () => {
  let p = {...newProgress(), level: 2, best: 2};
  let out;
  ({p, out} = series(p, [true, true]));
  assert.equal(out, 'champion');
  assert.deepEqual([p.level, p.titles], [2, 1]);
  ({p, out} = series(p, [true, false, true]));
  assert.deepEqual([out, p.titles], ['champion', 2]);
});

test('a game left in the middle resumes with the same chips', () => {
  let p = newProgress();
  assert.equal(pausedGame(p), null);
  p = startGame(p);
  assert.deepEqual(p.game, {stacks: [TOTAL_CHIPS / 2, TOTAL_CHIPS / 2], hands: 0});
  // Twelve hands in, you have 26,500 behind (mid-hand: your bet in the pot is theirs).
  p = keepGame(p, 26500, 12);
  assert.deepEqual(pausedGame(p), {stacks: [26500, TOTAL_CHIPS - 26500], hands: 12});
  // Coming back keeps the game, not a fresh one.
  assert.deepEqual(startGame(p).game, p.game);
  assert.equal(p.losses, 0, 'leaving isn’t losing');
  // Finishing the game clears it.
  const r = finishGame(p, RUNGS, true);
  assert.equal(r.progress.game, null);
  assert.equal(pausedGame(r.progress), null);
  assert.deepEqual(startGame(r.progress).game.stacks, [TOTAL_CHIPS / 2, TOTAL_CHIPS / 2]);
});

test('a shorter ladder keeps you on it', () => {
  const p = {...newProgress(), level: 9};
  assert.equal(opponentOf(p, RUNGS), 'c');
  const {progress} = finishGame(startGame(p), RUNGS, false);
  assert.equal(progress.losses, 1);
  assert.equal(progress.level, 2);
});

test('progress is kept, and bad saves start over', () => {
  const store = new Map();
  const storage = {getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v)};
  const {p} = series(newProgress(), [true, true]);
  saveProgress(p, storage);
  assert.deepEqual(loadProgress(storage), p);
  store.set('ducyLadder', '{oops');
  assert.deepEqual(loadProgress(storage), newProgress());
  const broken = {getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }};
  assert.deepEqual(loadProgress(broken), newProgress());
  saveProgress(p, broken);
});

test('every game plays at the same blinds, 1/2', () => {
  assert.deepEqual(BLINDS, [100, 200]);
});
