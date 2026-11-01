// The heads-up ladder's rules and record (#212).
// Run with: node --test test/ladder.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import {
  BLINDS, CHAMPION, ORDER, STAKES_EVERY, START_BB, START_CHIPS, answerStakes, blindsAt, buyInAt,
  chipsNow, dropTo, finishGame, gameBlinds, keepGame, loadProgress, newProgress, opponentOf,
  pausedGame, rungShown, rungsFor, saveProgress, stakesOffer, startGame, tableChipsAt,
} from '../src/ladder.js';

import { botGames } from '../wasm/ducy_wasm.js';
import { BANKROLL_BUY_INS, LEAVE_CHANCE, REGULARS_SEATS } from '../src/regulars.js';
import { LESSONS_KEPT } from '../src/ladder-review.js';

const RUNGS = ['a', 'b', 'c', 'd'];

test('the terms kept here are ducy-bot-games’', () => {
  assert.deepEqual(botGames({op: 'ladderRules'}), {
    order: ORDER, champion: CHAMPION, startBb: START_BB, winsToTake: 2, blinds: BLINDS, stakesEvery: STAKES_EVERY,
    bankrollBuyIns: BANKROLL_BUY_INS, leaveChance: LEAVE_CHANCE, regularsSeats: REGULARS_SEATS, lessonsKept: LESSONS_KEPT,
  });
});
// Chips in hundredths: 400 shows as 40000.
const K = 100;

// Plays games: true is a game won.
function series(p, games, rungs = RUNGS) {
  let out = null;
  for (const won of games) ({progress: p, outcome: out} = finishGame(startGame(p, rungs), rungs, won));
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

test('games are 200 BB deep, and every rung up doubles the stakes', () => {
  assert.equal(START_BB, 200);
  assert.deepEqual(BLINDS, [100, 200]);
  assert.deepEqual(blindsAt(0), [100, 200]);
  assert.deepEqual(blindsAt(1), [200, 400]);
  assert.deepEqual(blindsAt(3), [800, 1600]);
  assert.deepEqual([buyInAt(0), buyInAt(1), buyInAt(2)], [400 * K, 800 * K, 1600 * K]);
  assert.equal(tableChipsAt(1), 1600 * K);
  // The whole ladder stays well inside exact whole numbers.
  assert.ok(Number.isSafeInteger(tableChipsAt(ORDER.length + 1)));
});

test('you start with 800, and a sweep doubles it', () => {
  let p = newProgress();
  assert.equal(p.chips, START_CHIPS);
  assert.equal(START_CHIPS, 800 * K);
  assert.equal(opponentOf(p, RUNGS), 'a');
  assert.deepEqual(startGame(p, RUNGS).game.stacks, [400 * K, 400 * K]);
  let r = finishGame(startGame(p, RUNGS), RUNGS, true);
  assert.equal(r.outcome, 'game');
  assert.deepEqual([r.progress.wins, r.progress.losses, r.progress.playing, r.progress.chips], [1, 0, false, 1200 * K]);
  r = finishGame(startGame(r.progress, RUNGS), RUNGS, true);
  assert.equal(r.outcome, 'up');
  p = r.progress;
  assert.deepEqual([p.level, p.best, p.wins, p.losses, p.chips], [1, 1, 0, 0, 1600 * K]);
  assert.deepEqual(p.record.a, {won: 1, lost: 0});
  assert.equal(opponentOf(p, RUNGS), 'b');
  // The next rung's games are 800 each: two buy-ins.
  assert.deepEqual(startGame(p, RUNGS).game.stacks, [800 * K, 800 * K]);
});

test('a sweep leaves room to lose a game on the next rung', () => {
  let {p, out} = series(newProgress(), [true, true]);
  ({p, out} = series(p, [false]));
  assert.equal(out, 'game');
  assert.deepEqual([p.level, p.chips], [1, 800 * K]);
  ({p, out} = series(p, [true, true]));
  assert.equal(out, 'up');
  assert.deepEqual([p.level, p.chips], [2, 2400 * K]);
});

test('2–1 on the first rung: you must win the first game of the next', () => {
  let {p, out} = series(newProgress(), [true, false, true]);
  assert.equal(out, 'up');
  assert.deepEqual([p.level, p.chips], [1, 1200 * K]);
  // Losing the first game leaves 400: not enough for another game at 800.
  // The series is over, and you drop to the first rung, which you can pay for.
  const r = finishGame(startGame(p, RUNGS), RUNGS, false);
  ({progress: p, outcome: out} = r);
  assert.equal(out, 'down');
  assert.equal(r.short, true, 'lost for want of chips, not two games');
  assert.deepEqual([p.level, p.chips, p.wins, p.losses], [0, 400 * K, 0, 0]);
  assert.deepEqual(p.record.b, {won: 0, lost: 1});
});

test('losing drops you to the highest rung you can pay for', () => {
  // On rung 4 (buy-in 3,200) with 9,600: lose the series 0–2 and keep 3,200.
  let p = {...newProgress(), level: 3, best: 3, chips: 9600 * K};
  let out;
  ({p} = series(p, [false]));
  const r = finishGame(startGame(p, RUNGS), RUNGS, false);
  ({progress: p, outcome: out} = r);
  assert.equal(out, 'down');
  assert.equal(r.short, false);
  assert.deepEqual([p.level, p.chips], [2, 3200 * K], 'one rung down: you can pay for it');
  // With fewer chips you drop further: 900 pays for rung 2 (800), not rung 3.
  assert.equal(dropTo(3, 900 * K), 1);
  assert.equal(dropTo(3, 400 * K), 0);
  assert.equal(dropTo(3, 399 * K), -1);
  p = {...newProgress(), level: 3, chips: 4100 * K};
  ({p, out} = series(p, [false]));
  assert.equal(out, 'down');
  assert.deepEqual([p.level, p.chips], [1, 900 * K]);
});

test('with no buy-in left for any rung you start over at the bottom with 800', () => {
  let {p, out} = series(newProgress(), [false, false]);
  assert.equal(out, 'bust');
  assert.deepEqual([p.level, p.chips], [0, START_CHIPS]);
  assert.deepEqual(p.record.a, {won: 0, lost: 1});
  // Higher up, too.
  p = {...newProgress(), level: 2, best: 2, chips: 1600 * K};
  ({p, out} = series(p, [false]));
  assert.equal(out, 'bust');
  assert.deepEqual([p.level, p.chips, p.best], [0, START_CHIPS, 2]);
});

test('losing a series on the bottom rung with a buy-in left keeps you there', () => {
  // 800 → 400 → 800 → 400 after losing 1–2: one more buy-in.
  const {p, out} = series(newProgress(), [false, true, false]);
  assert.equal(out, 'stay');
  assert.deepEqual([p.level, p.chips], [0, 400 * K]);
});

test('beating the top bot makes you champion, and you stay up there', () => {
  let p = {...newProgress(), level: 3, best: 3, chips: 6400 * K};
  let out;
  ({p, out} = series(p, [true, true]));
  assert.equal(out, 'champion');
  assert.deepEqual([p.level, p.titles, p.chips], [3, 1, 12800 * K]);
  ({p, out} = series(p, [true, false, true]));
  assert.deepEqual([out, p.titles], ['champion', 2]);
});

test('a game left in the middle resumes with the same chips', () => {
  let p = {...newProgress(), level: 1, chips: 1600 * K};
  assert.equal(pausedGame(p), null);
  p = startGame(p, RUNGS);
  assert.deepEqual(p.game, {stacks: [800 * K, 800 * K], hands: 0, blinds: blindsAt(1), offerAt: STAKES_EVERY});
  // Twelve hands in, you have 1,065 behind (mid-hand: your bet in the pot is theirs).
  p = keepGame(p, 106500, 12);
  assert.deepEqual(pausedGame(p), {stacks: [106500, 160000 - 106500], hands: 12, blinds: blindsAt(1), offerAt: STAKES_EVERY});
  assert.equal(chipsNow(p), 1600 * K - 800 * K + 106500);
  // Coming back keeps the game, not a fresh one.
  assert.deepEqual(startGame(p, RUNGS).game, p.game);
  assert.equal(p.losses, 0, 'leaving isn’t losing');
  // Finishing the game clears it, and pays the bot's buy-in.
  const r = finishGame(p, RUNGS, true);
  assert.equal(r.progress.game, null);
  assert.equal(pausedGame(r.progress), null);
  assert.equal(r.progress.chips, 2400 * K);
});

test('a shorter ladder keeps you on it, at its top rung’s stakes', () => {
  const p = {...newProgress(), level: 9, chips: 6400 * K};
  assert.equal(opponentOf(p, RUNGS), 'd');
  assert.deepEqual(startGame(p, RUNGS).game.stacks, [buyInAt(3), buyInAt(3)]);
  const {progress} = finishGame(startGame(p, RUNGS), RUNGS, false);
  assert.equal(progress.losses, 1);
  assert.deepEqual([progress.level, progress.chips], [3, 3200 * K]);
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
  let p = startGame(newProgress(), RUNGS);
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
  assert.deepEqual(startGame({...p, playing: false}, RUNGS).game.blinds, [200, 400]);
});

test('no offer when someone can’t cover the doubled big blind', () => {
  const p = keepGame(startGame(newProgress(), RUNGS), 350, STAKES_EVERY);
  assert.equal(stakesOffer(p), null);
});

test('raising the blinds on a higher rung keeps its buy-in and bankroll', () => {
  let p = startGame({...newProgress(), level: 2, chips: 6400 * K}, RUNGS);
  p = keepGame(p, 1700 * K, STAKES_EVERY);
  assert.deepEqual(stakesOffer(p), [800, 1600]);
  p = answerStakes(p, true);
  p = keepGame(p, 1800 * K, STAKES_EVERY + 1);
  assert.deepEqual(gameBlinds(p), [800, 1600]);
  assert.equal(p.game.offerAt, 2 * STAKES_EVERY);
  assert.deepEqual(p.game.stacks, [1800 * K, 1400 * K]);
  assert.equal(chipsNow(p), 6600 * K);
  const store = new Map();
  const storage = {getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v)};
  saveProgress(p, storage);
  assert.deepEqual(startGame(loadProgress(storage), RUNGS).game, p.game);
  assert.equal(finishGame(p, RUNGS, true).progress.chips, 8000 * K);
  assert.equal(finishGame(p, RUNGS, false).progress.chips, 4800 * K);
  const next = startGame(finishGame(p, RUNGS, true).progress, RUNGS);
  assert.deepEqual(gameBlinds(next), blindsAt(2));
  assert.equal(next.game.offerAt, STAKES_EVERY);
});

test('a game kept before the stakes could rise goes on at 1/2', () => {
  const p = startGame({...newProgress(), playing: true, game: {stacks: [53000, 27000], hands: 40}}, RUNGS);
  assert.deepEqual(gameBlinds(p), BLINDS);
  assert.equal(p.game.offerAt, STAKES_EVERY);
});

test('games start 200 BB deep at 1/2', () => {
  assert.deepEqual(BLINDS, [100, 200]);
  assert.equal(START_BB, 200);
  assert.equal(tableChipsAt(0), 2 * 200 * BLINDS[1]);
});

test('progress from before chips carried over keeps its rung, with two buy-ins', () => {
  const store = new Map();
  const storage = {getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v)};
  // Rung 3, mid-series, a game paused at 1/2 with 530 of the 800 in play.
  const old = {v: 1, level: 2, best: 2, wins: 1, losses: 0, playing: true, titles: 0, record: {a: {won: 1, lost: 0}}, game: {stacks: [53000, 27000], hands: 12}};
  store.set('ducyLadder', JSON.stringify(old));
  const p = loadProgress(storage);
  assert.deepEqual([p.v, p.level, p.wins, p.chips], [2, 2, 1, 2 * buyInAt(2)]);
  assert.deepEqual(p.record, old.record);
  // The paused game goes on at rung 3's stakes (3,200 in play), the same share each.
  assert.deepEqual(pausedGame(p), {stacks: [212000, 108000], hands: 12});
  // A v1 save from 100 BB scales the same way.
  store.set('ducyLadder', JSON.stringify({...old, level: 0, game: {stacks: [26500, 13500], hands: 12}}));
  assert.deepEqual(pausedGame(loadProgress(storage)), {stacks: [53000, 27000], hands: 12});
  // Already-raised blinds scale with the rung; the offer schedule stays.
  store.set('ducyLadder', JSON.stringify({...old, game: {...old.game, blinds: [200, 400], hands: 120, offerAt: 200}}));
  const raised = loadProgress(storage);
  assert.deepEqual(raised.game, {stacks: [212000, 108000], blinds: [800, 1600], hands: 120, offerAt: 200});
  assert.deepEqual(startGame(raised, RUNGS).game, raised.game);
  assert.deepEqual(stakesOffer(keepGame(raised, 212000, 200)), [1600, 3200]);
});

test('which rungs show goes by the rung: re-ranked bots hide above you and show where you have been', () => {
  const shown = (p, rungs) => rungs.map((_, i) => rungShown(p, rungs, i));
  // On rung 2 (c), best rung 3 (d) before; you've played a, b, d and e.
  const p = {...newProgress(), level: 2, best: 3, record: {a: {won: 1, lost: 0}, b: {won: 1, lost: 0}, d: {won: 0, lost: 1}, e: {won: 0, lost: 1}}};
  assert.deepEqual(shown(p, ['a', 'b', 'c', 'd', 'e', 'f']), [true, true, true, true, false, false],
    'below you and up to your best; e, played once, is above anything you reached');
  // The bots are re-ranked: e moves down to rung 3, which you've reached, and
  // d moves up to rung 5, which you haven't.
  assert.deepEqual(shown(p, ['a', 'b', 'c', 'e', 'f', 'd']), [true, true, true, true, false, false],
    'e shows on a rung you reached, d hides on one you didn’t');
  // A new bot moved into a rung below you shows.
  assert.equal(rungShown(p, ['a', 'z', 'c', 'd'], 1), true);
  // Your own rung, never reached before: hidden until its series starts or
  // its bot is one you've played.
  const fresh = {...newProgress(), level: 1, best: 1, record: {a: {won: 1, lost: 0}}};
  assert.equal(rungShown(fresh, ['a', 'b', 'c'], 1), false);
  assert.equal(rungShown({...fresh, wins: 1}, ['a', 'b', 'c'], 1), true);
  assert.equal(rungShown(fresh, ['b', 'a', 'c'], 1), true, 'a, played before, moved to your rung');
  assert.equal(rungShown(fresh, ['a', 'b', 'c'], 2), false);
});
