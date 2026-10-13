import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OVERVIEW_GAMES, TOP_TARGETS, gameSkills, overviewHtml } from '../src/ranges-overview.js';

const progress = {
  'holdem:10': {score: 95, best: 95, answered: 50},   // mastered
  'holdem:20': {score: 88, best: 91, answered: 60},   // mastered once, a little below now
  'holdem:30': {score: 74, best: 80, answered: 30},   // started
  'omaha:4:15': {score: 90, best: 90, answered: 40},  // mastered at exactly 90
};

test('each game scores the share of its skills mastered (90 or more)', () => {
  const h = gameSkills(progress, 2);
  assert.equal(h.total, TOP_TARGETS.length);
  assert.equal(h.mastered, 2);
  assert.equal(h.score, Math.round(200 / 7));
  assert.equal(h.skills.find(s => s.pct === 30).status, 'started');
  assert.equal(gameSkills(progress, 4).mastered, 1);
  assert.equal(gameSkills(progress, 6).mastered, 0);
});

test('the overview has a tile per game, and the open game\'s skills as spades', () => {
  const h = overviewHtml(progress, 2);
  assert.match(h, /Pre-flop ranges/);
  assert.equal((h.match(/data-ovgame=/g) || []).length, OVERVIEW_GAMES.length);
  assert.equal((h.match(/data-skill="2:/g) || []).length, TOP_TARGETS.length);
  assert.equal((h.match(/class="v3-spade won"/g) || []).length, 2);
  assert.match(h, /90\+ earns a spade/);
  // Hold'em also lists its charts by position.
  assert.match(h, /Opening/);
  assert.match(h, /data-ovchoice="preset:open-btn"/);
});

test('an Omaha game shows its own skills, without the Hold\'em charts', () => {
  const h = overviewHtml(progress, 4);
  assert.equal((h.match(/data-skill="4:/g) || []).length, TOP_TARGETS.length);
  assert.doesNotMatch(h, /data-ovchoice/);
  assert.match(h, /Omaha 4 skills/);
});
