// The heads-up ladder's rules and record (#212).
// Run with: node --test test/ladder.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLINDS, CHAMPION, ORDER, STAKES_EVERY, START_BB, TOTAL_CHIPS, answerStakes, finishGame, gameBlinds,
  keepGame, loadProgress, newProgress, pausedGame, opponentOf, rungsFor, saveProgress, stakesOffer, startGame,
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
  assert.deepEqual(p.game, {stacks: [TOTAL_CHIPS / 2, TOTAL_CHIPS / 2], hands: 0, blinds: BLINDS, offerAt: STAKES_EVERY});
  // Twelve hands in, you have 26,500 behind (mid-hand: your bet in the pot is theirs).
  p = keepGame(p, 26500, 12);
  assert.deepEqual(pausedGame(p), {stacks: [26500, TOTAL_CHIPS - 26500], hands: 12, blinds: BLINDS, offerAt: STAKES_EVERY});
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

test('every 100 hands the bot offers to double the blinds', () => {
  let p = startGame(newProgress());
  assert.equal(stakesOffer(p), null);
  p = keepGame(p, 41000, STAKES_EVERY - 1);
  assert.equal(stakesOffer(p), null);
  p = keepGame(p, 41000, STAKES_EVERY);
  assert.deepEqual(stakesOffer(p), [200, 400]);
  // Accepted: double from the next hand, and the next offer 100 hands on.
  p = answerStakes(p, true);
  assert.deepEqual(gameBlinds(p), [200, 400]);
  assert.equal(stakesOffer(p), null);
  p = keepGame(p, 30000, 2 * STAKES_EVERY);
  assert.deepEqual(stakesOffer(p), [400, 800]);
  // Turned down: the blinds stay, and it comes again 100 hands later.
  p = answerStakes(p, false);
  assert.deepEqual(gameBlinds(p), [200, 400]);
  assert.equal(stakesOffer(keepGame(p, 30000, 2 * STAKES_EVERY + 50)), null);
  assert.deepEqual(stakesOffer(keepGame(p, 30000, 3 * STAKES_EVERY)), [400, 800]);
  // The raised blinds are kept with the paused game.
  assert.deepEqual(startGame({...p, playing: false}).game.blinds, [200, 400]);
});

test('no offer when someone can’t cover the doubled big blind', () => {
  const p = keepGame(startGame(newProgress()), 350, STAKES_EVERY);
  assert.equal(stakesOffer(p), null);
});

test('a game kept before the stakes could rise goes on at 1/2', () => {
  const p = startGame({...newProgress(), playing: true, game: {stacks: [53000, 27000], hands: 40}});
  assert.deepEqual(gameBlinds(p), BLINDS);
  assert.equal(p.game.offerAt, STAKES_EVERY);
});

test('games start 200 BB deep at 1/2', () => {
  assert.deepEqual(BLINDS, [100, 200]);
  assert.equal(START_BB, 200);
  assert.equal(TOTAL_CHIPS, 2 * 200 * BLINDS[1]);
});

test('a game paused at 100 BB goes on at 200 BB with the same share', () => {
  const store = new Map();
  const storage = {getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v)};
  // 100 BB each was 40,000 chips in all; you had 26,500 of them.
  store.set('ducyLadder', JSON.stringify({...newProgress(), playing: true, wins: 1, game: {stacks: [26500, 13500], hands: 12}}));
  const p = loadProgress(storage);
  assert.deepEqual(pausedGame(p), {stacks: [53000, 27000], hands: 12});
  assert.equal(p.wins, 1);
  // A game saved at this depth is kept as it is.
  const q = keepGame(startGame(newProgress()), 31000, 5);
  saveProgress(q, storage);
  assert.deepEqual(loadProgress(storage), q);
});
