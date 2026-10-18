// Getting staked (#356): a backer's offer, the ranges test, the stake and settling it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newQuest } from '../src/quest.js';
import { handMix, fixedAnswers, trainingActions } from '../src/chart-skills.js';
import {
  BACKER, TEST_SPOTS, passMark, stakesUp, maybeBackerOffer, makeTest, testHand, answerTest, scoreTest, finishTest, settleBacking, answerSettle, horseRep,
} from '../src/quest-backer.js';

const DAY = 1440, T0 = 4 * DAY + 20 * 60;
const charts = Object.fromEntries(TEST_SPOTS.map(t => [t.file, JSON.parse(readFileSync(new URL(`../charts/${t.file}`, import.meta.url), 'utf8'))]));
const played = n => Array.from({length: n}, () => ({net: 0}));
const quest = (extra = {}) => ({...newQuest(0, 5), bankroll: 300000, history: played(5), ...extra});

// A quest with a backer's offer in the inbox.
function offered(q = quest()) {
  for (let n = 0; ; n++) {
    const out = maybeBackerOffer(q, [100, 200], T0, n);
    if (out !== q) return out;
  }
}
// Answers every hand of a test right (the hand's main action), or wrong.
function take(test, right) {
  let t = test;
  for (const h of test.hands) {
    const spot = charts[h.file].spots.find(s => s.id === h.id);
    const mix = handMix(spot, h.cell, trainingActions(spot));
    const ok = fixedAnswers(mix);
    const k = right ? ok[0] : mix.findIndex((_, i) => !ok.includes(i));
    t = answerTest(t, k < 0 ? 0 : k);
  }
  return t;
}

test('the pass mark drops with training and rises with a bad name', () => {
  assert.equal(passMark(quest(), 0), BACKER.mark);
  assert.equal(passMark(quest(), 3), BACKER.mark - 3 * BACKER.perMastered);
  assert.equal(passMark(quest(), 100), BACKER.floor);
  assert.equal(passMark(quest({rep: {horse: -3}}), 0), BACKER.mark + 15);
  assert.deepEqual(stakesUp([100, 200]), [200, 500]);
  assert.deepEqual(stakesUp([5000, 10000]), [5000, 10000]);
});

test('a backer gets in touch only after a few sessions, not while backed or cooling off', () => {
  let offers = 0;
  for (let n = 0; n < 300; n++) if (maybeBackerOffer(quest(), [100, 200], T0, n).inbox) offers++;
  assert.ok(offers > 15 && offers < 80, `${offers} in 300`);
  const q = offered();
  const o = q.inbox[0].offer;
  assert.equal(o.kind, 'backer');
  assert.deepEqual(o.stakes, [200, 500]);
  assert.equal(o.amount, BACKER.buyIns * 100 * 500);
  assert.match(q.inbox[0].text, /show me you know your ranges/);
  for (let n = 0; n < 100; n++) {
    assert.equal(maybeBackerOffer(quest({history: played(1)}), [100, 200], T0, n).inbox, undefined);
    assert.equal(maybeBackerOffer(quest({backing: {end: T0 + DAY}}), [100, 200], T0, n).inbox, undefined);
    assert.equal(maybeBackerOffer(quest({backerCooldown: T0 + DAY}), [100, 200], T0, n).inbox, undefined);
  }
  // A bad name means fewer offers.
  let bad = 0;
  for (let n = 0; n < 300; n++) if (maybeBackerOffer(quest({rep: {horse: -3}}), [100, 200], T0, n).inbox) bad++;
  assert.ok(bad < offers, `bad name ${bad}, clean ${offers}`);
});

test('the test: random spots and positions, real decisions, the same for the same offer', () => {
  const q = offered();
  const t = makeTest(q, charts, q.inbox[0].id);
  assert.equal(t.hands.length, BACKER.hands);
  assert.ok(new Set(t.hands.map(h => h.id)).size >= 4, 'a mix of spots');
  assert.deepEqual(makeTest(q, charts, q.inbox[0].id), t);
  const shown = testHand(charts, t.hands[0]);
  assert.ok(shown.question && shown.title && shown.actions.length >= 2 && shown.cards.length === 2);
  assert.equal(scoreTest(charts, take(t, true)).pct, 100);
  const wrong = scoreTest(charts, take(t, false));
  assert.equal(wrong.right, 0);
  assert.equal(wrong.misses.length, BACKER.hands);
});

test('pass and the stake comes in; fail and the backer walks for a few days', () => {
  const q = offered();
  const t = makeTest(q, charts, q.inbox[0].id);
  const passed = finishTest(q, charts, take(t, true), 0, T0 + 60);
  assert.equal(passed.bankroll, q.bankroll + q.inbox[0].offer.amount);
  assert.equal(passed.backing.amount, q.inbox[0].offer.amount);
  assert.match(passed.inbox[0].text, /is staking you/);
  // Finished once only.
  assert.equal(finishTest(passed, charts, take(t, true), 0, T0 + 90), passed);
  const failed = finishTest(q, charts, take(t, false), 0, T0 + 60);
  assert.equal(failed.bankroll, q.bankroll);
  assert.ok(!failed.backing);
  assert.equal(failed.backerCooldown, T0 + 60 + BACKER.cooldownDays * DAY);
  assert.match(failed.inbox[0].text, /short of the 80%/);
});

test('settling: the backer asks; pay their stake and share, or what\'s left; or stiff them and pay with your name', () => {
  const backed = finishTest(offered(), charts, take(makeTest(offered(), charts, offered().inbox[0].id), true), 0, T0);
  const b = backed.backing;
  assert.equal(settleBacking(backed, b.end - 1), backed, 'not before the week is up');
  const seated = {...backed, seat: {}};
  assert.equal(settleBacking(seated, b.end + 1), seated, 'not while at a table');
  const due = (bankroll) => { const q = settleBacking({...backed, bankroll}, b.end); return {q, msg: q.inbox[0]}; };
  // Won $2,000 on top: the stake back plus half the profit; your name grows.
  const w = due(backed.bankroll + 200000);
  assert.equal(w.msg.offer.owed, b.amount + 100000);
  assert.equal(settleBacking(w.q, b.end + 10), w.q, 'asked once');
  const won = answerSettle(w.q, w.msg.id, 'pay', b.end + 5);
  assert.equal(won.bankroll, backed.bankroll + 200000 - b.amount - 100000);
  assert.equal(horseRep(won), 1);
  assert.equal(won.backing, null);
  // Lost most of their money: hand back what's left; your name shrinks a little.
  const l = due(backed.bankroll - Math.round(b.amount * 0.8));
  const lost = answerSettle(l.q, l.msg.id, 'pay', b.end + 5);
  assert.equal(lost.bankroll, backed.bankroll - Math.round(b.amount * 0.8) - Math.round(b.amount * 0.2));
  assert.equal(horseRep(lost), -1);
  // Stiffed: keep it all, and backers hear about it (a higher mark, fewer offers).
  const s = due(backed.bankroll + 200000);
  const stiffed = answerSettle(s.q, s.msg.id, 'stiff', b.end + 5);
  assert.equal(stiffed.bankroll, backed.bankroll + 200000);
  assert.equal(horseRep(stiffed), -3);
  assert.ok(passMark(stiffed, 0) > passMark(won, 0));
  assert.match(stiffed.inbox[0].text, /warier/);
});
