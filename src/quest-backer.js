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
// Pure and seeded (roll): play.js loads the chart files and keeps the quest.

import { roll } from './quest-rooms.js';
import { post, book } from './quest-scenarios.js';
import { CHART_TRACKS, DEFAULT_BB, chartFile, trainingActions, handMix, fixedAnswers, pickCell, cardsFor, spotQuestion, spotName } from './chart-skills.js';

const DAY = 1440;
/** An offer that waits until it's answered. */
export const NEVER = 1e12;

export const BACKER = {
  // Chance a backer gets in touch as you leave a table, once you've played a few sessions.
  ask: 0.12,
  minSessions: 3,
  // The stake: this many buy-ins (100 BB) at the next stakes up from where you played.
  buyIns: 10,
  // The backer's cut of the profit: this at the pass mark, down to cutAtPerfect
  // for a perfect score, in steps of cutStep.
  cutAtPass: 0.5,
  cutAtPerfect: 0.3,
  cutStep: 0.05,
  days: 7,
  offerHours: 24,
  // The test: this many hands; the mark to pass, lowered per mastered trainer spot.
  hands: 15,
  mark: 80,
  perMastered: 2,
  floor: 66,
  // A bad name raises the mark this much per point below zero, and cuts the chance of an offer.
  badName: 5,
  // No backer for this long after a failed test.
  cooldownDays: 3,
};

// The ladder of stakes the backer moves you up, [sb, bb] in cents.
const LADDER = [[100, 200], [200, 500], [500, 1000], [1000, 2000], [2500, 5000], [5000, 10000]];
const label = s => `${s[0] / 100}/${s[1] / 100}`;
const dollars = n => (n / 100).toLocaleString('en-US', {maximumFractionDigits: 0});

// The spots the test draws from: the 6-max track's spots, at the trainer's
// default depth. A lesson still to come (`soon`) has none yet; new 6-max
// lessons join the test as they go on the track. (Reads a flat `ids` track too.)
const sixMax = CHART_TRACKS.find(t => t.table === '6max');
export const TEST_SPOTS = [{
  file: chartFile('6max', DEFAULT_BB), hu: false,
  ids: sixMax.lessons ? sixMax.lessons.filter(l => !l.soon).flatMap(l => l.ids) : sixMax.ids,
}];

const BACKERS = ['Dmitri', 'Lena', 'Marcus', 'Priya', 'Owen', 'Sofia', 'Kenji', 'Rosa'];

/** Your reputation as a horse (0 to start, up when you pay, down when you stiff). */
export const horseRep = q => q.rep?.horse ?? 0;

/**
 * The mark (% right) you need on the test, given `mastered` Ducybot spots in
 * the trainer and your name as a horse.
 */
export function passMark(q, mastered) {
  const rep = horseRep(q);
  const base = Math.max(BACKER.floor, BACKER.mark - BACKER.perMastered * mastered);
  return Math.min(95, base + (rep < 0 ? -rep * BACKER.badName : 0));
}

/**
 * The backer's cut after a passing score: the offer's cut at the mark, down
 * to cutAtPerfect at 100%, in whole steps of 5%. Below the mark, the offer's cut.
 */
export function cutFor(pct, mark, offerCut = BACKER.cutAtPass) {
  if (pct < mark) return offerCut;
  const t = mark >= 100 ? 1 : (pct - mark) / (100 - mark);
  const cut = offerCut - t * Math.max(0, offerCut - BACKER.cutAtPerfect);
  return Math.round(Math.round(cut / BACKER.cutStep) * BACKER.cutStep * 100) / 100;
}

/** The stakes one step up from `stakes` (or the top). */
export function stakesUp(stakes) {
  const i = LADDER.findIndex(s => s[1] === stakes[1]);
  return LADDER[Math.min(LADDER.length - 1, (i < 0 ? 0 : i) + 1)];
}

/**
 * Maybe a backer gets in touch as you leave a table at `stakes`. Not while
 * you're already backed, during a cooldown, or before minSessions; less often
 * with a bad name. `n` makes each chance its own. Returns the quest.
 */
export function maybeBackerOffer(q, stakes, minutes, n = 0) {
  if (q.backing || (q.backerCooldown || 0) > minutes || (q.history || []).length < BACKER.minSessions) return q;
  if ((q.inbox || []).some(m => m.offer?.kind === 'backer' && !m.offer.answered && m.offer.expires > minutes)) return q;
  const rep = horseRep(q);
  const chance = BACKER.ask * (rep < 0 ? Math.max(0.2, 1 + rep * 0.3) : 1 + 0.15 * Math.min(rep, 4));
  if (roll(q.seed, 'backer', Math.floor(minutes), n) >= chance) return q;
  const up = stakesUp(stakes);
  const amount = BACKER.buyIns * 100 * up[1];
  const name = BACKERS[Math.floor(roll(q.seed, 'backer-name', Math.floor(minutes), n) * BACKERS.length)];
  const offer = {kind: 'backer', name, stakes: up, amount, share: BACKER.cutAtPass, expires: minutes + BACKER.offerHours * 60};
  const pc = x => `${Math.round(x * 100)}%`;
  const text = `${name}, a backer, has been watching you play: “I’ll stake you $${dollars(amount)} to play ${label(up)} for a week, for a cut of the profit. First, show me you know your 6-max ranges. The better you score, the smaller my cut: ${pc(offer.share)} at the pass mark, down to ${pc(BACKER.cutAtPerfect)}.”`;
  return post(q, {kind: 'backer-offer', at: minutes, text, offer});
}

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

/**
 * The test finished: pass and the stake comes in; fail and the backer
 * walks, with a cooldown. `mastered` your trainer spots mastered. Returns the quest.
 */
export function finishTest(q, charts, test, mastered, minutes) {
  const msg = (q.inbox || []).find(m => m.id === test.msgId);
  const o = msg?.offer;
  if (!o || o.answered) return q;
  const s = scoreTest(charts, test);
  const mark = passMark(q, mastered);
  q = {...q, inbox: q.inbox.map(m => (m.id === msg.id ? {...m, read: true, offer: {...m.offer, answered: s.pct >= mark ? 'passed' : 'failed'}} : m))};
  if (s.pct < mark) {
    q = {...q, backerCooldown: minutes + BACKER.cooldownDays * DAY};
    return post(q, {kind: 'backer-news', at: minutes, text: `${o.name} watched you get ${s.right} of ${s.of} (${s.pct}%), short of the ${mark}% they wanted. “Study up and I’ll think about it.”`});
  }
  const share = cutFor(s.pct, mark, o.share);
  const backing = {name: o.name, amount: o.amount, share, stakes: o.stakes, start: minutes, end: minutes + BACKER.days * DAY, base: q.bankroll};
  q = {...q, bankroll: q.bankroll + o.amount, backing};
  q = book(q, {at: minutes, kind: 'backed', amount: o.amount, name: o.name});
  return post(q, {kind: 'backer-news', at: minutes, text: `You scored ${s.pct}% (${s.right} of ${s.of}): ${o.name} will take ${Math.round(share * 100)}% of the profit. They’re staking you $${dollars(o.amount)} to play ${label(o.stakes)}; in a week you pay it back, with their cut.`});
}

/** What you owe a backer now: {net, owed} — their stake and their share of a profit, or what's left of it after a loss. */
export function owedToBacker(q) {
  const b = q.backing;
  if (!b) return {net: 0, owed: 0};
  const net = q.bankroll - b.base - b.amount;
  return {net, owed: net > 0 ? b.amount + Math.round(net * b.share) : Math.max(0, b.amount + net)};
}

/**
 * The week's up (and you're not at a table): the backer asks for their
 * money, an offer in the inbox to pay or to skip out on. Once only. Returns the quest.
 */
export function settleBacking(q, minutes) {
  const b = q.backing;
  if (!b || b.due || q.seat || minutes < b.end) return q;
  const {net, owed} = owedToBacker(q);
  q = {...q, backing: {...b, due: true}};
  const how = net > 0 ? `You made $${dollars(net)} on their money: they want their $${dollars(b.amount)} back and ${Math.round(b.share * 100)}% of the profit, $${dollars(owed)} in all.`
    : owed ? `It went badly: $${dollars(owed)} is left of their $${dollars(b.amount)}.` : `Their $${dollars(b.amount)} is all gone.`;
  // It waits until answered (a far-off expiry: JSON can't keep Infinity).
  return post(q, {kind: 'backer-settle', at: minutes, text: `${b.name}’s week is up. ${how}`, offer: {kind: 'backer-settle', name: b.name, owed, net, expires: NEVER}});
}

/**
 * Settles with the backer: 'pay' (what you owe, and your name grows if they
 * made money, shrinks a little if you lost most of theirs) or 'stiff' (keep
 * it, and backers will hear about it). Returns the quest.
 */
export function answerSettle(q, msgId, answer, minutes) {
  const msg = (q.inbox || []).find(m => m.id === msgId);
  const b = q.backing;
  if (!msg?.offer || msg.offer.kind !== 'backer-settle' || msg.offer.answered || !b) return q;
  const {net, owed} = owedToBacker(q);
  const pay = answer === 'pay' ? Math.min(owed, q.bankroll) : 0;
  const change = answer === 'pay' ? (net > 0 ? 1 : net < -b.amount / 2 ? -1 : 0) : -3;
  q = {...q, bankroll: q.bankroll - pay, backing: null, rep: {...(q.rep || {}), horse: horseRep(q) + change},
    inbox: q.inbox.map(m => (m.id === msgId ? {...m, read: true, offer: {...m.offer, answered: answer}} : m))};
  q = book(q, {at: minutes, kind: 'backer-paid', amount: -pay, name: b.name, stiffed: answer !== 'pay'});
  const text = answer !== 'pay' ? `You kept ${b.name}’s money. Word gets around: backers will be warier of you.`
    : net > 0 ? `You paid ${b.name} $${dollars(pay)}. They’d back you again.`
      : pay ? `You handed ${b.name} back the $${dollars(pay)} left. ${change < 0 ? 'Losing most of their money hurts your name a little.' : 'Bad weeks happen.'}`
        : `You told ${b.name} it’s all gone. ${change < 0 ? 'Losing their money hurts your name a little.' : ''}`;
  return post(q, {kind: 'backer-news', at: minutes, text: text.trim()});
}
