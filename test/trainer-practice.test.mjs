// The range trainer's practice (#464): what the page keeps is ducy-training's,
// and a session deals, scores and finds a lean.
// Run with: node --test test/trainer-practice.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { training } from '../wasm/ducy_wasm.js';
import { LEVELS } from '../src/trainer.js';
import { HOLDEM_PERCENTILE } from '../src/holdem-rank.js';
import { HOLDEM_TAG_LABELS } from '../src/holdem-tags.js';
import { MASTERY } from '../src/trainer-skills.js';

test('the levels, ranking and labels kept here are ducy-training’s', () => {
  const r = training({op: 'practiceRules'});
  assert.deepEqual(r.levels, LEVELS);
  assert.deepEqual(r.holdemPercentile, HOLDEM_PERCENTILE);
  assert.deepEqual(r.holdemLabels, HOLDEM_TAG_LABELS);
  assert.equal(r.mastery, MASTERY);
});

test('practice deals in the level’s band, scores answers and calls out a lean', () => {
  let pr = {cards: 2, pct: 20, score: 0, best: 0, total: 0, answered: 0, correct: 0, streak: 0, history: [], tagStats: {}, feedback: null, delta: 0, mastered: false, key: 'kept'};
  for (let seed = 1; seed <= 40; seed++) {
    pr = {...pr, feedback: null, current: training({op: 'practiceNext', pr, seed})};
    const c = pr.current;
    assert.equal(c.pct, training({op: 'topPercentile', cards: c.cards}));
    // Play everything: too loose.
    pr = training({op: 'practiceAnswer', pr, yes: true});
    assert.equal(pr.key, 'kept', 'the page’s own fields come back');
    const last = pr.history.at(-1);
    assert.equal(last.correct, c.pct < 20);
    if (!last.correct) assert.ok(pr.feedback && pr.feedback.yes);
    // Nothing to answer while feedback shows.
    if (pr.feedback) assert.equal(training({op: 'practiceAnswer', pr, yes: true}), null);
  }
  assert.equal(pr.answered, 40);
  const d = training({op: 'diagnosis', pr});
  assert.equal(d.kind, 'loose');
  assert.match(d.text.headline, /^You’re playing too many hands: you played \d+ of \d+ hands outside your top 20%\.$/);
});

test('drill kinds have decisions on both sides; weakest kinds come first', () => {
  const tags = training({op: 'drillTags', cards: 2, pct: 20, seed: 1});
  assert.ok(tags.includes('broadway_offsuit') && !tags.includes('ace_suited'), tags.join());
  const rec = {kinds: {pairs_mid: {recent: '1111111100'}, broadway_offsuit: {recent: '10101010'}, weak_suited: {recent: '11'}}};
  assert.deepEqual(training({op: 'weakestKinds', rec, tags: ['pairs_mid', 'broadway_offsuit', 'weak_suited']}).map(w => w.tag), ['broadway_offsuit', 'pairs_mid']);
  const ex = training({op: 'topExamples', cards: 4, pct: 20, seed: 5});
  assert.ok(ex.inside.every(x => x.pct < 20 && x.pct >= 17) && ex.outside.every(x => x.pct >= 20 && x.pct < 23));
});
