// The heads-up ladder's rules and record (#212).
// Run with: node --test test/ladder.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLINDS, CHAMPION, HANDS_PER_LEVEL, ORDER, blindsAt, finishGame, forfeitUnfinished, loadProgress, newProgress,
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

test('a game left unfinished counts as lost', () => {
  const p = newProgress();
  assert.equal(forfeitUnfinished(p, RUNGS), null);
  const r = forfeitUnfinished(startGame(p), RUNGS);
  assert.deepEqual([r.outcome, r.progress.losses, r.progress.playing], ['game', 1, false]);
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

test('the blinds go up every level, then stay', () => {
  assert.deepEqual(blindsAt(0), BLINDS[0]);
  assert.deepEqual(blindsAt(HANDS_PER_LEVEL - 1), BLINDS[0]);
  assert.deepEqual(blindsAt(HANDS_PER_LEVEL), BLINDS[1]);
  assert.deepEqual(blindsAt(10_000), BLINDS.at(-1));
  for (let i = 1; i < BLINDS.length; i++) assert.ok(BLINDS[i][1] > BLINDS[i - 1][1] && BLINDS[i][0] * 2 === BLINDS[i][1]);
});
