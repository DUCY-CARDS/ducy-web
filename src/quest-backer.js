// Getting staked in the Bankroll Challenge (#356): a backer offers to stake
// you at bigger games, but only if you can prove you know your ranges. The
// proof is a test: hands from Ducybot's 6-max charts (chart-skills.js), every
// position, pick the action. Pass, and the stake is yours for a game week;
// then you pay it back with the backer's cut of your profit, smaller the
// better you scored.
//
// - **Training counts:** every 6-max spot you've mastered in Pre-flop ranges
//   lowers the mark you need, down to a floor.
// - **Reputation as a horse:** paying a backer what you owe raises it; owing
//   more than you can pay (stiffing them) lowers it a lot. A bad name means
//   fewer offers and a higher mark.
// - **A failed test:** no backer comes back for a few game days.
//
// The offers, marks, cuts and settling live in ducy-quest (Rust, #466);
// the test's hands are drawn and scored here, from the chart files play.js
// loads.

import { quest as op } from '../wasm/ducy_wasm.js';
import { roll } from './quest-rooms.js';
import { CHART_TRACKS, DEFAULT_BB, chartFile, trainingActions, handMix, fixedAnswers, pickCell, cardsFor, spotQuestion, spotName } from './chart-skills.js';

/** An offer that waits until it's answered. */
export const NEVER = 1e12;

// ducy-quest's terms (a test checks the page's copy).
export const BACKER = {
  ask: 0.12, minSessions: 3, buyIns: 10, cutAtPass: 0.5, cutAtPerfect: 0.3, cutStep: 0.05, days: 7, offerHours: 24,
  hands: 15, mark: 80, perMastered: 2, floor: 66, badName: 5, cooldownDays: 3,
};

// The spots the test draws from: the 6-max track's spots, at the trainer's
// default depth. A lesson still to come (`soon`) has none yet; new 6-max
// lessons join the test as they go on the track. (Reads a flat `ids` track too.)
const sixMax = CHART_TRACKS.find(t => t.table === '6max');
export const TEST_SPOTS = [{
  file: chartFile('6max', DEFAULT_BB), hu: false,
  ids: sixMax.lessons ? sixMax.lessons.filter(l => !l.soon).flatMap(l => l.ids) : sixMax.ids,
}];

/** Your reputation as a horse (0 to start, up when you pay, down when you stiff). */
export const horseRep = q => q.rep?.horse ?? 0;

/** The mark (% right) you need on the test, given `mastered` Ducybot spots in the trainer and your name as a horse. */
export const passMark = (q, mastered) => op({op: 'passMark', q, mastered});
/** The backer's cut after a passing score: the offer's cut at the mark, down to cutAtPerfect at 100%, in steps of 5%. */
export const cutFor = (pct, mark, offerCut = BACKER.cutAtPass) => op({op: 'cutFor', pct, mark, offerCut});
/** The stakes one step up from `stakes` (or the top). */
export const stakesUp = stakes => op({op: 'stakesUp', stakes});
/** Maybe a backer gets in touch as you leave a table at `stakes`. */
export const maybeBackerOffer = (q, stakes, minutes, n = 0) => (op({op: 'maybeBackerOffer', q, stakes, minutes, n}) ?? q);

/**
 * A test for a backer's offer: `charts` maps a chart file name to its data.
 * Returns {hands: [{file, id, cell, cards}], answers: []}, seeded by the
 * offer so it's the same if you come back to it.
 */
export function makeTest(q, charts, msgId, rand = seeded(q.seed, msgId)) {
  const pool = TEST_SPOTS.flatMap(t => t.ids.map(id => ({file: t.file, hu: t.hu, spot: charts[t.file]?.spots?.find(s => s.id === id)}))).filter(x => x.spot);
  if (!pool.length) return null;
  // Every position twice (as far as the hands go), the rest at random, shuffled.
  const order = [];
  for (let r = 0; r < 2; r++) for (let i = 0; i < pool.length && order.length < BACKER.hands; i++) order.push(i);
  while (order.length < BACKER.hands) order.push(Math.floor(rand() * pool.length));
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const hands = [];
  for (const i of order) {
    const pick = pool[i];
    // Real decisions: not the obvious hands, mostly from the middle of the
    // range, and never a hand so mixed that every action counts as right.
    const ta = trainingActions(pick.spot);
    let cell;
    for (let tries = 0; tries < 30; tries++) {
      cell = pickCell(pick.spot, {band: [0.1, 1.01], rand, ta});
      if (fixedAnswers(handMix(pick.spot, cell, ta)).length < ta.actions.length) break;
    }
    hands.push({file: pick.file, hu: pick.hu, id: pick.spot.id, cell, cards: cardsFor(cell, rand)});
  }
  return {msgId, hands, answers: []};
}

// A seeded random source from the quest and a key.
function seeded(seed, key) {
  let n = 0;
  return () => roll(seed, 'backer-test', key, n++);
}

/** The spot behind a test hand. */
const spotOf = (charts, h) => charts[h.file]?.spots?.find(s => s.id === h.id);

/** What a test hand shows: {question, title, actions: [verb], cards}. */
export function testHand(charts, h) {
  const spot = spotOf(charts, h);
  const ta = trainingActions(spot);
  return {question: spotQuestion(spot, h.hu), title: `${h.hu ? 'Heads-up' : '6-max'} · ${spotName(spot)}`, actions: ta.actions.map(x => x.verb), cards: h.cards};
}

/** Answers the current test hand with action `k`. Returns the test. */
export function answerTest(test, k) {
  if (!test || test.answers.length >= test.hands.length) return test;
  return {...test, answers: [...test.answers, k]};
}

/** The test's score: {right, of, pct, misses: [{hand, k, mix, verbs}]}. */
export function scoreTest(charts, test) {
  let right = 0;
  const misses = [];
  test.answers.forEach((k, i) => {
    const h = test.hands[i];
    const spot = spotOf(charts, h);
    const ta = trainingActions(spot);
    const mix = handMix(spot, h.cell, ta);
    if (fixedAnswers(mix).includes(k)) right++;
    else misses.push({hand: h, k, mix, verbs: ta.actions.map(x => x.verb)});
  });
  return {right, of: test.answers.length, pct: test.answers.length ? Math.round((100 * right) / test.answers.length) : 0, misses};
}

/** The test finished: pass and the stake comes in; fail and the backer walks, with a cooldown. `mastered` your trainer spots mastered. */
export function finishTest(q, charts, test, mastered, minutes) {
  const {right, of, pct} = scoreTest(charts, test);
  return (op({op: 'finishTest', q, msgId: test.msgId, score: {right, of, pct}, mastered, minutes}) ?? q);
}

/** What you owe a backer now: {net, owed}. */
export const owedToBacker = q => op({op: 'owedToBacker', q});
/** The week's up (and you're not at a table): the backer asks for their money. Once only. */
export const settleBacking = (q, minutes) => (op({op: 'settleBacking', q, minutes}) ?? q);
/** Settles with the backer: 'pay' or 'stiff'. */
export const answerSettle = (q, msgId, answer, minutes) => (op({op: 'answerSettle', q, msgId, answer, minutes}) ?? q);
